CREATE INDEX "email_delivery_outbox_terminal_updated_idx"
  ON "emailDeliveryOutbox" ("updatedAt", "id")
  WHERE "status" IN ('SENT', 'SUPPRESSED', 'FAILED');
