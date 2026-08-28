import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { AdmissionLimiter, type AdmissionRule, type RequestOrigin } from "src/modules/admission/admission-limiter";
import {
  PRODUCT_IMAGE_KEY_PATTERN,
  PRODUCT_IMAGE_MAX_FILE_SIZE,
  PRODUCT_PENDING_IMAGE_KEY_PATTERN,
  IMAGE_TRANSFORM_MAX_WIDTH,
  STYLE_POST_IMAGE_EXTENSIONS,
  STYLE_POST_IMAGE_KEY_PATTERN,
  STYLE_POST_MAX_FILE_SIZE,
  STYLE_POST_PENDING_IMAGE_KEY_PATTERN,
  STYLE_POST_SUPPORTED_CONTENT_TYPES,
  SUPPORTED_CONTENT_TYPES,
} from "./media.constant";
import { MediaErrorMessage } from "./media.error";
import type {
  CreateProductImageUploadInput,
  CreateStylePostImageUploadInput,
  ProductImageUploadTarget,
} from "./media.types";

const IMAGE_CONTENT_TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
} as const;

type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[keyof typeof IMAGE_CONTENT_TYPES];
type UploadInput = CreateProductImageUploadInput | CreateStylePostImageUploadInput;
type ImagePolicy = Readonly<{
  contentTypes: ReadonlySet<string>;
  finalPattern: RegExp;
  finalPrefix: "products" | "style-posts";
  maxFileSize: number;
  pendingPattern: RegExp;
  pendingPrefix: "pending/products" | "pending/style-posts";
}>;

const PRODUCT_POLICY: ImagePolicy = {
  contentTypes: SUPPORTED_CONTENT_TYPES,
  finalPattern: PRODUCT_IMAGE_KEY_PATTERN,
  finalPrefix: "products",
  maxFileSize: PRODUCT_IMAGE_MAX_FILE_SIZE,
  pendingPattern: PRODUCT_PENDING_IMAGE_KEY_PATTERN,
  pendingPrefix: "pending/products",
};

const STYLE_POST_POLICY: ImagePolicy = {
  contentTypes: STYLE_POST_SUPPORTED_CONTENT_TYPES,
  finalPattern: STYLE_POST_IMAGE_KEY_PATTERN,
  finalPrefix: "style-posts",
  maxFileSize: STYLE_POST_MAX_FILE_SIZE,
  pendingPattern: STYLE_POST_PENDING_IMAGE_KEY_PATTERN,
  pendingPrefix: "pending/style-posts",
};

const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const RIFF_MAGIC = [...Buffer.from("RIFF", "ascii")];
const WEBP_MAGIC = [...Buffer.from("WEBP", "ascii")];
const FTYP_MAGIC = [...Buffer.from("ftyp", "ascii")];
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1"]);
const MAGIC_RANGE = "bytes=0-63";
const MAGIC_RANGE_SIZE = 64;

const hasBytes = (bytes: Uint8Array, offset: number, expected: readonly number[]) =>
  expected.every((value, index) => bytes[offset + index] === value);

