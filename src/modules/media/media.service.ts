import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { MediaErrorMessage } from "./media.error";
import type { CreateProductImageUploadInput, ProductImageUploadTarget } from "./media.types";

const supportedContentTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

@Injectable()
export class MediaService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly imageTransformBaseUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.bucket = configService.getOrThrow<string>("CLOUDFLARE_R2_BUCKET");
    this.publicBaseUrl = configService.getOrThrow<string>("CLOUDFLARE_R2_PUBLIC_BASE_URL").replace(/\/$/, "");
    this.imageTransformBaseUrl = configService
      .getOrThrow<string>("CLOUDFLARE_IMAGES_TRANSFORM_BASE_URL")
      .replace(/\/$/, "");
    this.client = new S3Client({
      region: "auto",
      endpoint: configService.getOrThrow<string>("CLOUDFLARE_R2_ENDPOINT"),
      credentials: {
        accessKeyId: configService.getOrThrow<string>("CLOUDFLARE_R2_ACCESS_KEY_ID"),
        secretAccessKey: configService.getOrThrow<string>("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
      },
    });
  }

  createProductUpload = async (input: CreateProductImageUploadInput): Promise<ProductImageUploadTarget> => {
    if (!supportedContentTypes.has(input.contentType)) {
      throw new CustomBadRequestException(MediaErrorMessage.UnsupportedType);
    }

    const extension = input.filename.split(".").pop()?.toLowerCase();
    const key = `products/${randomUUID()}${extension ? `.${extension}` : ""}`;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: input.contentType }),
      { expiresIn: 10 * 60 },
    );
    const originalUrl = this.originalUrl(key);

    return { key, uploadUrl, originalUrl, imageUrl: this.transformedUrl(key) };
  };

  getProductImageUrl = async (key: string, width?: number): Promise<string> => {
    if (!key.startsWith("products/")) throw new CustomBadRequestException(MediaErrorMessage.InvalidKey);
    return this.transformedUrl(key, width);
  };

  private originalUrl = (key: string) => `${this.publicBaseUrl}/${key}`;

  private transformedUrl = (key: string, width?: number) => {
    const options = [`format=auto`, width ? `width=${width}` : "fit=scale-down"];
    return `${this.imageTransformBaseUrl}/${options.join(",")}/${this.originalUrl(key)}`;
  };
}
