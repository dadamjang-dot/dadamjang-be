CREATE TABLE "emailDeliveryOutbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind" varchar(40) NOT NULL,
  "email" varchar(255) NOT NULL,
  "requestIpHash" varchar(64),
  "payloadCiphertext" text,
  "proofId" text,
  "status" varchar(20) NOT NULL DEFAULT 'PENDING',
  "attemptCount" integer NOT NULL DEFAULT 0,
  "availableAt" timestamptz NOT NULL DEFAULT now(),
  "claimedAt" timestamptz,
  "claimToken" uuid,
  "expiresAt" timestamptz NOT NULL,
  "sentAt" timestamptz,
  "lastError" varchar(500),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "email_delivery_outbox_kind_check" CHECK (
    "kind" IN ('SIGNUP_CODE', 'PASSWORD_RESET_CODE', 'PASSWORD_RESET_LINK', 'ADMIN_INVITE')
  ),
  CONSTRAINT "email_delivery_outbox_status_check" CHECK (
    "status" IN ('PENDING', 'PROCESSING', 'SENT', 'SUPPRESSED', 'FAILED')
  ),
  CONSTRAINT "email_delivery_outbox_attempt_count_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "email_delivery_outbox_claim_check" CHECK (
    ("status" = 'PROCESSING' AND "claimedAt" IS NOT NULL AND "claimToken" IS NOT NULL)
    OR ("status" <> 'PROCESSING' AND "claimedAt" IS NULL AND "claimToken" IS NULL)
  ),
  CONSTRAINT "email_delivery_outbox_payload_check" CHECK (
    ("payloadCiphertext" IS NULL AND "proofId" IS NULL)
    OR ("payloadCiphertext" IS NOT NULL AND "proofId" IS NOT NULL)
  ),
  CONSTRAINT "email_delivery_outbox_sent_check" CHECK (
    ("status" = 'SENT' AND "sentAt" IS NOT NULL)
    OR ("status" <> 'SENT' AND "sentAt" IS NULL)
  )
);

CREATE INDEX "email_delivery_outbox_pending_idx"
  ON "emailDeliveryOutbox" ("availableAt", "createdAt", "id")
  WHERE "status" = 'PENDING';

CREATE INDEX "email_delivery_outbox_processing_idx"
  ON "emailDeliveryOutbox" ("claimedAt", "createdAt", "id")
  WHERE "status" = 'PROCESSING';

CREATE INDEX "email_delivery_outbox_expiry_idx"
  ON "emailDeliveryOutbox" ("expiresAt")
  WHERE "status" IN ('PENDING', 'PROCESSING');

CREATE INDEX "email_delivery_outbox_email_created_idx"
  ON "emailDeliveryOutbox" ("email", "createdAt");
