CREATE TABLE "requestAdmission" (
  "action" varchar(80) NOT NULL,
  "scopeType" varchar(40) NOT NULL,
  "scopeHash" varchar(64) NOT NULL,
  "requestCount" integer NOT NULL DEFAULT 1,
  "windowStartedAt" timestamp with time zone NOT NULL,
  "expiresAt" timestamp with time zone NOT NULL,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "request_admission_scope_pk" PRIMARY KEY ("action", "scopeType", "scopeHash"),
  CONSTRAINT "request_admission_count_positive" CHECK ("requestCount" > 0)
);

CREATE INDEX "request_admission_expires_idx" ON "requestAdmission" ("expiresAt");
