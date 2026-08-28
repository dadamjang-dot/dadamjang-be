import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { ConfigService } from "@nestjs/config";
import sharp from "sharp";
import { CustomTooManyRequestsException } from "src/common/errors/custom-exceptions";
import { AdmissionLimiter, type RequestOrigin } from "src/modules/admission/admission-limiter";
import { MediaErrorMessage } from "./media.error";
import { MediaService } from "./media.service";

type StorageClient = { send(command: unknown): Promise<unknown> };
type HardenedMediaService = MediaService & {
  validateStylePostImageObject(key: string, userId: string): Promise<string>;
};

const ownerUserId = "00000000-0000-4000-8000-000000000001";
const validProductKey = `products/${ownerUserId}/00000000-0000-4000-8000-000000000002.webp`;
const pendingProductKey = `pending/products/${ownerUserId}/00000000-0000-4000-8000-000000000003.png`;
const invalidPendingProductKey = `pending/products/${ownerUserId}/00000000-0000-4000-8000-000000000004.png`;
const origin: RequestOrigin = { ip: "127.0.0.1", deviceId: "media-device" };

const allow = () => ({ assertAllowed: jest.fn().mockResolvedValue(undefined) }) as unknown as AdmissionLimiter;

type SupportedContentType = "image/jpeg" | "image/png" | "image/webp";
let imageBytes: Record<SupportedContentType, Buffer>;

const createService = (admissionLimiter = allow()) => {
  const values: Record<string, string> = {
    CLOUDFLARE_R2_BUCKET: "dadamjang-staging-images",
    CLOUDFLARE_R2_PENDING_BUCKET: "dadamjang-staging-pending",
    CLOUDFLARE_R2_PUBLIC_BASE_URL: "https://images.example.com/",
    CLOUDFLARE_IMAGES_TRANSFORM_BASE_URL: "https://images.example.com/cdn-cgi/image/",
    CLOUDFLARE_R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    CLOUDFLARE_R2_ACCESS_KEY_ID: "key",
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret",
  };
  const configService = {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const repository = {
    adoptFinalObject: jest.fn().mockResolvedValue(undefined),
    claimGarbage: jest.fn().mockResolvedValue(undefined),
    completeGarbage: jest.fn().mockResolvedValue(undefined),
    markPromotionReady: jest.fn().mockResolvedValue(undefined),
    releaseGarbage: jest.fn().mockResolvedValue(undefined),
    reservePromotion: jest.fn().mockResolvedValue(undefined),
  };
  const Constructor = MediaService as unknown as new (
    config: ConfigService,
    limiter: AdmissionLimiter,
    mediaRepository: typeof repository,
  ) => MediaService;
  return new Constructor(configService, admissionLimiter, repository);
};

const clientOf = (service: MediaService) => (service as unknown as { client: StorageClient }).client;

const bytesWith = (...parts: readonly [number, readonly number[]][]) => {
  const bytes = new Uint8Array(64);
  for (const [offset, part] of parts) bytes.set(part, offset);
  return bytes;
};

const ascii = (value: string) => [...Buffer.from(value, "ascii")];

const metadata = (owner: string, contentType: string, size: number) => ({
  "owner-id": owner,
  "declared-content-type": contentType,
  "declared-size": String(size),
});

const validObject = (
  contentType: SupportedContentType,
  options: { owner?: string; size?: number; bytes?: Uint8Array; declaredMetadata?: boolean } = {},
) => {
  const bytes = options.bytes ?? imageBytes[contentType];
  const size = options.size ?? bytes.byteLength;
  return async (command: unknown) => {
    if (command instanceof HeadObjectCommand)
      return {
        ContentType: contentType,
        ContentLength: size,
        ...(options.declaredMetadata === false
          ? {}
          : { Metadata: metadata(options.owner ?? ownerUserId, contentType, size) }),
        ETag: '"object-etag"',
      };
    if (command instanceof GetObjectCommand)
      return {
        ContentLength: bytes.byteLength,
        ContentType: contentType,
        ETag: '"object-etag"',
        Body: { transformToByteArray: async () => bytes },
      };
    if (command instanceof CopyObjectCommand) return { CopyObjectResult: { ETag: '"copied-etag"' } };
    throw new Error("Unexpected storage command");
  };
};

const missingObject = () => Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });

