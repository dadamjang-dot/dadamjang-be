CREATE TABLE "notifications" (
  "notificationId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL,
  "type" varchar(30) NOT NULL,
  "title" varchar(160) NOT NULL,
  "body" varchar(500) NOT NULL,
  "route" varchar(500) NOT NULL,
  "entityId" uuid NOT NULL,
  "dedupeKey" varchar(500) NOT NULL,
  "readAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notifications_user_fk"
    FOREIGN KEY ("userId") REFERENCES "users"("userId"),
  CONSTRAINT "notifications_user_dedupe_unique"
    UNIQUE ("userId", "dedupeKey"),
  CONSTRAINT "notifications_type_check"
    CHECK ("type" IN ('ORDER_STATUS', 'WISH_PRICE_DROP', 'WISH_RESTOCK', 'STYLE_LIKE'))
);

CREATE INDEX "notifications_user_created_idx"
  ON "notifications" ("userId", "createdAt" DESC, "notificationId" DESC);

CREATE INDEX "notifications_user_unread_idx"
  ON "notifications" ("userId", "createdAt" DESC, "notificationId" DESC)
  WHERE "readAt" IS NULL;

CREATE TABLE "pushDevices" (
  "pushDeviceId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL,
  "installationId" varchar(255) NOT NULL,
  "expoPushToken" varchar(255) NOT NULL,
  "platform" varchar(20) NOT NULL,
  "disabledAt" timestamptz,
  "disabledReason" varchar(80),
  "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "push_devices_user_fk"
    FOREIGN KEY ("userId") REFERENCES "users"("userId"),
  CONSTRAINT "push_devices_installation_unique"
    UNIQUE ("installationId"),
  CONSTRAINT "push_devices_expo_token_unique"
    UNIQUE ("expoPushToken"),
  CONSTRAINT "push_devices_platform_check"
    CHECK ("platform" IN ('IOS', 'ANDROID')),
  CONSTRAINT "push_devices_disable_check"
    CHECK (
      ("disabledAt" IS NULL AND "disabledReason" IS NULL)
      OR ("disabledAt" IS NOT NULL AND "disabledReason" IS NOT NULL)
    )
);

CREATE INDEX "push_devices_user_state_idx"
  ON "pushDevices" ("userId", "disabledAt", "pushDeviceId");

CREATE TABLE "notificationPreferences" (
  "userId" uuid PRIMARY KEY,
  "pushEnabled" boolean NOT NULL DEFAULT true,
  "orderPushEnabled" boolean NOT NULL DEFAULT true,
  "wishPushEnabled" boolean NOT NULL DEFAULT true,
  "stylePushEnabled" boolean NOT NULL DEFAULT true,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "notification_preferences_user_fk"
    FOREIGN KEY ("userId") REFERENCES "users"("userId")
);

CREATE TABLE "pushOutbox" (
  "pushOutboxId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "notificationId" uuid NOT NULL,
  "pushDeviceId" uuid NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'PENDING',
  "attemptCount" integer NOT NULL DEFAULT 0,
  "availableAt" timestamptz NOT NULL DEFAULT now(),
  "claimToken" uuid,
  "claimedAt" timestamptz,
  "expoTicketId" varchar(255),
  "receiptAvailableAt" timestamptz,
  "lastError" varchar(500),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "push_outbox_notification_fk"
    FOREIGN KEY ("notificationId") REFERENCES "notifications"("notificationId") ON DELETE CASCADE,
  CONSTRAINT "push_outbox_device_fk"
    FOREIGN KEY ("pushDeviceId") REFERENCES "pushDevices"("pushDeviceId") ON DELETE CASCADE,
  CONSTRAINT "push_outbox_notification_device_unique"
    UNIQUE ("notificationId", "pushDeviceId"),
  CONSTRAINT "push_outbox_status_check"
    CHECK ("status" IN ('PENDING', 'PROCESSING', 'TICKETED', 'RECEIPT_OK', 'FAILED')),
  CONSTRAINT "push_outbox_attempt_count_check"
    CHECK ("attemptCount" >= 0),
  CONSTRAINT "push_outbox_claim_check"
    CHECK (
      ("status" = 'PROCESSING' AND "claimToken" IS NOT NULL AND "claimedAt" IS NOT NULL)
      OR ("status" <> 'PROCESSING' AND "claimToken" IS NULL AND "claimedAt" IS NULL)
    ),
  CONSTRAINT "push_outbox_ticket_pair_check"
    CHECK (
      ("expoTicketId" IS NULL AND "receiptAvailableAt" IS NULL)
      OR ("expoTicketId" IS NOT NULL AND "receiptAvailableAt" IS NOT NULL)
    ),
  CONSTRAINT "push_outbox_ticket_state_check"
    CHECK (
      ("status" <> 'PENDING' OR "expoTicketId" IS NULL)
      AND ("status" NOT IN ('TICKETED', 'RECEIPT_OK') OR "expoTicketId" IS NOT NULL)
    )
);

CREATE INDEX "push_outbox_pending_idx"
  ON "pushOutbox" ("availableAt", "createdAt", "pushOutboxId")
  WHERE "status" = 'PENDING';

CREATE INDEX "push_outbox_ticketed_receipt_idx"
  ON "pushOutbox" ("receiptAvailableAt", "createdAt", "pushOutboxId")
  WHERE "status" = 'TICKETED';

CREATE INDEX "push_outbox_processing_idx"
  ON "pushOutbox" ("claimedAt", "createdAt", "pushOutboxId")
  WHERE "status" = 'PROCESSING';

CREATE INDEX "push_outbox_terminal_updated_idx"
  ON "pushOutbox" ("updatedAt", "pushOutboxId")
  WHERE "status" IN ('RECEIPT_OK', 'FAILED');

CREATE INDEX "push_outbox_device_status_idx"
  ON "pushOutbox" ("pushDeviceId", "status", "pushOutboxId");
