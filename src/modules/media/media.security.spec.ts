import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { ConfigService } from "@nestjs/config";
import sharp from "sharp";
import { AdmissionLimiter, type RequestOrigin } from "src/modules/admission/admission-limiter";
import { MediaErrorMessage } from "./media.error";
import { MediaService } from "./media.service";

type StorageClient = { send(command: unknown): Promise<unknown> };

const ownerUserId = "00000000-0000-4000-8000-000000000001";
const origin: RequestOrigin = { ip: "127.0.0.1", deviceId: "media-security-device" };
const pendingBucket = "dadamjang-staging-pending";
const finalBucket = "dadamjang-staging-images";

const allow = () => ({ assertAllowed: jest.fn().mockResolvedValue(undefined) }) as unknown as AdmissionLimiter;

const repository = () =>
  ({
    adoptFinalObject: jest.fn().mockResolvedValue(undefined),
    claimGarbage: jest.fn().mockResolvedValue(undefined),
    completeGarbage: jest.fn().mockResolvedValue(undefined),
    markPromotionReady: jest.fn().mockResolvedValue(undefined),
    releaseGarbage: jest.fn().mockResolvedValue(undefined),
    reservePromotion: jest.fn().mockResolvedValue(undefined),
  }) as const;

const createService = (overrides: Record<string, string | undefined> = {}) => {
  const values: Record<string, string | undefined> = {
    CLOUDFLARE_R2_BUCKET: finalBucket,
    CLOUDFLARE_R2_PENDING_BUCKET: pendingBucket,
    CLOUDFLARE_R2_PUBLIC_BASE_URL: "https://images.example.com/",
    CLOUDFLARE_IMAGES_TRANSFORM_BASE_URL: "https://images.example.com/cdn-cgi/image/",
    CLOUDFLARE_R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    CLOUDFLARE_R2_ACCESS_KEY_ID: "key",
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret",
    MEDIA_GC_WORKER_ENABLED: "false",
    ...overrides,
  };
  const configService = {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      const value = values[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;
  const Constructor = MediaService as unknown as new (
    config: ConfigService,
    limiter: AdmissionLimiter,
    mediaRepository: ReturnType<typeof repository>,
  ) => MediaService;
  return new Constructor(configService, allow(), repository());
};

const clientOf = (service: MediaService) => (service as unknown as { client: StorageClient }).client;

const metadata = (contentType: string, size: number) => ({
  "owner-id": ownerUserId,
  "declared-content-type": contentType,
  "declared-size": String(size),
});

const missingObject = () => Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });

const storedImage = (pendingKey: string, contentType: string, bytes: Uint8Array) => {
  const commands: unknown[] = [];
  const send = async (command: unknown) => {
    commands.push(command);
    if (command instanceof HeadObjectCommand) {
      if (command.input.Key === pendingKey)
        return {
          ContentType: contentType,
          ContentLength: bytes.byteLength,
          Metadata: metadata(contentType, bytes.byteLength),
          ETag: '"source-etag"',
        };
      throw missingObject();
    }
    if (command instanceof GetObjectCommand)
      return {
        ContentType: contentType,
        ContentLength: bytes.byteLength,
        ETag: '"source-etag"',
        Body: { transformToByteArray: async () => bytes },
      };
    if (command instanceof CopyObjectCommand) return { CopyObjectResult: { ETag: '"final-etag"' } };
    throw new Error("Unexpected storage command");
  };
  return { commands, send };
};

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const bombDimensions = (png: Buffer) => {
  const bomb = Buffer.from(png);
  bomb.writeUInt32BE(100_000, 16);
  bomb.writeUInt32BE(100_000, 20);
  bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
  return bomb;
};

