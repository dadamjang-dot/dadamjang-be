ALTER TABLE "kakaoLoginFlows"
  ADD COLUMN "callbackTokenHash" text;

ALTER TABLE "identityVerificationSessions"
  ADD COLUMN "callbackTokenHash" text;
