ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deactivatedAt" timestamptz;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "scheduledAnonymizationAt" timestamptz;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "anonymizedAt" timestamptz;

UPDATE "users" AS u
SET "password" = NULL
FROM "authIdentity" AS ai
WHERE ai."userId" = u."userId"
  AND ai."provider" = 'kakao'
  AND ai."createdAt" = u."createdAt"
  AND u."updatedAt" = u."createdAt"
  AND u."role" = 'USER';

ALTER TABLE "users"
  ADD CONSTRAINT "users_non_user_password_check"
    CHECK ("role" = 'USER' OR "password" IS NOT NULL),
  ADD CONSTRAINT "users_lifecycle_order_check"
    CHECK (
      (
        "deactivatedAt" IS NULL
        AND "scheduledAnonymizationAt" IS NULL
        AND "anonymizedAt" IS NULL
      )
      OR (
        "deactivatedAt" IS NOT NULL
        AND "scheduledAnonymizationAt" IS NOT NULL
        AND "scheduledAnonymizationAt" >= "deactivatedAt"
        AND "anonymizedAt" IS NULL
      )
      OR (
        "deactivatedAt" IS NOT NULL
        AND "scheduledAnonymizationAt" IS NOT NULL
        AND "anonymizedAt" IS NOT NULL
        AND "scheduledAnonymizationAt" >= "deactivatedAt"
        AND "anonymizedAt" >= "scheduledAnonymizationAt"
      )
    );

CREATE INDEX "users_due_anonymization_idx"
  ON "users" ("scheduledAnonymizationAt", "userId")
  WHERE "deactivatedAt" IS NOT NULL AND "anonymizedAt" IS NULL;

CREATE TABLE "accountReactivationTokens" (
  "tokenHash" text PRIMARY KEY,
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "deviceIdHash" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "usedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
