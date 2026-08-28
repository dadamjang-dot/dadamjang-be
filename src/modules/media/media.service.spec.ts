import { ConfigService } from "@nestjs/config";
import { MediaErrorMessage } from "./media.error";
import { MediaService } from "./media.service";

const createService = (imageTransformBaseUrl: string = "https://images.example.com/cdn-cgi/image/") => {
  const values: Record<string, string> = {
    CLOUDFLARE_R2_BUCKET: "dadamjang-staging-images",
    CLOUDFLARE_R2_PUBLIC_BASE_URL: "https://images.example.com/",
    CLOUDFLARE_IMAGES_TRANSFORM_BASE_URL: imageTransformBaseUrl,
    CLOUDFLARE_R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
    CLOUDFLARE_R2_ACCESS_KEY_ID: "key",
    CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret",
  };
  const configService = {
    getOrThrow: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
  return new MediaService(configService);
};

const validProductKey = "products/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.webp";
const ownerUserId = "00000000-0000-4000-8000-000000000001";

describe("MediaService", () => {
  it.each([
    "not-a-url",
    "http://images.example.com/cdn-cgi/image",
    "https://images.example.com/images",
    "https://images.example.com/cdn-cgi/image/width=640",
    "https://images.example.com/cdn-cgi/image?width=640",
    "https://images.example.com/cdn-cgi/image#fragment",
  ])("rejects invalid transform base %s at startup", (baseUrl) => {
    expect(() => createService(baseUrl)).toThrow("CLOUDFLARE_IMAGES_TRANSFORM_BASE_URL");
  });

  it("creates a Cloudflare Images transformation URL without exposing R2 credentials", async () => {
    const service = createService();

    await expect(service.getProductImageUrl("products/product.jpg", 640)).resolves.toBe(
      "https://images.example.com/cdn-cgi/image/format=auto,width=640/https://images.example.com/products/product.jpg",
    );
  });

  it("rejects image keys outside the product namespace", async () => {
    const service = createService();

    await expect(service.getProductImageUrl("private/product.jpg")).rejects.toThrow(MediaErrorMessage.InvalidKey);
  });

  it("scopes style post image URLs and enforces the 10MB boundary", async () => {
    const service = createService();

    const validKey = "style-posts/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002.webp";
    expect(service.getStylePostImageUrl(validKey)).toContain(validKey);
    expect(() => service.getStylePostImageUrl("style-posts/user-1/look.webp")).toThrow(MediaErrorMessage.InvalidKey);
    await expect(
      service.createStylePostUpload("user-1", {
        filename: "look.jpg",
        contentType: "image/jpeg",
        fileSize: 10 * 1024 * 1024 + 1,
      }),
    ).rejects.toThrow(MediaErrorMessage.FileTooLarge);
  });

  it("heads the configured bucket and exact product key", async () => {
    const service = createService();
    const send = jest
      .spyOn((service as unknown as { client: { send: (command: unknown) => Promise<unknown> } }).client, "send")
      .mockResolvedValue({ ContentType: "image/webp", ContentLength: 1024 });

    await service.validateProductImageObject(validProductKey, ownerUserId);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: { Bucket: "dadamjang-staging-images", Key: validProductKey },
    });
  });

  it.each([
    ["missing", () => Promise.reject(Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } }))],
    ["invalid type", () => Promise.resolve({ ContentType: "application/pdf", ContentLength: 1 })],
    ["zero size", () => Promise.resolve({ ContentType: "image/png", ContentLength: 0 })],
    ["oversize", () => Promise.resolve({ ContentType: "image/jpeg", ContentLength: 10 * 1024 * 1024 + 1 })],
  ])("rejects a %s product image object", async (_name, response) => {
    const service = createService();
    jest
      .spyOn((service as unknown as { client: { send: (command: unknown) => Promise<unknown> } }).client, "send")
      .mockImplementation(response);

    await expect(service.validateProductImageObject(validProductKey, ownerUserId)).rejects.toThrow(
      MediaErrorMessage.ObjectInvalid,
    );
  });

  it("rejects another user's key without issuing HeadObject", async () => {
    const service = createService();
    const send = jest.spyOn(
      (service as unknown as { client: { send: (command: unknown) => Promise<unknown> } }).client,
      "send",
    );

    await expect(
      service.validateProductImageObject(validProductKey, "00000000-0000-4000-8000-000000000099"),
    ).rejects.toThrow(MediaErrorMessage.InvalidKey);
    expect(send).not.toHaveBeenCalled();
  });

  it("propagates unexpected object storage failures", async () => {
    const service = createService();
    const error = new Error("object storage unavailable");
    jest
      .spyOn((service as unknown as { client: { send: (command: unknown) => Promise<unknown> } }).client, "send")
      .mockRejectedValue(error);

    await expect(service.validateProductImageObject(validProductKey, ownerUserId)).rejects.toBe(error);
  });
});
