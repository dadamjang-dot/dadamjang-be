import { NestFactory } from "@nestjs/core";
import { AppModule } from "./modules/app.module";
import { Logger } from "@nestjs/common";
import cookieParser from "cookie-parser";
import passport from "passport";
import { randomUUID } from "crypto";
import { DatadogLogger } from "src/common/logging/datadog-logger";

/**
 * Nest 애플리케이션을 생성하고 HTTP 서버를 시작한다.
 *
 * @returns 서버 시작 완료 Promise
 */
const bootstrap = async () => {
  const app = await NestFactory.create(AppModule, { logger: new DatadogLogger() });
  const logger = new Logger("Http");

  app
    .getHttpAdapter()
    .getInstance()
    .set("trust proxy", process.env.TRUST_PROXY === "true");
  app.use(cookieParser());
  app.use(passport.initialize());
  app.use((req, res, next) => {
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
    origin: process.env.CLIENT_URL,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    credentials: true,
  });

  await app.listen(5500);
};

bootstrap();
