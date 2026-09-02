DELETE FROM "emailDeliveryOutbox"
WHERE "kind" = 'PASSWORD_RESET_LINK';

ALTER TABLE "emailDeliveryOutbox"
  DROP CONSTRAINT "email_delivery_outbox_kind_check";

ALTER TABLE "emailDeliveryOutbox"
  ADD CONSTRAINT "email_delivery_outbox_kind_check"
  CHECK ("kind" IN ('SIGNUP_CODE', 'PASSWORD_RESET_CODE', 'ADMIN_INVITE'));

DROP TABLE "passwordResetToken";