const storageStatus = (error: unknown) =>
  typeof error === "object" && error !== null && "$metadata" in error
    ? (error.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode
    : undefined;

@Injectable()
export class MediaService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly imageTransformBaseUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly admissionLimiter: AdmissionLimiter,
  ) {
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

  createProductUpload = (
    userId: string,
    input: CreateProductImageUploadInput,
    origin: RequestOrigin = { ip: "unknown" },
  ): Promise<ProductImageUploadTarget> => this.createUpload(userId, input, origin, PRODUCT_POLICY);

  createStylePostUpload = (
    userId: string,
    input: CreateStylePostImageUploadInput,
    origin: RequestOrigin = { ip: "unknown" },
  ): Promise<ProductImageUploadTarget> => this.createUpload(userId, input, origin, STYLE_POST_POLICY);

  getProductImageUrl = (key: string, width?: number): string => {
    if (!PRODUCT_IMAGE_KEY_PATTERN.test(key)) throw new CustomBadRequestException(MediaErrorMessage.InvalidKey);
    return this.transformedUrl(key, width);
  };

  isProductImageKeyForUser = (key: string, userId: string) =>
    this.keyLocation(key, userId, PRODUCT_POLICY) !== undefined;

  validateProductImageObject = (key: string, userId: string) =>
    this.validateAndPromoteImageObject(key, userId, PRODUCT_POLICY);

  getStylePostImageUrl = (key: string, width?: number) => {
    if (!STYLE_POST_IMAGE_KEY_PATTERN.test(key)) throw new CustomBadRequestException(MediaErrorMessage.InvalidKey);
    return this.transformedUrl(key, width);
  };

  isStylePostImageKeyForUser = (key: string, userId: string) =>
    this.keyLocation(key, userId, STYLE_POST_POLICY) !== undefined;

  validateStylePostImageObject = (key: string, userId: string) =>
    this.validateAndPromoteImageObject(key, userId, STYLE_POST_POLICY);

  private createUpload = async (
    userId: string,
    input: UploadInput,
    origin: RequestOrigin,
    policy: ImagePolicy,
  ): Promise<ProductImageUploadTarget> => {
    const contentType = input.contentType.toLowerCase();
    if (!policy.contentTypes.has(contentType)) throw new CustomBadRequestException(MediaErrorMessage.UnsupportedType);
    if (!Number.isInteger(input.fileSize) || input.fileSize <= 0)
      throw new CustomBadRequestException(MediaErrorMessage.InvalidFileSize);
    if (input.fileSize > policy.maxFileSize) throw new CustomBadRequestException(MediaErrorMessage.FileTooLarge);
    await this.admissionLimiter.assertAllowed(
      "MEDIA_UPLOAD_ISSUE",
      this.uploadAdmissionRules(userId, origin),
      MediaErrorMessage.UploadLimitExceeded,
    );
    const extension = STYLE_POST_IMAGE_EXTENSIONS[contentType];
    if (!extension) throw new CustomBadRequestException(MediaErrorMessage.UnsupportedType);
    const key = `${policy.pendingPrefix}/${userId}/${randomUUID()}.${extension}`;
    const uploadUrl = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: input.fileSize,
        Metadata: {
          "owner-id": userId,
          "declared-content-type": contentType,
          "declared-size": String(input.fileSize),
        },
      }),
      {
        expiresIn: 5 * 60,
        signableHeaders: new Set(["content-length", "content-type"]),
      },
    );
    const originalUrl = this.originalUrl(key);
    return { key, uploadUrl, originalUrl, imageUrl: this.transformedUrl(key) };
  };

  private validateAndPromoteImageObject = async (key: string, userId: string, policy: ImagePolicy) => {
    const location = this.keyLocation(key, userId, policy);
    if (!location) throw new CustomBadRequestException(MediaErrorMessage.InvalidKey);
    const extension = key.slice(key.lastIndexOf(".") + 1).toLowerCase() as keyof typeof IMAGE_CONTENT_TYPES;
    const expectedContentType = IMAGE_CONTENT_TYPES[extension];
    if (!expectedContentType || !policy.contentTypes.has(expectedContentType))
      throw new CustomBadRequestException(MediaErrorMessage.InvalidKey);
    try {
      const head = this.verifiedHead(
        await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })),
        userId,
        expectedContentType,
        policy.maxFileSize,
        location === "pending",
      );
      const bytes = await this.readMagicBytes(key, expectedContentType, head);
      if (!this.hasImageMagic(expectedContentType, bytes))
        throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
      if (location === "final") return key;
      const finalKey = `${policy.finalPrefix}/${userId}/${randomUUID()}.${extension}`;
      const copied = await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: finalKey,
          CopySource: this.copySource(key),
          CopySourceIfMatch: head.etag,
          MetadataDirective: "COPY",
        }),
      );
      if (!copied.CopyObjectResult?.ETag) throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
      return finalKey;
    } catch (error) {
      if (error instanceof CustomBadRequestException) throw error;
      if ([404, 412].includes(storageStatus(error) ?? 0))
        throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
      throw error;
    }
  };

  private verifiedHead = (
    object: HeadObjectCommandOutput,
    userId: string,
    expectedContentType: ImageContentType,
    maxFileSize: number,
    requireDeclaredMetadata: boolean,
  ) => {
    const contentType = object.ContentType?.toLowerCase();
    const size = object.ContentLength;
    const etag = object.ETag;
    if (
      contentType !== expectedContentType ||
      size === undefined ||
      !Number.isInteger(size) ||
      size < 1 ||
      size > maxFileSize ||
      !etag ||
      (requireDeclaredMetadata &&
        (object.Metadata?.["owner-id"] !== userId ||
          object.Metadata?.["declared-content-type"]?.toLowerCase() !== expectedContentType ||
          object.Metadata?.["declared-size"] !== String(size)))
    )
      throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
    return { contentType: expectedContentType, etag, size } as const;
  };

  private readMagicBytes = async (
    key: string,
    expectedContentType: ImageContentType,
    head: Readonly<{ etag: string; size: number }>,
  ) => {
    const object = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: MAGIC_RANGE, IfMatch: head.etag }),
    );
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(object.ContentRange ?? "");
    const rangeEnd = range?.[1];
    const totalSize = range?.[2];
    if (
      object.ContentLength === undefined ||
      !Number.isInteger(object.ContentLength) ||
      object.ContentLength < 1 ||
      object.ContentLength > MAGIC_RANGE_SIZE ||
      object.ContentType?.toLowerCase() !== expectedContentType ||
      object.ETag !== head.etag ||
      !object.Body ||
      !rangeEnd ||
      !totalSize ||
      Number(rangeEnd) + 1 !== object.ContentLength ||
      Number(totalSize) !== head.size
    )
      throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
    const bytes = await object.Body.transformToByteArray();
    if (bytes.byteLength !== object.ContentLength || bytes.byteLength > MAGIC_RANGE_SIZE)
      throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
    return bytes;
  };

  private hasImageMagic = (contentType: ImageContentType, bytes: Uint8Array) => {
    if (contentType === "image/jpeg") return hasBytes(bytes, 0, JPEG_MAGIC);
    if (contentType === "image/png") return hasBytes(bytes, 0, PNG_MAGIC);
    if (contentType === "image/webp") return hasBytes(bytes, 0, RIFF_MAGIC) && hasBytes(bytes, 8, WEBP_MAGIC);
    if (!hasBytes(bytes, 4, FTYP_MAGIC) || bytes.byteLength < 16) return false;
    const boxSize = (bytes[0] ?? 0) * 2 ** 24 + (bytes[1] ?? 0) * 2 ** 16 + (bytes[2] ?? 0) * 2 ** 8 + (bytes[3] ?? 0);
    if (boxSize < 16) return false;
    const brands = [this.asciiAt(bytes, 8)];
    for (let offset = 16; offset + 4 <= Math.min(boxSize, bytes.byteLength); offset += 4)
      brands.push(this.asciiAt(bytes, offset));
    return brands.some((brand) => HEIF_BRANDS.has(brand));
  };

  private asciiAt = (bytes: Uint8Array, offset: number) =>
    Buffer.from(bytes.subarray(offset, offset + 4)).toString("ascii");

  private keyLocation = (key: string, userId: string, policy: ImagePolicy) => {
    if (key.startsWith(`${policy.pendingPrefix}/${userId}/`) && policy.pendingPattern.test(key))
      return "pending" as const;
    if (key.startsWith(`${policy.finalPrefix}/${userId}/`) && policy.finalPattern.test(key)) return "final" as const;
    return undefined;
  };

  private uploadAdmissionRules = (userId: string, origin: RequestOrigin): AdmissionRule[] => [
    { scopeType: "user", value: userId, limit: 60, windowMs: 60 * 60_000 },
    { scopeType: "ip", value: origin.ip, limit: 120, windowMs: 60 * 60_000 },
    ...(origin.deviceId
      ? [{ scopeType: "device", value: origin.deviceId, limit: 120, windowMs: 60 * 60_000 } satisfies AdmissionRule]
      : []),
  ];

  private copySource = (key: string) =>
    `/${encodeURIComponent(this.bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;

  private originalUrl = (key: string) => `${this.publicBaseUrl}/${key}`;

  private transformedUrl = (key: string, width?: number) => {
    if (width !== undefined && (!Number.isInteger(width) || width < 1 || width > IMAGE_TRANSFORM_MAX_WIDTH))
      throw new CustomBadRequestException(MediaErrorMessage.InvalidTransformWidth);
    const options = [`format=auto`, width ? `width=${width}` : "fit=scale-down"];
    return `${this.imageTransformBaseUrl}/${options.join(",")}/${this.originalUrl(key)}`;
  };
}