const promotableObject = (contentType: SupportedContentType, etag = '"object-etag"') => {
  const bytes = imageBytes[contentType];
  const size = bytes.byteLength;
  let destination: { contentType: string; key: string; metadata: Record<string, string> } | undefined;
  return async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      if (command.input.Key === pendingProductKey)
        return {
          ContentType: contentType,
          ContentLength: size,
          Metadata: metadata(ownerUserId, contentType, size),
          ETag: etag,
        };
      const promoted = destination;
      if (promoted && promoted.key === command.input.Key)
        return {
          ContentType: promoted.contentType,
          ContentLength: size,
          Metadata: promoted.metadata,
          ETag: '"copied-etag"',
        };
      throw missingObject();
    }
    if (command instanceof GetObjectCommand) {
      const promoted = destination;
      return {
        ContentLength: size,
        ContentType: contentType,
        ETag: promoted?.key === command.input.Key ? '"copied-etag"' : etag,
        Body: { transformToByteArray: async () => bytes },
      };
    }
    if (command instanceof CopyObjectCommand) {
      if (!command.input.Key) throw new Error("Copy destination is required");
      destination = {
        contentType: command.input.ContentType ?? contentType,
        key: command.input.Key,
        metadata: command.input.Metadata ?? {},
      };
      return { CopyObjectResult: { ETag: '"copied-etag"' } };
    }
    throw new Error("Unexpected storage command");
  };
};

