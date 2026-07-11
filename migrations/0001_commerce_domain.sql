ALTER TABLE "users" ADD COLUMN "role" varchar(20) NOT NULL DEFAULT 'USER';

CREATE TABLE "categories" (
  "categoryId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(100) NOT NULL,
  "slug" varchar(120) NOT NULL UNIQUE,
  "parentId" uuid,
  "sortOrder" integer NOT NULL DEFAULT 0,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "categories_parent_sort_idx" ON "categories" ("parentId", "sortOrder");

CREATE TABLE "partners" (
  "partnerId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ownerUserId" uuid NOT NULL REFERENCES "users"("userId"),
  "businessEmail" varchar(255) NOT NULL UNIQUE,
  "businessRegistrationNumber" varchar(20) NOT NULL UNIQUE,
  "tradeName" varchar(160) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'PENDING',
  "rejectionReason" text,
  "reviewedByUserId" uuid REFERENCES "users"("userId"),
  "reviewedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "partners_status_idx" ON "partners" ("status");

CREATE TABLE "products" (
  "productId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "partnerId" uuid NOT NULL REFERENCES "partners"("partnerId"),
  "categoryId" uuid NOT NULL REFERENCES "categories"("categoryId"),
  "title" varchar(200) NOT NULL,
  "description" text NOT NULL,
  "imageUrls" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" varchar(20) NOT NULL DEFAULT 'DRAFT',
  "approvalStatus" varchar(20) NOT NULL DEFAULT 'PENDING',
  "rejectionReason" text,
  "publishedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "products_catalog_idx" ON "products" ("status", "categoryId", "createdAt");
CREATE INDEX "products_partner_idx" ON "products" ("partnerId", "status");

CREATE TABLE "productSkus" (
  "skuId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "productId" uuid NOT NULL REFERENCES "products"("productId"),
  "code" varchar(80) NOT NULL UNIQUE,
  "optionName" varchar(160) NOT NULL,
  "price" integer NOT NULL CHECK ("price" >= 0),
  "stock" integer NOT NULL DEFAULT 0 CHECK ("stock" >= 0),
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "product_skus_product_idx" ON "productSkus" ("productId", "isActive");

CREATE TABLE "wishlists" (
  "wishlistId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId"),
  "productId" uuid NOT NULL REFERENCES "products"("productId"),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("userId", "productId")
);
CREATE INDEX "wishlists_user_created_idx" ON "wishlists" ("userId", "createdAt");

CREATE TABLE "comparisonItems" (
  "comparisonItemId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId"),
  "productId" uuid NOT NULL REFERENCES "products"("productId"),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("userId", "productId")
);
CREATE INDEX "comparison_items_user_created_idx" ON "comparisonItems" ("userId", "createdAt");

CREATE TABLE "carts" (
  "cartId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL UNIQUE REFERENCES "users"("userId"),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE TABLE "cartItems" (
  "cartItemId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "cartId" uuid NOT NULL REFERENCES "carts"("cartId"),
  "skuId" uuid NOT NULL REFERENCES "productSkus"("skuId"),
  "quantity" integer NOT NULL CHECK ("quantity" > 0),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("cartId", "skuId")
);

CREATE TABLE "orders" (
  "orderId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "orderNumber" varchar(40) NOT NULL UNIQUE,
  "userId" uuid NOT NULL REFERENCES "users"("userId"),
  "status" varchar(30) NOT NULL DEFAULT 'PAYMENT_PENDING',
  "paymentStatus" varchar(30) NOT NULL DEFAULT 'PENDING',
  "totalAmount" integer NOT NULL CHECK ("totalAmount" >= 0),
  "paymentFailureReason" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "orders_user_created_idx" ON "orders" ("userId", "createdAt");
CREATE TABLE "orderItems" (
  "orderItemId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "orderId" uuid NOT NULL REFERENCES "orders"("orderId"),
  "productId" uuid NOT NULL REFERENCES "products"("productId"),
  "skuId" uuid NOT NULL REFERENCES "productSkus"("skuId"),
  "productTitle" varchar(200) NOT NULL,
  "skuOptionName" varchar(160) NOT NULL,
  "unitPrice" integer NOT NULL CHECK ("unitPrice" >= 0),
  "quantity" integer NOT NULL CHECK ("quantity" > 0),
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE "checkoutIdempotencyKeys" (
  "checkoutIdempotencyKeyId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId"),
  "idempotencyKey" varchar(120) NOT NULL,
  "orderId" uuid REFERENCES "orders"("orderId"),
  "status" varchar(30) NOT NULL DEFAULT 'PROCESSING',
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("userId", "idempotencyKey")
);
CREATE INDEX "checkout_idempotency_order_idx" ON "checkoutIdempotencyKeys" ("orderId");

CREATE TABLE "adminInvites" (
  "inviteId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" varchar(255) NOT NULL UNIQUE,
  "tokenHash" text NOT NULL UNIQUE,
  "invitedByUserId" uuid NOT NULL REFERENCES "users"("userId"),
  "expiresAt" timestamp NOT NULL,
  "acceptedByUserId" uuid REFERENCES "users"("userId"),
  "acceptedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "admin_invites_expiry_idx" ON "adminInvites" ("expiresAt");

CREATE TABLE "activityEvents" (
  "eventId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actorUserId" uuid REFERENCES "users"("userId"),
  "eventType" varchar(80) NOT NULL,
  "subjectType" varchar(80) NOT NULL,
  "subjectId" varchar(255) NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "activity_events_actor_created_idx" ON "activityEvents" ("actorUserId", "createdAt");
CREATE INDEX "activity_events_subject_idx" ON "activityEvents" ("subjectType", "subjectId");

CREATE TABLE "auditLogs" (
  "auditLogId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actorUserId" uuid REFERENCES "users"("userId"),
  "action" varchar(100) NOT NULL,
  "entityType" varchar(80) NOT NULL,
  "entityId" varchar(255) NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "audit_logs_entity_idx" ON "auditLogs" ("entityType", "entityId");
CREATE INDEX "audit_logs_actor_created_idx" ON "auditLogs" ("actorUserId", "createdAt");
