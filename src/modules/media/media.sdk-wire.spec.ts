import { createServer, type IncomingHttpHeaders, type Server } from "http";
import type { AddressInfo } from "net";
import { ConfigService } from "@nestjs/config";
import sharp from "sharp";
import { AdmissionLimiter } from "src/modules/admission/admission-limiter";
import { MediaService } from "./media.service";

type WireRequest = Readonly<{
  headers: IncomingHttpHeaders;
  method: string;
  path: string;
}>;

const ownerUserId = "00000000-0000-4000-8000-000000000001";
const pendingKey = `pending/products/${ownerUserId}/00000000-0000-4000-8000-000000000002.png`;

const listen = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe("MediaService AWS SDK wire contract", () => {
  it("sends conditional full reads and a leading-slash private-bucket copy source", async () => {
    const png = await sharp({
      create: { width: 4, height: 3, channels: 4, background: "#ff00ffff" },
    })
      .png()
      .toBuffer();
    const requests: WireRequest[] = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      requests.push({ headers: request.headers, method: request.method ?? "", path });
      const isPending = path === `/pending-bucket/${pendingKey}`;
      if (request.method === "HEAD" && isPending) {
        response.writeHead(200, {
          "content-length": png.byteLength,
          "content-type": "image/png",
          etag: '"source-etag"',
          "x-amz-meta-declared-content-type": "image/png",
          "x-amz-meta-declared-size": String(png.byteLength),
          "x-amz-meta-owner-id": ownerUserId,
        });
        response.end();
        return;
      }
      if (request.method === "GET" && isPending) {
        response.writeHead(200, {
          "content-length": png.byteLength,
          "content-type": "image/png",
          etag: '"source-etag"',
        });
        response.end(png);
        return;
      }
      if (request.method === "HEAD" && path.startsWith("/final-bucket/products/")) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === "PUT" && path.startsWith("/final-bucket/products/")) {
        const body = Buffer.from(
          '<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult><ETag>&quot;copied-etag&quot;</ETag></CopyObjectResult>',
        );
        response.writeHead(200, { "content-length": body.byteLength, "content-type": "application/xml" });
        response.end(body);
        return;
      }
      response.writeHead(500);
      response.end();
    });
    const port = await listen(server);
    const values: Record<string, string> = {
      CLOUDFLARE_R2_ACCESS_KEY_ID: "access-key",
      CLOUDFLARE_R2_BUCKET: "final-bucket",
      CLOUDFLARE_R2_ENDPOINT: `http://127.0.0.1:${port}`,
      CLOUDFLARE_R2_PENDING_BUCKET: "pending-bucket",
      CLOUDFLARE_R2_PUBLIC_BASE_URL: "https://images.example.com",
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: "secret-key",
      CLOUDFLARE_IMAGES_TRANSFORM_BASE_URL: "https://images.example.com/cdn-cgi/image",
      MEDIA_GC_WORKER_ENABLED: "false",
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
      getOrThrow: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    const repository = {
      adoptFinalObject: jest.fn(),
      claimGarbage: jest.fn(),
      completeGarbage: jest.fn(),
      markPromotionReady: jest.fn().mockResolvedValue(undefined),
      releaseGarbage: jest.fn(),
      reservePromotion: jest.fn().mockResolvedValue(undefined),
    };
    const Constructor = MediaService as unknown as new (
      configService: ConfigService,
      admissionLimiter: AdmissionLimiter,
      mediaRepository: typeof repository,
    ) => MediaService;
    const service = new Constructor(config, { assertAllowed: jest.fn() } as unknown as AdmissionLimiter, repository);

    try {
      await expect(service.validateProductImageObject(pendingKey, ownerUserId)).resolves.toMatch(
        new RegExp(`^products/${ownerUserId}/[0-9a-f]{64}\\.png$`),
      );
      expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
        { method: "HEAD", path: `/pending-bucket/${pendingKey}` },
        { method: "GET", path: `/pending-bucket/${pendingKey}` },
        { method: "HEAD", path: expect.stringMatching(/^\/final-bucket\/products\//) },
        { method: "PUT", path: expect.stringMatching(/^\/final-bucket\/products\//) },
      ]);
      expect(requests[1]?.headers).toMatchObject({ "if-match": '"source-etag"' });
      expect(requests[1]?.headers.range).toBeUndefined();
      expect(requests[3]?.headers).toMatchObject({
        "x-amz-copy-source": `/pending-bucket/${pendingKey}`,
        "x-amz-copy-source-if-match": '"source-etag"',
        "x-amz-metadata-directive": "REPLACE",
      });
    } finally {
      (service as unknown as { client: { destroy(): void } }).client.destroy();
      await close(server);
    }
  });
});
