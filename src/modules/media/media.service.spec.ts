import { ConfigService } from "@nestjs/config";
import { MediaErrorMessage } from "./media.error";
import { MediaService } from "./media.service";

const createService = () => {
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
  return new MediaService(configService);
};

describe("MediaService", () => {
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
});
