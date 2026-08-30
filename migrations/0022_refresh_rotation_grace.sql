CREATE TABLE "refreshTokenRotationMarker" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL,
  "deviceId" varchar(255) NOT NULL,
  "rotationKey" text NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "refresh_token_rotation_marker_session_fk"
    FOREIGN KEY ("userId", "deviceId")
    REFERENCES "refreshToken" ("userId", "deviceId")
    ON DELETE CASCADE,
  CONSTRAINT "refresh_token_rotation_marker_session_key_unique"
    UNIQUE ("userId", "deviceId", "rotationKey")
);

CREATE INDEX "refresh_token_rotation_marker_expires_idx"
  ON "refreshTokenRotationMarker" ("expiresAt", "id");
