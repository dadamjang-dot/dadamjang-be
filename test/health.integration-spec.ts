import type { INestApplication } from "@nestjs/common";
import { createServer, type Socket } from "net";
import request from "supertest";
import { createApp } from "src/app";

const startApp = async () => {
  const app = await createApp();
  await app.init();
  return app;
};

describe("health endpoints", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("returns exact 200 liveness independently of PostgreSQL", async () => {
    const originalPort = process.env.POSTGRES_PORT;
    process.env.POSTGRES_PORT = "1";
    try {
      app = await startApp();
    } finally {
      process.env.POSTGRES_PORT = originalPort;
    }

    await request(app.getHttpServer()).get("/health/live").expect(200, { status: "ok" });
  });

  it("returns exact 200 readiness after SELECT 1 reaches PostgreSQL", async () => {
    app = await startApp();

    await request(app.getHttpServer()).get("/health/ready").expect(200, { status: "ok" });
  });

  it("returns non-200 readiness when PostgreSQL is unavailable", async () => {
    const originalPort = process.env.POSTGRES_PORT;
    process.env.POSTGRES_PORT = "1";
    try {
      app = await startApp();
    } finally {
      process.env.POSTGRES_PORT = originalPort;
    }

    await request(app.getHttpServer()).get("/health/ready").expect(503, { status: "unavailable" });
  });

  it("returns exact 503 before five seconds when the PostgreSQL handshake stalls", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Stalled TCP server has no port");
    const originalHost = process.env.POSTGRES_HOST;
    const originalPort = process.env.POSTGRES_PORT;
    process.env.POSTGRES_HOST = "127.0.0.1";
    process.env.POSTGRES_PORT = String(address.port);

    try {
      app = await startApp();
      const startedAt = Date.now();
      const response = await request(app.getHttpServer()).get("/health/ready").timeout({ deadline: 4_500 });

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: "unavailable" });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      process.env.POSTGRES_HOST = originalHost;
      process.env.POSTGRES_PORT = originalPort;
      sockets.forEach((socket) => socket.destroy());
      await app?.close();
      app = undefined;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  }, 10_000);
});