describe("MediaService security boundaries", () => {
  let images: Record<"image/jpeg" | "image/png" | "image/webp", Buffer>;

  beforeAll(async () => {
    const source = { create: { width: 4, height: 3, channels: 4 as const, background: "#ff00ffff" } };
    const [jpeg, png, webp] = await Promise.all([
      sharp(source).jpeg().toBuffer(),
      sharp(source).png().toBuffer(),
      sharp(source).webp().toBuffer(),
    ]);
    images = { "image/jpeg": jpeg, "image/png": png, "image/webp": webp };
  });

  it.each([
    ["the same pending and public bucket", { CLOUDFLARE_R2_PENDING_BUCKET: finalBucket }],
    ["an r2.dev public origin", { CLOUDFLARE_R2_PUBLIC_BASE_URL: "https://bucket-id.r2.dev" }],
    ["a configured pending public origin", { CLOUDFLARE_R2_PENDING_PUBLIC_BASE_URL: "https://pending.example.com" }],
  ])("fails startup for %s", (_caseName, overrides) => {
    expect(() => createService(overrides)).toThrow();
  });

  it("presigns only the private pending bucket and never derives a pending delivery URL", async () => {
    const service = createService();

    const target = await service.createProductUpload(
      ownerUserId,
      { filename: "product.png", contentType: "image/png", fileSize: 1024 },
      origin,
    );

    expect(target).toMatchObject({
      imageUrl: null,
      originalUrl: null,
      key: expect.stringMatching(new RegExp(`^pending/products/${ownerUserId}/[0-9a-f-]{36}\\.png$`)),
    });
    const uploadUrl = new URL(target.uploadUrl);
    expect(uploadUrl.hostname).toContain(pendingBucket);
    expect(uploadUrl.pathname).toContain("/pending/products/");
    expect(uploadUrl.hostname).not.toContain(finalBucket);
    expect(() => service.getProductImageUrl(target.key)).toThrow(MediaErrorMessage.InvalidKey);
  });

  it.each([
    ["jpg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
  ] as const)("fully decodes and promotes a valid %s", async (extension, contentType) => {
    const service = createService();
    const key = `pending/products/${ownerUserId}/00000000-0000-4000-8000-000000000003.${extension}`;
    const storage = storedImage(key, contentType, images[contentType]);
    jest.spyOn(clientOf(service), "send").mockImplementation(storage.send);

    const finalKey = await service.validateProductImageObject(key, ownerUserId);

    expect(finalKey).toMatch(new RegExp(`^products/${ownerUserId}/[0-9a-f]{64}\\.${extension}$`));
    const read = storage.commands.find((command) => command instanceof GetObjectCommand) as GetObjectCommand;
    expect(read.input).toMatchObject({ Bucket: pendingBucket, Key: key, IfMatch: '"source-etag"' });
    expect(read.input.Range).toBeUndefined();
    const copy = storage.commands.find((command) => command instanceof CopyObjectCommand) as CopyObjectCommand;
    expect(copy.input).toMatchObject({
      Bucket: finalBucket,
      CopySource: `/${pendingBucket}/${key}`,
      CopySourceIfMatch: '"source-etag"',
      Key: finalKey,
    });
  });

  it.each([
    ["truncated JPEG", () => images["image/jpeg"].subarray(0, -2), "image/jpeg", "jpg"],
    [
      "PNG header followed by zeros",
      () => Buffer.concat([images["image/png"].subarray(0, 8), Buffer.alloc(128)]),
      "image/png",
      "png",
    ],
    [
      "JPEG polyglot suffix",
      () => Buffer.concat([images["image/jpeg"], Buffer.from("<script>x</script>")]),
      "image/jpeg",
      "jpg",
    ],
    ["decompression-bomb dimensions", () => bombDimensions(images["image/png"]), "image/png", "png"],
  ] as const)("rejects %s before promotion", async (_caseName, fixture, contentType, extension) => {
    const service = createService();
    const key = `pending/products/${ownerUserId}/00000000-0000-4000-8000-000000000003.${extension}`;
    const storage = storedImage(key, contentType, fixture());
    jest.spyOn(clientOf(service), "send").mockImplementation(storage.send);

    await expect(service.validateProductImageObject(key, ownerUserId)).rejects.toThrow(MediaErrorMessage.ObjectInvalid);
    expect(storage.commands.some((command) => command instanceof CopyObjectCommand)).toBe(false);
  });

  it("prevalidates the full batch with real decoding before copying any object", async () => {
    const service = createService();
    const validKey = `pending/products/${ownerUserId}/00000000-0000-4000-8000-000000000003.png`;
    const invalidKey = `pending/products/${ownerUserId}/00000000-0000-4000-8000-000000000004.png`;
    const valid = storedImage(validKey, "image/png", images["image/png"]);
    const invalid = storedImage(invalidKey, "image/png", Buffer.concat([images["image/png"], Buffer.from("polyglot")]));
    const commands: unknown[] = [];
    jest.spyOn(clientOf(service), "send").mockImplementation(async (command) => {
      commands.push(command);
      return command instanceof HeadObjectCommand && command.input.Key === validKey
        ? valid.send(command)
        : invalid.send(command);
    });

    await expect(service.validateProductImageObjects([validKey, invalidKey], ownerUserId)).rejects.toThrow(
      MediaErrorMessage.ObjectInvalid,
    );
    expect(commands.some((command) => command instanceof CopyObjectCommand)).toBe(false);
  });
});
