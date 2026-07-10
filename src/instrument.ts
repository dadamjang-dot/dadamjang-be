import * as Sentry from "@sentry/nestjs";

const parseSampleRate = (value: string | undefined) => {
  const sampleRate = Number(value ?? "0.1");
  return Number.isFinite(sampleRate) ? Math.min(Math.max(sampleRate, 0), 1) : 0.1;
};

const dsn = process.env.SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
  sendDefaultPii: false,
  tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
});
