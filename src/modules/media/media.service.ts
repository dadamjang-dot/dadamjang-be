import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash, randomUUID } from "crypto";
import sharp from "sharp";
import { CustomBadRequestException } from "src/common/errors/custom-exceptions";
import { AdmissionLimiter, type AdmissionRule, type RequestOrigin } from "src/modules/admission/admission-limiter";
import type { DatabaseTransaction } from "src/modules/database/database.module";
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
import { type MediaEntityType, MediaRepository } from "./media.repository";
import type {
  CreateProductImageUploadInput,
  CreateStylePostImageUploadInput,
  ProductImageUploadTarget,
} from "./media.types";

const IMAGE_CONTENT_TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[keyof typeof IMAGE_CONTENT_TYPES];
type UploadInput = CreateProductImageUploadInput | CreateStylePostImageUploadInput;
type ImagePolicy = Readonly<{
  contentTypes: ReadonlySet<string>;
  finalPattern: RegExp;
  finalPrefix: "products" | "style-posts";
  kind: MediaEntityType;
  maxFileSize: number;
  pendingPattern: RegExp;
  pendingPrefix: "pending/products" | "pending/style-posts";
}>;
type InspectedImageObject = Readonly<{
  expectedContentType: ImageContentType;
  extension: keyof typeof IMAGE_CONTENT_TYPES;
  head: Readonly<{ contentType: ImageContentType; etag: string; size: number }>;
  key: string;
  location: "final" | "pending";
}>;

const PRODUCT_POLICY: ImagePolicy = {
  contentTypes: SUPPORTED_CONTENT_TYPES,
  finalPattern: PRODUCT_IMAGE_KEY_PATTERN,
  finalPrefix: "products",
  kind: "PRODUCT",
  maxFileSize: PRODUCT_IMAGE_MAX_FILE_SIZE,
  pendingPattern: PRODUCT_PENDING_IMAGE_KEY_PATTERN,
  pendingPrefix: "pending/products",
};

const STYLE_POST_POLICY: ImagePolicy = {
  contentTypes: STYLE_POST_SUPPORTED_CONTENT_TYPES,
  finalPattern: STYLE_POST_IMAGE_KEY_PATTERN,
  finalPrefix: "style-posts",
  kind: "STYLE_POST",
  maxFileSize: STYLE_POST_MAX_FILE_SIZE,
  pendingPattern: STYLE_POST_PENDING_IMAGE_KEY_PATTERN,
  pendingPrefix: "pending/style-posts",
};

const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const PNG_START = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_END = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const IMAGE_FORMATS = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" } as const;
const IMAGE_MAX_DIMENSION = 8_192;
const IMAGE_MAX_PIXELS = 20_000_000;

const hasBytes = (bytes: Uint8Array, offset: number, expected: Uint8Array) =>
  expected.every((value, index) => bytes[offset + index] === value);

const storageStatus = (error: unknown) =>
  typeof error === "object" && error !== null && "$metadata" in error
    ? (error.$metadata as { httpStatusCode?: number } | undefined)?.httpStatusCode
    : undefined;

@Injectable()
export class MediaService implements OnModuleInit, OnApplicationShutdown {
  private readonly client: S3Client;
  private readonly finalBucket: string;
  private readonly pendingBucket: string;
  private readonly publicBaseUrl: string;
  private readonly imageTransformBaseUrl: string;
  private collectingGarbage = false;
  private readonly logger = new Logger(MediaService.name);
  private garbageTimer?: NodeJS.Timeout;

