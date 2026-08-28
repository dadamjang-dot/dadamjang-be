import type { INestApplication } from "@nestjs/common";
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
});
