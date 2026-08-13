ALTER TABLE "adminInvites" ADD COLUMN IF NOT EXISTS "revokedAt" timestamp;

CREATE INDEX IF NOT EXISTS "partners_status_created_idx" ON "partners" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "products_approval_created_idx" ON "products" ("approvalStatus", "createdAt");
CREATE INDEX IF NOT EXISTS "orders_status_created_idx" ON "orders" ("status", "createdAt");
CREATE INDEX IF NOT EXISTS "admin_invites_status_idx" ON "adminInvites" ("acceptedAt", "revokedAt", "expiresAt");
CREATE INDEX IF NOT EXISTS "audit_logs_created_idx" ON "auditLogs" ("createdAt");