  constructor(
    private readonly configService: ConfigService,
    private readonly admissionLimiter: AdmissionLimiter,
    private readonly repository: MediaRepository,
  ) {
    this.finalBucket = configService.getOrThrow<string>("CLOUDFLARE_R2_BUCKET").trim();
    this.pendingBucket = configService.getOrThrow<string>("CLOUDFLARE_R2_PENDING_BUCKET").trim();
    if (!this.finalBucket || !this.pendingBucket || this.finalBucket === this.pendingBucket)
      throw new Error("CLOUDFLARE_R2_PENDING_BUCKET must be private and distinct from CLOUDFLARE_R2_BUCKET");
    this.publicBaseUrl = configService.getOrThrow<string>("CLOUDFLARE_R2_PUBLIC_BASE_URL").replace(/\/$/, "");
    const publicHostname = new URL(this.publicBaseUrl).hostname.toLowerCase();
    if (publicHostname === "r2.dev" || publicHostname.endsWith(".r2.dev"))
      throw new Error("CLOUDFLARE_R2_PUBLIC_BASE_URL must not use the public r2.dev origin");
    if (configService.get<string>("CLOUDFLARE_R2_PENDING_PUBLIC_BASE_URL")?.trim())
      throw new Error("CLOUDFLARE_R2_PENDING_PUBLIC_BASE_URL is forbidden");
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

  onModuleInit = () => {
    if (this.configService.get<string>("MEDIA_GC_WORKER_ENABLED") === "false") return;
    this.garbageTimer = setInterval(() => void this.collectGarbage(), 60_000);
    this.garbageTimer.unref();
    void this.collectGarbage();
  };

  onApplicationShutdown = () => {
    if (this.garbageTimer) clearInterval(this.garbageTimer);
    this.client.destroy();
  };

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

  validateProductImageObjects = (keys: readonly string[], userId: string) =>
    this.validateAndPromoteImageObjects(keys, userId, PRODUCT_POLICY);

  getStylePostImageUrl = (key: string, width?: number) => {
    if (!STYLE_POST_IMAGE_KEY_PATTERN.test(key)) throw new CustomBadRequestException(MediaErrorMessage.InvalidKey);
    return this.transformedUrl(key, width);
  };

  isStylePostImageKeyForUser = (key: string, userId: string) =>
    this.keyLocation(key, userId, STYLE_POST_POLICY) !== undefined;

  validateStylePostImageObject = (key: string, userId: string) =>
    this.validateAndPromoteImageObject(key, userId, STYLE_POST_POLICY);

  validateStylePostImageObjects = (keys: readonly string[], userId: string) =>
    this.validateAndPromoteImageObjects(keys, userId, STYLE_POST_POLICY);

  replaceImageReferences = (
    transaction: DatabaseTransaction,
    entityType: MediaEntityType,
    entityId: string,
    finalKeys: readonly string[],
  ) => this.repository.replaceReferences(transaction, entityType, entityId, finalKeys);

  runGarbageCollectionOnce = async (now = new Date()) => {
    const claim = await this.repository.claimGarbage(now);
    if (!claim) return false;
    try {
      try {
        await this.client.send(new DeleteObjectCommand({ Bucket: this.finalBucket, Key: claim.finalKey }));
      } catch (error) {
        if (storageStatus(error) !== 404) throw error;
      }
      await this.repository.completeGarbage(claim, now);
    } catch (error) {
      await this.repository.releaseGarbage(claim, now);
      throw error;
    }
    return true;
  };

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
        Bucket: this.pendingBucket,
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
    return { key, uploadUrl, originalUrl: null, imageUrl: null };
  };

  private validateAndPromoteImageObject = async (key: string, userId: string, policy: ImagePolicy) =>
    this.promoteImageObject(await this.inspectImageObject(key, userId, policy), userId, policy);

  private validateAndPromoteImageObjects = async (keys: readonly string[], userId: string, policy: ImagePolicy) => {
    const objects: InspectedImageObject[] = [];
    for (let index = 0; index < keys.length; index += 2)
      objects.push(
        ...(await Promise.all(keys.slice(index, index + 2).map((key) => this.inspectImageObject(key, userId, policy)))),
      );
    return Promise.all(objects.map((object) => this.promoteImageObject(object, userId, policy)));
  };

