ALTER TABLE "pushOutbox"
  ADD COLUMN "rateLimitAttemptCount" integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT "push_outbox_rate_limit_attempt_count_check"
    CHECK ("rateLimitAttemptCount" BETWEEN 0 AND 8);