describe("MediaService", () => {
  beforeAll(async () => {
    const source = { create: { width: 4, height: 3, channels: 4 as const, background: "#ff00ffff" } };
    const [jpeg, png, webp] = await Promise.all([
      sharp(source).jpeg().toBuffer(),
      sharp(source).png().toBuffer(),
      sharp(source).webp().toBuffer(),
    ]);
    imageBytes = { "image/jpeg": jpeg, "image/png": png, "image/webp": webp };
  });

  it("creates a Cloudflare Images transformation URL without exposing R2 credentials", () => {
    const service = createService();
    const key = `products/${ownerUserId}/00000000-0000-4000-8000-000000000002.jpg`;

    expect(service.getProductImageUrl(key, 640)).toBe(
      `https://images.example.com/cdn-cgi/image/format=auto,width=640/https://images.example.com/${key}`,
    );
  });

  it("rejects malformed product keys and unbounded transformation widths", () => {
    const service = createService();
    const key = `products/${ownerUserId}/00000000-0000-4000-8000-000000000002.jpg`;

    expect(() => service.getProductImageUrl("products/product.jpg")).toThrow(MediaErrorMessage.InvalidKey);
    expect(() => service.getProductImageUrl(key, 0)).toThrow(MediaErrorMessage.InvalidTransformWidth);
    expect(() => service.getProductImageUrl(key, 2049)).toThrow(MediaErrorMessage.InvalidTransformWidth);
    expect(() => service.getStylePostImageUrl(key.replace("products/", "style-posts/"), 1.5)).toThrow(
      MediaErrorMessage.InvalidTransformWidth,
    );
  });

  it("scopes style post image URLs and enforces the 10MB boundary", async () => {
    const service = createService();

    const validKey = `style-posts/${ownerUserId}/00000000-0000-4000-8000-000000000002.webp`;
    expect(service.getStylePostImageUrl(validKey)).toContain(validKey);
    expect(() => service.getStylePostImageUrl("style-posts/user-1/look.webp")).toThrow(MediaErrorMessage.InvalidKey);
    await expect(
      service.createStylePostUpload(
        ownerUserId,
        {
          filename: "look.jpg",
          contentType: "image/jpeg",
          fileSize: 10 * 1024 * 1024 + 1,
        },
        origin,
      ),
    ).rejects.toThrow(MediaErrorMessage.FileTooLarge);
  });

  it("issues owned pending uploads with signed type and length constraints", async () => {
    const limiter = allow();
    const service = createService(limiter);

    const target = await service.createProductUpload(
      ownerUserId,
      { filename: "product.png", contentType: "image/png", fileSize: 1024 },
      origin,
    );
    const uploadUrl = new URL(target.uploadUrl);
    const signedHeaders = uploadUrl.searchParams.get("X-Amz-SignedHeaders")?.split(";");

    expect(target.key).toMatch(new RegExp(`^pending/products/${ownerUserId}/[0-9a-f-]{36}\\.png$`));
    expect(signedHeaders).toEqual(expect.arrayContaining(["content-length", "content-type", "host"]));
    expect(uploadUrl.searchParams.get("x-amz-meta-owner-id")).toBe(ownerUserId);
    expect(uploadUrl.searchParams.get("x-amz-meta-declared-content-type")).toBe("image/png");
    expect(uploadUrl.searchParams.get("x-amz-meta-declared-size")).toBe("1024");
    expect(limiter.assertAllowed).toHaveBeenCalledWith("MEDIA_UPLOAD_ISSUE", expect.any(Array), expect.any(String));
    expect(() => service.getProductImageUrl(target.key)).toThrow(MediaErrorMessage.InvalidKey);
  });

  it("reads and decodes the full object before promoting a pending product image", async () => {
    const service = createService();
    const send = jest.spyOn(clientOf(service), "send").mockImplementation(promotableObject("image/png"));

    const finalKey = await service.validateProductImageObject(pendingProductKey, ownerUserId);

    expect(finalKey).toMatch(new RegExp(`^products/${ownerUserId}/[0-9a-f]{64}\\.png$`));
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: {
        Bucket: "dadamjang-staging-pending",
        Key: pendingProductKey,
        IfMatch: '"object-etag"',
      },
    });
    const copy = send.mock.calls.map(([command]) => command).find((command) => command instanceof CopyObjectCommand);
    expect(copy).toMatchObject({
      input: {
        Bucket: "dadamjang-staging-images",
        Key: finalKey,
        CopySource: `/dadamjang-staging-pending/${pendingProductKey}`,
        CopySourceIfMatch: '"object-etag"',
        MetadataDirective: "REPLACE",
        ContentType: "image/png",
        Metadata: {
          "owner-id": ownerUserId,
          "declared-content-type": "image/png",
          "declared-size": String(imageBytes["image/png"].byteLength),
          "promotion-id": finalKey.slice(finalKey.lastIndexOf("/") + 1, -4),
        },
      },
    });
    expect(service.getProductImageUrl(finalKey)).toContain(finalKey);
  });

  it("reuses an existing promotion for the same pending object version", async () => {
    const service = createService();
    const send = jest.spyOn(clientOf(service), "send").mockImplementation(promotableObject("image/png"));

    const first = await service.validateProductImageObject(pendingProductKey, ownerUserId);
    const second = await service.validateProductImageObject(pendingProductKey, ownerUserId);

    expect(second).toBe(first);
    expect(send.mock.calls.filter(([command]) => command instanceof CopyObjectCommand)).toHaveLength(1);
  });

  it("converges concurrent promotions on one final object key", async () => {
    const service = createService();
    const send = jest.spyOn(clientOf(service), "send").mockImplementation(promotableObject("image/png"));

    const finalKeys = await Promise.all(
      Array.from({ length: 8 }, () => service.validateProductImageObject(pendingProductKey, ownerUserId)),
    );
    const copyKeys = send.mock.calls
      .map(([command]) => command)
      .filter((command): command is CopyObjectCommand => command instanceof CopyObjectCommand)
      .map((command) => command.input.Key);

    expect(new Set(finalKeys)).toEqual(new Set([finalKeys[0]]));
    expect(new Set(copyKeys)).toEqual(new Set([finalKeys[0]]));
  });

  it("uses a new final key when the pending object ETag changes", async () => {
    const firstService = createService();
    const secondService = createService();
    jest.spyOn(clientOf(firstService), "send").mockImplementation(promotableObject("image/png", '"etag-v1"'));
    jest.spyOn(clientOf(secondService), "send").mockImplementation(promotableObject("image/png", '"etag-v2"'));

    const first = await firstService.validateProductImageObject(pendingProductKey, ownerUserId);
    const second = await secondService.validateProductImageObject(pendingProductKey, ownerUserId);

    expect(second).not.toBe(first);
  });

  it("validates an entire attachment batch before promoting any object", async () => {
    const service = createService();
    const send = jest.spyOn(clientOf(service), "send").mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand) {
        const valid = command.input.Key === pendingProductKey;
        return {
          ContentType: "image/png",
          ContentLength: imageBytes["image/png"].byteLength,
          Metadata: metadata(
            valid ? ownerUserId : "00000000-0000-4000-8000-000000000099",
            "image/png",
            imageBytes["image/png"].byteLength,
          ),
          ETag: '"object-etag"',
        };
      }
      if (command instanceof GetObjectCommand) {
        const bytes = imageBytes["image/png"];
        return {
          ContentLength: bytes.byteLength,
          ContentType: "image/png",
          ETag: '"object-etag"',
          Body: { transformToByteArray: async () => bytes },
        };
      }
      if (command instanceof CopyObjectCommand) return { CopyObjectResult: { ETag: '"copied-etag"' } };
      throw new Error("Unexpected storage command");
    });

    await expect(
      service.validateProductImageObjects([pendingProductKey, invalidPendingProductKey], ownerUserId),
    ).rejects.toThrow(MediaErrorMessage.ObjectInvalid);
    expect(send.mock.calls.some(([command]) => command instanceof CopyObjectCommand)).toBe(false);
  });

  it("fails closed when an existing deterministic promotion has mismatched server metadata", async () => {
    const service = createService();
    const respond = promotableObject("image/png");
    const send = jest.spyOn(clientOf(service), "send").mockImplementation(respond);
    const finalKey = await service.validateProductImageObject(pendingProductKey, ownerUserId);
    send.mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand && command.input.Key === finalKey)
        return {
          ContentType: "image/png",
          ContentLength: imageBytes["image/png"].byteLength,
          Metadata: {
            ...metadata(ownerUserId, "image/png", imageBytes["image/png"].byteLength),
            "promotion-id": "0".repeat(64),
          },
          ETag: '"copied-etag"',
        };
      return respond(command);
    });

    await expect(service.validateProductImageObject(pendingProductKey, ownerUserId)).rejects.toThrow(
      MediaErrorMessage.ObjectInvalid,
    );
    expect(send.mock.calls.filter(([command]) => command instanceof CopyObjectCommand)).toHaveLength(1);
  });

  it("accepts a legacy final object without declared metadata after full decoding", async () => {
    const service = createService();
    const send = jest
      .spyOn(clientOf(service), "send")
      .mockImplementation(validObject("image/webp", { declaredMetadata: false }));

    await expect(service.validateProductImageObject(validProductKey, ownerUserId)).resolves.toBe(validProductKey);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: { Bucket: "dadamjang-staging-images", Key: validProductKey, IfMatch: '"object-etag"' },
    });
  });

  it.each([
    ["jpg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
  ] as const)("accepts genuine .%s style image bytes", async (extension, contentType) => {
    const service = createService() as HardenedMediaService;
    jest.spyOn(clientOf(service), "send").mockImplementation(validObject(contentType));
    const key = `style-posts/${ownerUserId}/00000000-0000-4000-8000-000000000002.${extension}`;

    await expect(service.validateStylePostImageObject(key, ownerUserId)).resolves.toBe(key);
  });

  it("keeps legacy HEIC delivery keys readable while rejecting new HEIC uploads", async () => {
    const service = createService();
    const key = `style-posts/${ownerUserId}/00000000-0000-4000-8000-000000000002.heic`;

    expect(service.getStylePostImageUrl(key)).toContain(key);
    await expect(
      service.createStylePostUpload(
        ownerUserId,
        { filename: "legacy.heic", contentType: "image/heic", fileSize: 1024 },
        origin,
      ),
    ).rejects.toThrow(MediaErrorMessage.UnsupportedType);
  });

  it.each([
    ["missing", () => Promise.reject(Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } }))],
    ["invalid type", () => Promise.resolve({ ContentType: "application/pdf", ContentLength: 1 })],
    ["zero size", () => Promise.resolve({ ContentType: "image/png", ContentLength: 0 })],
    ["oversize", () => Promise.resolve({ ContentType: "image/jpeg", ContentLength: 10 * 1024 * 1024 + 1 })],
  ])("rejects a %s product image object", async (_name, response) => {
    const service = createService();
    jest.spyOn(clientOf(service), "send").mockImplementation(response);

    await expect(service.validateProductImageObject(validProductKey, ownerUserId)).rejects.toThrow(
      MediaErrorMessage.ObjectInvalid,
    );
  });

  it("rejects spoofed declared metadata before reading object bytes", async () => {
    const service = createService();
    const send = jest.spyOn(clientOf(service), "send").mockResolvedValue({
      ContentType: "image/png",
      ContentLength: 1024,
      Metadata: metadata(ownerUserId, "image/webp", 1024),
      ETag: '"object-etag"',
    });

    await expect(service.validateProductImageObject(pendingProductKey, ownerUserId)).rejects.toThrow(
      MediaErrorMessage.ObjectInvalid,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects object metadata that declares another owner", async () => {
    const service = createService();
    jest
      .spyOn(clientOf(service), "send")
      .mockImplementation(validObject("image/png", { owner: "00000000-0000-4000-8000-000000000099" }));

    await expect(service.validateProductImageObject(pendingProductKey, ownerUserId)).rejects.toThrow(
      MediaErrorMessage.ObjectInvalid,
    );
  });

  it("rejects an image MIME label backed by invalid magic bytes", async () => {
    const service = createService();
    jest
      .spyOn(clientOf(service), "send")
      .mockImplementation(validObject("image/webp", { bytes: bytesWith([0, ascii("%PDF")]) }));

    await expect(service.validateProductImageObject(validProductKey, ownerUserId)).rejects.toThrow(
      MediaErrorMessage.ObjectInvalid,
    );
  });

  it("refuses an unbounded range response without consuming its body", async () => {
    const service = createService();
    const transformToByteArray = jest.fn();
    const send = jest.spyOn(clientOf(service), "send").mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand)
        return {
          ContentType: "image/webp",
          ContentLength: 1024,
          Metadata: metadata(ownerUserId, "image/webp", 1024),
          ETag: '"object-etag"',
        };
      return { ContentLength: 1024, ContentRange: "bytes 0-1023/1024", Body: { transformToByteArray } };
    });

    await expect(service.validateProductImageObject(validProductKey, ownerUserId)).rejects.toThrow(
      MediaErrorMessage.ObjectInvalid,
    );
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("stops a streamed object as soon as it exceeds the verified size", async () => {
    const service = createService();
    let yieldedChunks = 0;
    const transformToByteArray = jest.fn().mockResolvedValue(Buffer.alloc(1024));
    const body = {
      async *[Symbol.asyncIterator]() {
        for (const chunk of [Buffer.alloc(3), Buffer.alloc(2), Buffer.alloc(1024)]) {
          yieldedChunks += 1;
          yield chunk;
        }
      },
      transformToByteArray,
    };
    jest.spyOn(clientOf(service), "send").mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand)
        return {
          ContentType: "image/webp",
          ContentLength: 4,
          ETag: '"object-etag"',
        };
      return {
        Body: body,
        ContentLength: 4,
        ContentType: "image/webp",
        ETag: '"object-etag"',
      };
    });

    await expect(service.validateProductImageObject(validProductKey, ownerUserId)).rejects.toThrow(
      MediaErrorMessage.ObjectInvalid,
    );
    expect(transformToByteArray).not.toHaveBeenCalled();
    expect(yieldedChunks).toBe(2);
  });

  it("rejects another user's key without issuing HeadObject", async () => {
    const service = createService();
    const send = jest.spyOn(clientOf(service), "send");

    await expect(
      service.validateProductImageObject(validProductKey, "00000000-0000-4000-8000-000000000099"),
    ).rejects.toThrow(MediaErrorMessage.InvalidKey);
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks upload issuance before presigning when admission is exhausted", async () => {
    const limiter = {
      assertAllowed: jest
        .fn()
        .mockRejectedValue(new CustomTooManyRequestsException("업로드 요청 횟수를 초과했습니다.")),
    } as unknown as AdmissionLimiter;
    const service = createService(limiter);

    await expect(
      service.createProductUpload(
        ownerUserId,
        { filename: "product.png", contentType: "image/png", fileSize: 1024 },
        origin,
      ),
    ).rejects.toBeInstanceOf(CustomTooManyRequestsException);
  });

  it("propagates unexpected object storage failures", async () => {
    const service = createService();
    const error = new Error("object storage unavailable");
    jest.spyOn(clientOf(service), "send").mockRejectedValue(error);

    await expect(service.validateProductImageObject(validProductKey, ownerUserId)).rejects.toBe(error);
  });
});
