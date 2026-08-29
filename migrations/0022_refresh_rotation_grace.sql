ALTER TABLE "refreshToken"
  ADD COLUMN "lastRotationKey" text,
  ADD COLUMN "lastRotationExpiresAt" timestamp;

ALTER TABLE "refreshToken"
  ADD CONSTRAINT "refresh_token_rotation_marker_check" CHECK (
    ("lastRotationKey" IS NULL AND "lastRotationExpiresAt" IS NULL)
    OR ("lastRotationKey" IS NOT NULL AND "lastRotationExpiresAt" IS NOT NULL)
  );
