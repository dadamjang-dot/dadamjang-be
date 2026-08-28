import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { MediaErrorMessage } from "./media.error";
import {
  STYLE_POST_MAX_FILE_SIZE,
  STYLE_POST_IMAGE_EXTENSIONS,
  STYLE_POST_IMAGE_KEY_PATTERN,
  STYLE_POST_SUPPORTED_CONTENT_TYPES,
  SUPPORTED_CONTENT_TYPES,
  PRODUCT_IMAGE_KEY_PATTERN,
  PRODUCT_IMAGE_MAX_FILE_SIZE,
} from "./media.constant";
import type {
  CreateProductImageUploadInput,
  CreateStylePostImageUploadInput,
  ProductImageUploadTarget,
} from "./media.types";

const imageTransformBaseUrl = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CLOUDFLARE_IMAGES_TRANSFORM_BASE_URL must be a valid HTTPS URL ending in /cdn-cgi/image");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  if (url.protocol !== "https:" || !pathname.endsWith("/cdn-cgi/image") || url.search || url.hash)
    throw new Error("CLOUDFLARE_IMAGES_TRANSFORM_BASE_URL must be a valid HTTPS URL ending in /cdn-cgi/image");
  url.pathname = pathname;
  return url.toString();
};

@Injectable()
export class MediaService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly imageTransformBaseUrl: string;

  constructor(configService: ConfigService) {
    this.bucket = configService.getOrThrow<string>("CLOUDFLARE_R2_BUCKET");
    this.publicBaseUrl = configService.getOrThrow<string>("CLOUDFLARE_R2_PUBLIC_BASE_URL").replace(/\/$/, "");
    this.imageTransformBaseUrl = imageTransformBaseUrl(
      configService.getOrThrow<string>("CLOUDFLARE_IMAGES_TRANSFORM_BASE_URL"),
    );
    this.client = new S3Client({
      region: "auto",
      endpoint: configService.getOrThrow<string>("CLOUDFLARE_R2_ENDPOINT"),
      credentials: {
        accessKeyId: configService.getOrThrow<string>("CLOUDFLARE_R2_ACCESS_KEY_ID"),
        secretAccessKey: configService.getOrThrow<string>("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
      },
    });
  }

  createProductUpload = async (
    userId: string,
    input: CreateProductImageUploadInput,
  ): Promise<ProductImageUploadTarget> => {
    const contentType = input.contentType.toLowerCase();
    if (!SUPPORTED_CONTENT_TYPES.has(contentType)) {
      throw new CustomBadRequestException(MediaErrorMessage.UnsupportedType);
    }
    if (!Number.isInteger(input.fileSize) || input.fileSize <= 0)
      throw new CustomBadRequestException(MediaErrorMessage.InvalidFileSize);
    if (input.fileSize > PRODUCT_IMAGE_MAX_FILE_SIZE)
      throw new CustomBadRequestException(MediaErrorMessage.FileTooLarge);
    const extension = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1];
    const key = `products/${userId}/${randomUUID()}.${extension}`;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: input.fileSize }),
      { expiresIn: 10 * 60 },
    );
    const originalUrl = this.originalUrl(key);

    return { key, uploadUrl, originalUrl, imageUrl: this.transformedUrl(key) };
  };

  createStylePostUpload = async (
    userId: string,
    input: CreateStylePostImageUploadInput,
  ): Promise<ProductImageUploadTarget> => {
    if (!STYLE_POST_SUPPORTED_CONTENT_TYPES.has(input.contentType.toLowerCase())) {
      throw new CustomBadRequestException(MediaErrorMessage.UnsupportedType);
    }
    if (!Number.isInteger(input.fileSize) || input.fileSize <= 0) {
      throw new CustomBadRequestException(MediaErrorMessage.InvalidFileSize);
    }
    if (input.fileSize > STYLE_POST_MAX_FILE_SIZE) {
      throw new CustomBadRequestException(MediaErrorMessage.FileTooLarge);
    }

    const extension = STYLE_POST_IMAGE_EXTENSIONS[input.contentType.toLowerCase()];
    const key = `style-posts/${userId}/${randomUUID()}.${extension}`;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: input.contentType.toLowerCase(),
        ContentLength: input.fileSize,
      }),
      { expiresIn: 10 * 60 },
    );
    const originalUrl = this.originalUrl(key);

    return { key, uploadUrl, originalUrl, imageUrl: this.transformedUrl(key) };
  };

  getProductImageUrl = async (key: string, width?: number): Promise<string> => {
    if (!key.startsWith("products/")) throw new CustomBadRequestException(MediaErrorMessage.InvalidKey);
    return this.transformedUrl(key, width);
  };

  isProductImageKeyForUser = (key: string, userId: string) =>
    key.startsWith(`products/${userId}/`) && PRODUCT_IMAGE_KEY_PATTERN.test(key);

  validateProductImageObject = async (key: string, userId: string) => {
    if (!this.isProductImageKeyForUser(key, userId)) throw new CustomBadRequestException(MediaErrorMessage.InvalidKey);
    try {
      const object = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      if (
        !object.ContentType ||
        !SUPPORTED_CONTENT_TYPES.has(object.ContentType.toLowerCase()) ||
        !Number.isInteger(object.ContentLength) ||
        object.ContentLength === undefined ||
        object.ContentLength < 1 ||
        object.ContentLength > PRODUCT_IMAGE_MAX_FILE_SIZE
      )
        throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
    } catch (error) {
      if (error instanceof CustomBadRequestException) throw error;
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
      throw error;
    }
  };

  getStylePostImageUrl = (key: string, width?: number) => {
    if (!STYLE_POST_IMAGE_KEY_PATTERN.test(key)) throw new CustomBadRequestException(MediaErrorMessage.InvalidKey);
    return this.transformedUrl(key, width);
  };

  isStylePostImageKeyForUser = (key: string, userId: string) =>
    key.startsWith(`style-posts/${userId}/`) && STYLE_POST_IMAGE_KEY_PATTERN.test(key);

  private originalUrl = (key: string) => `${this.publicBaseUrl}/${key}`;

  private transformedUrl = (key: string, width?: number) => {
    const options = [`format=auto`, width ? `width=${width}` : "fit=scale-down"];
    return `${this.imageTransformBaseUrl}/${options.join(",")}/${this.originalUrl(key)}`;
  };
}