  private inspectImageObject = async (
    key: string,
    userId: string,
    policy: ImagePolicy,
  ): Promise<InspectedImageObject> => {
    const location = this.keyLocation(key, userId, policy);
    if (!location) throw new CustomBadRequestException(MediaErrorMessage.InvalidKey);
    const extension = key.slice(key.lastIndexOf(".") + 1).toLowerCase() as keyof typeof IMAGE_CONTENT_TYPES;
    const expectedContentType = IMAGE_CONTENT_TYPES[extension];
    if (!expectedContentType || !policy.contentTypes.has(expectedContentType))
      throw new CustomBadRequestException(MediaErrorMessage.InvalidKey);
    try {
      const bucket = location === "pending" ? this.pendingBucket : this.finalBucket;
      const head = this.verifiedHead(
        await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })),
        userId,
        expectedContentType,
        policy.maxFileSize,
        location === "pending",
      );
      const bytes = await this.readImageBytes(bucket, key, expectedContentType, head);
      await this.assertDecodedImage(expectedContentType, bytes);
      return { expectedContentType, extension, head, key, location };
    } catch (error) {
      if (error instanceof CustomBadRequestException) throw error;
      if ([404, 412].includes(storageStatus(error) ?? 0))
        throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
      throw error;
    }
  };

  private promoteImageObject = async (object: InspectedImageObject, userId: string, policy: ImagePolicy) => {
    if (object.location === "final") {
      await this.repository.adoptFinalObject({
        contentType: object.expectedContentType,
        finalEtag: object.head.etag,
        finalKey: object.key,
        kind: policy.kind,
        objectSize: object.head.size,
        ownerUserId: userId,
      });
      return object.key;
    }
    const promotionId = this.promotionId(object.key, object.head.etag);
    const finalKey = `${policy.finalPrefix}/${userId}/${promotionId}.${object.extension}`;
    try {
      await this.repository.reservePromotion({
        contentType: object.expectedContentType,
        finalKey,
        kind: policy.kind,
        objectSize: object.head.size,
        ownerUserId: userId,
        sourceBucket: this.pendingBucket,
        sourceEtag: object.head.etag,
        sourceKey: object.key,
      });
      const existingEtag = await this.matchingPromotionEtag(
        finalKey,
        userId,
        object.expectedContentType,
        policy.maxFileSize,
        promotionId,
      );
      if (existingEtag) {
        await this.repository.markPromotionReady(finalKey, existingEtag);
        return finalKey;
      }
      const copied = await this.client.send(
        new CopyObjectCommand({
          Bucket: this.finalBucket,
          Key: finalKey,
          CopySource: this.copySource(this.pendingBucket, object.key),
          CopySourceIfMatch: object.head.etag,
          MetadataDirective: "REPLACE",
          ContentType: object.expectedContentType,
          Metadata: {
            "owner-id": userId,
            "declared-content-type": object.expectedContentType,
            "declared-size": String(object.head.size),
            "promotion-id": promotionId,
          },
        }),
      );
      if (!copied.CopyObjectResult?.ETag) throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
      await this.repository.markPromotionReady(finalKey, copied.CopyObjectResult.ETag);
      return finalKey;
    } catch (error) {
      if (error instanceof CustomBadRequestException) throw error;
      if ([404, 412].includes(storageStatus(error) ?? 0))
        throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
      throw error;
    }
  };

  private matchingPromotionEtag = async (
    key: string,
    userId: string,
    expectedContentType: ImageContentType,
    maxFileSize: number,
    promotionId: string,
  ) => {
    try {
      const object = await this.client.send(new HeadObjectCommand({ Bucket: this.finalBucket, Key: key }));
      const head = this.verifiedHead(object, userId, expectedContentType, maxFileSize, true);
      if (object.Metadata?.["promotion-id"] !== promotionId)
        throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
      const bytes = await this.readImageBytes(this.finalBucket, key, expectedContentType, head);
      await this.assertDecodedImage(expectedContentType, bytes);
      return head.etag;
    } catch (error) {
      if (storageStatus(error) === 404) return undefined;
      throw error;
    }
  };

  private collectGarbage = async () => {
    if (this.collectingGarbage) return;
    this.collectingGarbage = true;
    try {
      for (let count = 0; count < 25; count += 1) if (!(await this.runGarbageCollectionOnce())) break;
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : "Media garbage collection failed");
    } finally {
      this.collectingGarbage = false;
    }
  };

  private promotionId = (key: string, etag: string) =>
    createHash("sha256").update(key).update("\0").update(etag).digest("hex");

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

  private readImageBytes = async (
    bucket: string,
    key: string,
    expectedContentType: ImageContentType,
    head: Readonly<{ etag: string; size: number }>,
  ) => {
    const object = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key, IfMatch: head.etag }));
    if (
      object.ContentLength !== head.size ||
      object.ContentRange !== undefined ||
      object.ContentType?.toLowerCase() !== expectedContentType ||
      object.ETag !== head.etag ||
      !object.Body
    )
      throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
    const bytes = await this.readBoundedBody(object.Body, head.size);
    if (bytes.byteLength !== head.size) throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
    return bytes;
  };

  private readBoundedBody = async (
    body: {
      [Symbol.asyncIterator]?(): AsyncIterator<Uint8Array>;
      transformToByteArray(): Promise<Uint8Array>;
    },
    expectedSize: number,
  ) => {
    if (body[Symbol.asyncIterator]) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        if (!(chunk instanceof Uint8Array)) throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
        size += chunk.byteLength;
        if (size > expectedSize) throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, size);
    }
    const bytes = await body.transformToByteArray();
    if (bytes.byteLength > expectedSize) throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
    return bytes;
  };

  private assertDecodedImage = async (contentType: ImageContentType, bytes: Uint8Array) => {
    try {
      if (!this.hasCompleteImageStructure(contentType, bytes))
        throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
      const image = sharp(bytes, {
        failOn: "warning",
        limitInputPixels: IMAGE_MAX_PIXELS,
        sequentialRead: true,
      });
      const metadata = await image.metadata();
      const width = metadata.width;
      const height = metadata.height;
      if (
        metadata.format !== IMAGE_FORMATS[contentType] ||
        !width ||
        !height ||
        width > IMAGE_MAX_DIMENSION ||
        height > IMAGE_MAX_DIMENSION ||
        width * height > IMAGE_MAX_PIXELS ||
        (metadata.pages ?? 1) !== 1
      )
        throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
      await image.clone().rotate().resize({ width: 1, height: 1, fit: "inside" }).raw().toBuffer();
    } catch (error) {
      if (error instanceof CustomBadRequestException) throw error;
      throw new CustomBadRequestException(MediaErrorMessage.ObjectInvalid);
    }
  };

  private hasCompleteImageStructure = (contentType: ImageContentType, bytes: Uint8Array) => {
    if (contentType === "image/jpeg")
      return hasBytes(bytes, 0, JPEG_START) && hasBytes(bytes, bytes.byteLength - JPEG_END.byteLength, JPEG_END);
    if (contentType === "image/png")
      return hasBytes(bytes, 0, PNG_START) && hasBytes(bytes, bytes.byteLength - PNG_END.byteLength, PNG_END);
    if (bytes.byteLength < 12 || !hasBytes(bytes, 0, Buffer.from("RIFF")) || !hasBytes(bytes, 8, Buffer.from("WEBP")))
      return false;
    return Buffer.from(bytes).readUInt32LE(4) + 8 === bytes.byteLength;
  };

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

  private copySource = (bucket: string, key: string) =>
    `/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;

  private originalUrl = (key: string) => `${this.publicBaseUrl}/${key}`;

  private transformedUrl = (key: string, width?: number) => {
    if (width !== undefined && (!Number.isInteger(width) || width < 1 || width > IMAGE_TRANSFORM_MAX_WIDTH))
      throw new CustomBadRequestException(MediaErrorMessage.InvalidTransformWidth);
    const options = [`format=auto`, width ? `width=${width}` : "fit=scale-down"];
    return `${this.imageTransformBaseUrl}/${options.join(",")}/${this.originalUrl(key)}`;
  };
}
