CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE "users" (
  "userId" uuid PRIMARY KEY,
  "userid" varchar(40) NOT NULL UNIQUE,
  "email" varchar(255) NOT NULL UNIQUE,
  "password" text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "refreshToken" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId"),
  "deviceId" varchar(255) NOT NULL,
  "refreshToken" text NOT NULL,
  "refreshTokenExp" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("userId", "deviceId")
);

CREATE TABLE "emailVerification" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" varchar(255) NOT NULL,
  "codeHash" text NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "verifiedAt" timestamp,
  "attemptCount" integer NOT NULL DEFAULT 0,
  "requestIpHash" text,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "emailVerificationToken" (
  "tokenHash" text PRIMARY KEY,
  "email" varchar(255) NOT NULL,
  "verificationId" uuid NOT NULL REFERENCES "emailVerification"("id"),
  "expiresAt" timestamp NOT NULL,
  "usedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "passwordResetToken" (
  "tokenHash" text PRIMARY KEY,
  "userId" uuid NOT NULL REFERENCES "users"("userId"),
  "expiresAt" timestamp NOT NULL,
  "usedAt" timestamp,
  "requestIpHash" text,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "authIdentity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId"),
  "provider" varchar(50) NOT NULL,
  "providerUserId" varchar(255) NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("provider", "providerUserId")
);

CREATE TABLE "kakaoSignupToken" (
  "tokenHash" text PRIMARY KEY,
  "providerUserId" varchar(255) NOT NULL,
  "email" varchar(255),
  "expiresAt" timestamp NOT NULL,
  "usedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
