import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { ConfigService } from "@nestjs/config";
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
const origin: RequestOrigin = { ip: "127.0.0.1", deviceId: "media-device" };

const allow = () => ({ assertAllowed: jest.fn().mockResolvedValue(undefined) }) as unknown as AdmissionLimiter;

const createService = (admissionLimiter = allow()) => {
  const values: Record<string, string> = {
    CLOUDFLARE_R2_BUCKET: "dadamjang-staging-images",
    CLOUDFLARE_R2_PUBLIC_BASE_URL: "https://images.example.com/",
    CLOUDFLARE_IMAGES_TRANSFORM_BASE_URL: "https://images.example.com/cdn-cgi/image/",
    CLOUDFLARE_R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    CLOUDFLARE_R2_ACCESS_KEY_ID: "key",
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret",
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  const Constructor = MediaService as unknown as new (config: ConfigService, limiter: AdmissionLimiter) => MediaService;
  return new Constructor(configService, admissionLimiter);
};

const clientOf = (service: MediaService) => (service as unknown as { client: StorageClient }).client;

const bytesWith = (...parts: readonly [number, readonly number[]][]) => {
  const bytes = new Uint8Array(64);
  for (const [offset, part] of parts) bytes.set(part, offset);
  return bytes;
};

const ascii = (value: string) => [...Buffer.from(value, "ascii")];

const magicBytes = {
  "image/jpeg": bytesWith([0, [0xff, 0xd8, 0xff]]),
  "image/png": bytesWith([0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]),
  "image/webp": bytesWith([0, ascii("RIFF")], [8, ascii("WEBP")]),
  "image/heic": bytesWith([0, [0, 0, 0, 24]], [4, ascii("ftyp")], [8, ascii("heic")]),
  "image/heif": bytesWith([0, [0, 0, 0, 24]], [4, ascii("ftyp")], [8, ascii("mif1")]),
} as const;

const metadata = (owner: string, contentType: string, size: number) => ({
  "owner-id": owner,
  "declared-content-type": contentType,
  "declared-size": String(size),
});

const validObject = (
  contentType: keyof typeof magicBytes,
  options: { owner?: string; size?: number; bytes?: Uint8Array; declaredMetadata?: boolean } = {},
) => {
  const size = options.size ?? 1024;
  const bytes = options.bytes ?? magicBytes[contentType];
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
        ContentRange: `bytes 0-${bytes.byteLength - 1}/${size}`,
        ContentType: contentType,
        ETag: '"object-etag"',
        Body: { transformToByteArray: async () => bytes },
      };
    if (command instanceof CopyObjectCommand) return { CopyObjectResult: { ETag: '"copied-etag"' } };
    throw new Error("Unexpected storage command");
  };
};

describe("MediaService", () => {
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

  it("reads only the first 64 bytes and promotes a verified pending product object", async () => {
    const service = createService();
    const send = jest.spyOn(clientOf(service), "send").mockImplementation(validObject("image/png"));

    const finalKey = await service.validateProductImageObject(pendingProductKey, ownerUserId);

    expect(finalKey).toMatch(new RegExp(`^products/${ownerUserId}/[0-9a-f-]{36}\\.png$`));
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: {
        Bucket: "dadamjang-staging-images",
        Key: pendingProductKey,
        Range: "bytes=0-63",
        IfMatch: '"object-etag"',
      },
    });
    expect(send.mock.calls[2]?.[0]).toMatchObject({
      input: {
        Bucket: "dadamjang-staging-images",
        Key: finalKey,
        CopySource: `/dadamjang-staging-images/${pendingProductKey}`,
        CopySourceIfMatch: '"object-etag"',
        MetadataDirective: "COPY",
      },
    });
  });

  it("accepts a legacy final object without declared metadata after bounded byte verification", async () => {
    const service = createService();
    const send = jest
      .spyOn(clientOf(service), "send")
      .mockImplementation(validObject("image/webp", { declaredMetadata: false }));

    await expect(service.validateProductImageObject(validProductKey, ownerUserId)).resolves.toBe(validProductKey);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toMatchObject({
      input: { Key: validProductKey, Range: "bytes=0-63", IfMatch: '"object-etag"' },
    });
  });

  it.each([
    ["jpg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
    ["heic", "image/heic"],
    ["heif", "image/heif"],
  ] as const)("accepts genuine .%s style image bytes", async (extension, contentType) => {
    const service = createService() as HardenedMediaService;
    jest.spyOn(clientOf(service), "send").mockImplementation(validObject(contentType));
    const key = `style-posts/${ownerUserId}/00000000-0000-4000-8000-000000000002.${extension}`;

    await expect(service.validateStylePostImageObject(key, ownerUserId)).resolves.toBe(key);
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
