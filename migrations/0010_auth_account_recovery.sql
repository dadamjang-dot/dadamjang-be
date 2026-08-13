DO $$
BEGIN
  IF EXISTS (
    SELECT lower("email")
    FROM "users"
    GROUP BY lower("email")
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'users contains case-insensitive duplicate emails';
  END IF;
END
$$;

UPDATE "users" SET "email" = lower("email") WHERE "email" <> lower("email");

CREATE UNIQUE INDEX "users_email_lower_unique" ON "users" (lower("email"));

ALTER TABLE "emailVerification"
  ADD COLUMN "purpose" varchar(30) NOT NULL DEFAULT 'SIGNUP';
ALTER TABLE "emailVerificationToken"
  ADD COLUMN "purpose" varchar(30) NOT NULL DEFAULT 'SIGNUP';
CREATE INDEX "email_verification_email_purpose_created_idx"
  ON "emailVerification" ("email", "purpose", "createdAt");

CREATE TABLE "consentDocuments" (
  "documentId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "type" varchar(40) NOT NULL,
  "title" varchar(160) NOT NULL,
  "body" text NOT NULL,
  "version" varchar(40) NOT NULL,
  "required" boolean NOT NULL,
  "activeFrom" timestamp NOT NULL,
  "activeUntil" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "consent_documents_type_version_unique" UNIQUE ("type", "version")
);
CREATE INDEX "consent_documents_active_idx"
  ON "consentDocuments" ("activeFrom", "activeUntil", "type");

CREATE TABLE "userConsentAcceptances" (
  "acceptanceId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "documentId" uuid NOT NULL REFERENCES "consentDocuments"("documentId"),
  "agreed" boolean NOT NULL,
  "agreedAt" timestamp,
  "recordedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "user_consent_acceptances_user_document_unique" UNIQUE ("userId", "documentId")
);
CREATE INDEX "user_consent_acceptances_user_recorded_idx"
  ON "userConsentAcceptances" ("userId", "recordedAt");

CREATE TABLE "identityVerificationSessions" (
  "sessionId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "purpose" varchar(30) NOT NULL,
  "provider" varchar(20) NOT NULL,
  "deviceIdHash" text NOT NULL,
  "merchantTransactionId" varchar(20) NOT NULL UNIQUE,
  "providerTransactionId" varchar(40),
  "status" varchar(20) NOT NULL DEFAULT 'PENDING',
  "failureCode" varchar(80),
  "ciHash" text,
  "certificateProvider" varchar(20),
  "isFourteenOrOlder" boolean,
  "proofTokenHash" text UNIQUE,
  "expiresAt" timestamp NOT NULL,
  "verifiedAt" timestamp,
  "completedAt" timestamp,
  "consumedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "identity_verification_device_status_idx"
  ON "identityVerificationSessions" ("deviceIdHash", "status", "expiresAt");

CREATE TABLE "verifiedIdentities" (
  "verifiedIdentityId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL UNIQUE REFERENCES "users"("userId") ON DELETE CASCADE,
  "ciHash" text NOT NULL UNIQUE,
  "certificateProvider" varchar(20) NOT NULL,
  "verifiedAt" timestamp NOT NULL
);

CREATE TABLE "kakaoLoginFlows" (
  "flowId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "deviceIdHash" text NOT NULL,
  "providerUserId" varchar(255),
  "email" varchar(255),
  "emailVerified" boolean NOT NULL DEFAULT false,
  "userId" uuid REFERENCES "users"("userId") ON DELETE CASCADE,
  "status" varchar(30) NOT NULL DEFAULT 'PENDING',
  "expiresAt" timestamp NOT NULL,
  "callbackAt" timestamp,
  "consumedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "kakao_login_flows_device_status_idx"
  ON "kakaoLoginFlows" ("deviceIdHash", "status", "expiresAt");

ALTER TABLE "kakaoSignupToken"
  ADD COLUMN "deviceIdHash" text,
  ADD COLUMN "emailVerified" boolean NOT NULL DEFAULT false;
