import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { SentryGlobalFilter } from "@sentry/nestjs/setup";
import cookieParser from "cookie-parser";
import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import passport from "passport";
import { DatadogLogger } from "src/common/logging/datadog-logger";
import { AppModule } from "src/modules/app.module";

export const createApp = async () => {
  const app = await NestFactory.create(AppModule, { logger: new DatadogLogger() });
  const logger = new Logger("Http");
  app.useGlobalFilters(new SentryGlobalFilter(app.getHttpAdapter()));
  app
    .getHttpAdapter()
    .getInstance()
    .set("trust proxy", process.env.TRUST_PROXY === "true");
  app.use(cookieParser());
  app.use(passport.initialize());
  app.use((req: Request, res: Response, next: NextFunction) => {
    const requestId = String(req.headers["x-request-id"] ?? randomUUID());
    const startedAt = Date.now();
    res.setHeader("x-request-id", requestId);
    res.on("finish", () => {
      logger.log(
        JSON.stringify({
          event: "http_request",
          requestId,
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Date.now() - startedAt,
        }),
      );
    });
    next();
  });
  app.enableCors({
    origin: [process.env.CLIENT_URL, process.env.DADAMJANG_BO_URL].filter((origin): origin is string => !!origin),
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    allowedHeaders: "Content-Type, Authorization, x-device-id, sentry-trace, baggage",
    credentials: true,
  });
  return app;
};
