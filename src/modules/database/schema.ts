import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  userId: uuid("userId").primaryKey(),
  userid: varchar("userid", { length: 40 }).notNull().unique(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password: text("password").notNull(),
  role: varchar("role", { length: 20 }).notNull().default("USER"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const refreshTokens = pgTable(
  "refreshToken",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    deviceId: varchar("deviceId", { length: 255 }).notNull(),
    refreshToken: text("refreshToken").notNull(),
    refreshTokenExp: timestamp("refreshTokenExp").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [unique("refreshToken_userId_deviceId_unique").on(table.userId, table.deviceId)],
);

export const refreshTokenRotationMarkers = pgTable(
  "refreshTokenRotationMarker",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId").notNull(),
    deviceId: varchar("deviceId", { length: 255 }).notNull(),
    rotationKey: text("rotationKey").notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId, table.deviceId],
      foreignColumns: [refreshTokens.userId, refreshTokens.deviceId],
      name: "refresh_token_rotation_marker_session_fk",
    }).onDelete("cascade"),
    unique("refresh_token_rotation_marker_session_key_unique").on(table.userId, table.deviceId, table.rotationKey),
    index("refresh_token_rotation_marker_expires_idx").on(table.expiresAt, table.id),
  ],
);

export const authIdentities = pgTable(
  "authIdentity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    provider: varchar("provider", { length: 50 }).notNull(),
    providerUserId: varchar("providerUserId", { length: 255 }).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [unique("authIdentity_provider_providerUserId_unique").on(table.provider, table.providerUserId)],
);

export const emailVerifications = pgTable("emailVerification", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull(),
  purpose: varchar("purpose", { length: 30 }).notNull().default("SIGNUP"),
  codeHash: text("codeHash").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  verifiedAt: timestamp("verifiedAt"),
  attemptCount: integer("attemptCount").notNull().default(0),
  requestIpHash: text("requestIpHash"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const emailVerificationTokens = pgTable("emailVerificationToken", {
  tokenHash: text("tokenHash").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  purpose: varchar("purpose", { length: 30 }).notNull().default("SIGNUP"),
  verificationId: uuid("verificationId")
    .notNull()
    .references(() => emailVerifications.id),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const passwordResetTokens = pgTable("passwordResetToken", {
  tokenHash: text("tokenHash").primaryKey(),
  userId: uuid("userId")
    .notNull()
    .references(() => users.userId),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  requestIpHash: text("requestIpHash"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const requestAdmissions = pgTable(
  "requestAdmission",
  {
    action: varchar("action", { length: 80 }).notNull(),
    scopeType: varchar("scopeType", { length: 40 }).notNull(),
    scopeHash: varchar("scopeHash", { length: 64 }).notNull(),
    requestCount: integer("requestCount").notNull().default(1),
    windowStartedAt: timestamp("windowStartedAt", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.action, table.scopeType, table.scopeHash],
      name: "request_admission_scope_pk",
    }),
    check("request_admission_count_positive", sql`${table.requestCount} > 0`),
    index("request_admission_expires_idx").on(table.expiresAt),
  ],
);

export const emailDeliveryOutbox = pgTable(
  "emailDeliveryOutbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: varchar("kind", { length: 40 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    requestIpHash: varchar("requestIpHash", { length: 64 }),
    payloadCiphertext: text("payloadCiphertext"),
    proofId: text("proofId"),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    attemptCount: integer("attemptCount").notNull().default(0),
    availableAt: timestamp("availableAt", { withTimezone: true }).defaultNow().notNull(),
    claimedAt: timestamp("claimedAt", { withTimezone: true }),
    claimToken: uuid("claimToken"),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    sentAt: timestamp("sentAt", { withTimezone: true }),
    lastError: varchar("lastError", { length: 500 }),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "email_delivery_outbox_kind_check",
      sql`${table.kind} IN ('SIGNUP_CODE', 'PASSWORD_RESET_CODE', 'PASSWORD_RESET_LINK', 'ADMIN_INVITE')`,
    ),
    check(
      "email_delivery_outbox_status_check",
      sql`${table.status} IN ('PENDING', 'PROCESSING', 'SENT', 'SUPPRESSED', 'FAILED')`,
    ),
    check("email_delivery_outbox_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check(
      "email_delivery_outbox_claim_check",
      sql`(${table.status} = 'PROCESSING' AND ${table.claimedAt} IS NOT NULL AND ${table.claimToken} IS NOT NULL)
        OR (${table.status} <> 'PROCESSING' AND ${table.claimedAt} IS NULL AND ${table.claimToken} IS NULL)`,
    ),
    check(
      "email_delivery_outbox_payload_check",
      sql`(${table.payloadCiphertext} IS NULL AND ${table.proofId} IS NULL)
        OR (${table.payloadCiphertext} IS NOT NULL AND ${table.proofId} IS NOT NULL)`,
    ),
    check(
      "email_delivery_outbox_sent_check",
      sql`(${table.status} = 'SENT' AND ${table.sentAt} IS NOT NULL)
        OR (${table.status} <> 'SENT' AND ${table.sentAt} IS NULL)`,
    ),
    index("email_delivery_outbox_pending_idx")
      .on(table.availableAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'PENDING'`),
    index("email_delivery_outbox_processing_idx")
      .on(table.claimedAt, table.createdAt, table.id)
      .where(sql`${table.status} = 'PROCESSING'`),
    index("email_delivery_outbox_expiry_idx")
      .on(table.expiresAt)
      .where(sql`${table.status} IN ('PENDING', 'PROCESSING')`),
    index("email_delivery_outbox_terminal_updated_idx")
      .on(table.updatedAt, table.id)
      .where(sql`${table.status} IN ('SENT', 'SUPPRESSED', 'FAILED')`),
    index("email_delivery_outbox_email_created_idx").on(table.email, table.createdAt),
  ],
);

export const mediaObjectPromotions = pgTable(
  "mediaObjectPromotions",
  {
    finalKey: text("finalKey").primaryKey(),
    ownerUserId: uuid("ownerUserId").notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    contentType: varchar("contentType", { length: 80 }).notNull(),
    objectSize: integer("objectSize"),
    finalEtag: text("finalEtag"),
    sourceBucket: varchar("sourceBucket", { length: 255 }),
    sourceKey: text("sourceKey"),
    sourceEtag: text("sourceEtag"),
    status: varchar("status", { length: 20 }).notNull(),
    unreferencedAt: timestamp("unreferencedAt", { withTimezone: true }),
    readyAt: timestamp("readyAt", { withTimezone: true }),
    gcClaimedAt: timestamp("gcClaimedAt", { withTimezone: true }),
    gcClaimToken: uuid("gcClaimToken"),
    gcPreviousStatus: varchar("gcPreviousStatus", { length: 20 }),
    deletedAt: timestamp("deletedAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("media_object_promotions_kind_check", sql`${table.kind} IN ('PRODUCT', 'STYLE_POST')`),
    check(
      "media_object_promotions_status_check",
      sql`${table.status} IN ('PREPARING', 'READY', 'DELETING', 'DELETED')`,
    ),
    check("media_object_promotions_size_check", sql`${table.objectSize} IS NULL OR ${table.objectSize} > 0`),
    check(
      "media_object_promotions_source_check",
      sql`(${table.sourceBucket} IS NULL AND ${table.sourceKey} IS NULL AND ${table.sourceEtag} IS NULL)
        OR (${table.sourceBucket} IS NOT NULL AND ${table.sourceKey} IS NOT NULL AND ${table.sourceEtag} IS NOT NULL)`,
    ),
    check(
      "media_object_promotions_gc_claim_check",
      sql`(
          ${table.status} = 'DELETING'
          AND ${table.gcClaimedAt} IS NOT NULL
          AND ${table.gcClaimToken} IS NOT NULL
          AND ${table.gcPreviousStatus} IN ('PREPARING', 'READY')
        ) OR (
          ${table.status} <> 'DELETING'
          AND ${table.gcClaimedAt} IS NULL
          AND ${table.gcClaimToken} IS NULL
          AND ${table.gcPreviousStatus} IS NULL
        )`,
    ),
    check(
      "media_object_promotions_deleted_check",
      sql`(${table.status} = 'DELETED' AND ${table.deletedAt} IS NOT NULL)
        OR (${table.status} <> 'DELETED' AND ${table.deletedAt} IS NULL)`,
    ),
    index("media_object_promotions_gc_idx")
      .on(table.unreferencedAt, table.createdAt, table.finalKey)
      .where(sql`${table.status} IN ('PREPARING', 'READY')`),
    index("media_object_promotions_stale_claim_idx")
      .on(table.gcClaimedAt, table.finalKey)
      .where(sql`${table.status} = 'DELETING'`),
  ],
);

export const mediaObjectReferences = pgTable(
  "mediaObjectReferences",
  {
    entityType: varchar("entityType", { length: 20 }).notNull(),
    entityId: uuid("entityId").notNull(),
    finalKey: text("finalKey")
      .notNull()
      .references(() => mediaObjectPromotions.finalKey, { onDelete: "restrict" }),
    createdAt: timestamp("createdAt", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.entityType, table.entityId, table.finalKey],
      name: "media_object_references_pk",
    }),
    check("media_object_references_entity_type_check", sql`${table.entityType} IN ('PRODUCT', 'STYLE_POST')`),
    index("media_object_references_final_key_idx").on(table.finalKey),
  ],
);

export const kakaoSignupTokens = pgTable("kakaoSignupToken", {
  tokenHash: text("tokenHash").primaryKey(),
  providerUserId: varchar("providerUserId", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  deviceIdHash: text("deviceIdHash"),
  emailVerified: boolean("emailVerified").notNull().default(false),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const consentDocuments = pgTable(
  "consentDocuments",
  {
    documentId: uuid("documentId").primaryKey().defaultRandom(),
    type: varchar("type", { length: 40 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    body: text("body").notNull(),
    version: varchar("version", { length: 40 }).notNull(),
    required: boolean("required").notNull(),
    activeFrom: timestamp("activeFrom").notNull(),
    activeUntil: timestamp("activeUntil"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    unique("consent_documents_type_version_unique").on(table.type, table.version),
    index("consent_documents_active_idx").on(table.activeFrom, table.activeUntil, table.type),
  ],
);

export const userConsentAcceptances = pgTable(
  "userConsentAcceptances",
  {
    acceptanceId: uuid("acceptanceId").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    documentId: uuid("documentId")
      .notNull()
      .references(() => consentDocuments.documentId),
    agreed: boolean("agreed").notNull(),
    agreedAt: timestamp("agreedAt"),
    recordedAt: timestamp("recordedAt").defaultNow().notNull(),
  },
  (table) => [
    unique("user_consent_acceptances_user_document_unique").on(table.userId, table.documentId),
    index("user_consent_acceptances_user_recorded_idx").on(table.userId, table.recordedAt),
  ],
);

export const identityVerificationSessions = pgTable(
  "identityVerificationSessions",
  {
    sessionId: uuid("sessionId").primaryKey().defaultRandom(),
    purpose: varchar("purpose", { length: 30 }).notNull(),
    provider: varchar("provider", { length: 20 }).notNull(),
    deviceIdHash: text("deviceIdHash").notNull(),
    merchantTransactionId: varchar("merchantTransactionId", { length: 20 }).notNull().unique(),
    providerTransactionId: varchar("providerTransactionId", { length: 40 }),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    failureCode: varchar("failureCode", { length: 80 }),
    ciHash: text("ciHash"),
    certificateProvider: varchar("certificateProvider", { length: 20 }),
    isFourteenOrOlder: boolean("isFourteenOrOlder"),
    callbackTokenHash: text("callbackTokenHash"),
    proofTokenHash: text("proofTokenHash").unique(),
    expiresAt: timestamp("expiresAt").notNull(),
    verifiedAt: timestamp("verifiedAt"),
    completedAt: timestamp("completedAt"),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    index("identity_verification_device_status_idx").on(table.deviceIdHash, table.status, table.expiresAt),
    index("identity_verification_cleanup_expires_idx").on(table.expiresAt, table.sessionId),
    index("identity_verification_cleanup_consumed_idx")
      .on(table.consumedAt, table.sessionId)
      .where(sql`${table.consumedAt} IS NOT NULL`),
  ],
);

export const verifiedIdentities = pgTable("verifiedIdentities", {
  verifiedIdentityId: uuid("verifiedIdentityId").primaryKey().defaultRandom(),
  userId: uuid("userId")
    .notNull()
    .unique()
    .references(() => users.userId, { onDelete: "cascade" }),
  ciHash: text("ciHash").notNull().unique(),
  certificateProvider: varchar("certificateProvider", { length: 20 }).notNull(),
  verifiedAt: timestamp("verifiedAt").notNull(),
});

export const kakaoLoginFlows = pgTable(
  "kakaoLoginFlows",
  {
    flowId: uuid("flowId").primaryKey().defaultRandom(),
    deviceIdHash: text("deviceIdHash").notNull(),
    providerUserId: varchar("providerUserId", { length: 255 }),
    email: varchar("email", { length: 255 }),
    emailVerified: boolean("emailVerified").notNull().default(false),
    userId: uuid("userId").references(() => users.userId, { onDelete: "cascade" }),
    status: varchar("status", { length: 30 }).notNull().default("PENDING"),
    callbackTokenHash: text("callbackTokenHash"),
    expiresAt: timestamp("expiresAt").notNull(),
    callbackAt: timestamp("callbackAt"),
    consumedAt: timestamp("consumedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    index("kakao_login_flows_device_status_idx").on(table.deviceIdHash, table.status, table.expiresAt),
    index("kakao_login_flows_cleanup_expires_idx").on(table.expiresAt, table.flowId),
    index("kakao_login_flows_cleanup_consumed_idx")
      .on(table.consumedAt, table.flowId)
      .where(sql`${table.consumedAt} IS NOT NULL`),
  ],
);

export const categories = pgTable(
  "categories",
  {
    categoryId: uuid("categoryId").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 120 }).notNull().unique(),
    parentId: uuid("parentId"),
    sortOrder: integer("sortOrder").notNull().default(0),
    isActive: boolean("isActive").notNull().default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [index("categories_parent_sort_idx").on(table.parentId, table.sortOrder)],
);

export const brands = pgTable(
  "brands",
  {
    brandId: uuid("brandId").primaryKey().defaultRandom(),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 120 }).notNull().unique(),
    isActive: boolean("isActive").notNull().default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [index("brands_active_name_idx").on(table.isActive, table.name)],
);

export const brandFollows = pgTable(
  "brandFollows",
  {
    brandFollowId: uuid("brandFollowId").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    brandId: uuid("brandId")
      .notNull()
      .references(() => brands.brandId, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    unique("brand_follows_user_brand_unique").on(table.userId, table.brandId),
    index("brand_follows_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const colors = pgTable(
  "colors",
  {
    colorId: uuid("colorId").primaryKey().defaultRandom(),
    name: varchar("name", { length: 80 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull().unique(),
    hexCode: varchar("hexCode", { length: 7 }),
    isActive: boolean("isActive").notNull().default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [index("colors_active_name_idx").on(table.isActive, table.name)],
);

export const sizes = pgTable(
  "sizes",
  {
    sizeId: uuid("sizeId").primaryKey().defaultRandom(),
    name: varchar("name", { length: 80 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull().unique(),
    sortOrder: integer("sortOrder").notNull().default(0),
    isActive: boolean("isActive").notNull().default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [index("sizes_active_sort_idx").on(table.isActive, table.sortOrder, table.name)],
);

export const partners = pgTable(
  "partners",
  {
    partnerId: uuid("partnerId").primaryKey().defaultRandom(),
    ownerUserId: uuid("ownerUserId")
      .notNull()
      .references(() => users.userId),
    businessEmail: varchar("businessEmail", { length: 255 }).notNull().unique(),
    businessRegistrationNumber: varchar("businessRegistrationNumber", { length: 20 }).notNull().unique(),
    tradeName: varchar("tradeName", { length: 160 }).notNull(),
    brandId: uuid("brandId").references(() => brands.brandId),
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    rejectionReason: text("rejectionReason"),
    reviewedByUserId: uuid("reviewedByUserId").references(() => users.userId),
    reviewedAt: timestamp("reviewedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    index("partners_status_idx").on(table.status),
    index("partners_status_created_idx").on(table.status, table.createdAt),
    unique("partners_owner_user_unique").on(table.ownerUserId),
    unique("partners_brand_unique").on(table.brandId),
  ],
);

export const products = pgTable(
  "products",
  {
    productId: uuid("productId").primaryKey().defaultRandom(),
    partnerId: uuid("partnerId")
      .notNull()
      .references(() => partners.partnerId),
    brandId: uuid("brandId").references(() => brands.brandId),
    categoryId: uuid("categoryId")
      .notNull()
      .references(() => categories.categoryId),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description").notNull(),
    imageUrls: jsonb("imageUrls").$type<string[]>().notNull().default([]),
    imageKeys: text("imageKeys").array().notNull().default([]),
    status: varchar("status", { length: 20 }).notNull().default("DRAFT"),
    approvalStatus: varchar("approvalStatus", { length: 20 }).notNull().default("DRAFT"),
    rejectionReason: text("rejectionReason"),
    isOnSale: boolean("isOnSale").notNull().default(false),
    isExpressDelivery: boolean("isExpressDelivery").notNull().default(false),
    publishedAt: timestamp("publishedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    index("products_catalog_default_keyset_idx").on(table.status, table.createdAt.desc(), table.productId.desc()),
    index("products_catalog_category_keyset_idx").on(
      table.status,
      table.categoryId,
      table.createdAt.desc(),
      table.productId.desc(),
    ),
    index("products_brand_idx").on(table.brandId, table.status),
    index("products_catalog_flags_idx").on(table.status, table.isOnSale, table.isExpressDelivery),
    index("products_partner_idx").on(table.partnerId, table.status),
    index("products_approval_created_idx").on(table.approvalStatus, table.createdAt),
    index("products_partner_portal_idx").on(table.partnerId, table.approvalStatus, table.updatedAt, table.productId),
  ],
);

export const stylePosts = pgTable(
  "stylePosts",
  {
    stylePostId: uuid("stylePostId").primaryKey().defaultRandom(),
    authorId: uuid("authorId")
      .notNull()
      .references(() => users.userId),
    title: varchar("title", { length: 200 }).notNull(),
    content: text("content").notNull(),
    imageUrls: jsonb("imageUrls").$type<string[]>().notNull().default([]),
    category: varchar("category", { length: 20 }).notNull().default("CLOTHING"),
    hashtags: jsonb("hashtags").$type<string[]>().notNull().default([]),
    brandTagIds: jsonb("brandTagIds").$type<string[]>().notNull().default([]),
    imageKeys: jsonb("imageKeys").$type<string[]>().notNull().default([]),
    idempotencyKey: varchar("idempotencyKey", { length: 120 }),
    isPartner: boolean("isPartner").notNull().default(false),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    unique("style_posts_author_idempotency_unique").on(table.authorId, table.idempotencyKey),
    index("style_posts_author_created_idx").on(table.authorId, table.createdAt),
    index("style_posts_category_created_idx").on(table.category, table.createdAt),
  ],
);

export const stylePostProducts = pgTable(
  "stylePostProducts",
  {
    stylePostProductId: uuid("stylePostProductId").primaryKey().defaultRandom(),
    stylePostId: uuid("stylePostId")
      .notNull()
      .references(() => stylePosts.stylePostId, { onDelete: "cascade" }),
    productId: uuid("productId")
      .notNull()
      .references(() => products.productId),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    unique("style_post_products_post_product_unique").on(table.stylePostId, table.productId),
    index("style_post_products_post_idx").on(table.stylePostId, table.createdAt),
  ],
);

export const stylePostLikes = pgTable(
  "stylePostLikes",
  {
    stylePostLikeId: uuid("stylePostLikeId").primaryKey().defaultRandom(),
    stylePostId: uuid("stylePostId")
      .notNull()
      .references(() => stylePosts.stylePostId, { onDelete: "cascade" }),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    deletedAt: timestamp("deletedAt"),
  },
  (table) => [
    uniqueIndex("style_post_likes_active_unique")
      .on(table.stylePostId, table.userId)
      .where(sql`${table.deletedAt} IS NULL`),
    index("style_post_likes_post_created_idx").on(table.stylePostId, table.createdAt),
    index("style_post_likes_user_created_idx").on(table.userId, table.createdAt),
    index("style_post_likes_snapshot_idx").on(table.stylePostId, table.createdAt, table.deletedAt),
  ],
);

export const productSkus = pgTable(
  "productSkus",
  {
    skuId: uuid("skuId").primaryKey().defaultRandom(),
    productId: uuid("productId")
      .notNull()
      .references(() => products.productId),
    colorId: uuid("colorId").references(() => colors.colorId),
    sizeId: uuid("sizeId").references(() => sizes.sizeId),
    code: varchar("code", { length: 80 }).notNull().unique(),
    optionName: varchar("optionName", { length: 160 }).notNull(),
    price: integer("price").notNull(),
    stock: integer("stock").notNull().default(0),
    position: integer("position").notNull(),
    isActive: boolean("isActive").notNull().default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    index("product_skus_product_idx").on(table.productId, table.isActive),
    index("product_skus_product_position_idx").on(table.productId, table.position, table.skuId),
    index("product_skus_color_idx").on(table.colorId, table.productId),
    index("product_skus_size_idx").on(table.sizeId, table.productId),
  ],
);

export const wishes = pgTable(
  "wishes",
  {
    wishId: uuid("wishId").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    productId: uuid("productId")
      .notNull()
      .references(() => products.productId),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    unique("wishes_user_product_unique").on(table.userId, table.productId),
    index("wishes_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const recentProductViews = pgTable(
  "recentProductViews",
  {
    recentProductViewId: uuid("recentProductViewId").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId, { onDelete: "cascade" }),
    productId: uuid("productId")
      .notNull()
      .references(() => products.productId, { onDelete: "cascade" }),
    viewedAt: timestamp("viewedAt").defaultNow().notNull(),
  },
  (table) => [
    unique("recent_product_views_user_product_unique").on(table.userId, table.productId),
    index("recent_product_views_user_viewed_idx").on(table.userId, table.viewedAt),
  ],
);

export const comparisonItems = pgTable(
  "comparisonItems",
  {
    comparisonItemId: uuid("comparisonItemId").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    productId: uuid("productId")
      .notNull()
      .references(() => products.productId),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    unique("comparison_items_user_product_unique").on(table.userId, table.productId),
    index("comparison_items_user_created_idx").on(table.userId, table.createdAt),
  ],
);

export const carts = pgTable("carts", {
  cartId: uuid("cartId").primaryKey().defaultRandom(),
  userId: uuid("userId")
    .notNull()
    .unique()
    .references(() => users.userId),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const cartItems = pgTable(
  "cartItems",
  {
    cartItemId: uuid("cartItemId").primaryKey().defaultRandom(),
    cartId: uuid("cartId")
      .notNull()
      .references(() => carts.cartId),
    skuId: uuid("skuId")
      .notNull()
      .references(() => productSkus.skuId),
    quantity: integer("quantity").notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [unique("cart_items_cart_sku_unique").on(table.cartId, table.skuId)],
);

export const orders = pgTable(
  "orders",
  {
    orderId: uuid("orderId").primaryKey().defaultRandom(),
    orderNumber: varchar("orderNumber", { length: 40 }).notNull().unique(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    status: varchar("status", { length: 30 }).notNull().default("PAYMENT_PENDING"),
    paymentStatus: varchar("paymentStatus", { length: 30 }).notNull().default("PENDING"),
    totalAmount: integer("totalAmount").notNull(),
    paymentFailureReason: text("paymentFailureReason"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    index("orders_user_created_idx").on(table.userId, table.createdAt),
    index("orders_status_created_idx").on(table.status, table.createdAt),
  ],
);

export const orderItems = pgTable("orderItems", {
  orderItemId: uuid("orderItemId").primaryKey().defaultRandom(),
  orderId: uuid("orderId")
    .notNull()
    .references(() => orders.orderId),
  productId: uuid("productId")
    .notNull()
    .references(() => products.productId),
  skuId: uuid("skuId")
    .notNull()
    .references(() => productSkus.skuId),
  productTitle: varchar("productTitle", { length: 200 }).notNull(),
  skuOptionName: varchar("skuOptionName", { length: 160 }).notNull(),
  unitPrice: integer("unitPrice").notNull(),
  quantity: integer("quantity").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const checkoutIdempotencyKeys = pgTable(
  "checkoutIdempotencyKeys",
  {
    checkoutIdempotencyKeyId: uuid("checkoutIdempotencyKeyId").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    idempotencyKey: varchar("idempotencyKey", { length: 120 }).notNull(),
    orderId: uuid("orderId").references(() => orders.orderId),
    status: varchar("status", { length: 30 }).notNull().default("PROCESSING"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    unique("checkout_idempotency_user_key_unique").on(table.userId, table.idempotencyKey),
    index("checkout_idempotency_order_idx").on(table.orderId),
  ],
);

export const adminInvites = pgTable(
  "adminInvites",
  {
    inviteId: uuid("inviteId").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    tokenHash: text("tokenHash").notNull().unique(),
    invitedByUserId: uuid("invitedByUserId")
      .notNull()
      .references(() => users.userId),
    expiresAt: timestamp("expiresAt").notNull(),
    acceptedByUserId: uuid("acceptedByUserId").references(() => users.userId),
    acceptedAt: timestamp("acceptedAt"),
    revokedAt: timestamp("revokedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("admin_invites_expiry_idx").on(table.expiresAt),
    index("admin_invites_status_idx").on(table.acceptedAt, table.revokedAt, table.expiresAt),
  ],
);

export const activityEvents = pgTable(
  "activityEvents",
  {
    eventId: uuid("eventId").primaryKey().defaultRandom(),
    actorUserId: uuid("actorUserId").references(() => users.userId),
    eventType: varchar("eventType", { length: 80 }).notNull(),
    subjectType: varchar("subjectType", { length: 80 }).notNull(),
    subjectId: varchar("subjectId", { length: 255 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("activity_events_actor_created_idx").on(table.actorUserId, table.createdAt),
    index("activity_events_subject_idx").on(table.subjectType, table.subjectId),
  ],
);

export const auditLogs = pgTable(
  "auditLogs",
  {
    auditLogId: uuid("auditLogId").primaryKey().defaultRandom(),
    actorUserId: uuid("actorUserId").references(() => users.userId),
    action: varchar("action", { length: 100 }).notNull(),
    entityType: varchar("entityType", { length: 80 }).notNull(),
    entityId: varchar("entityId", { length: 255 }).notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    index("audit_logs_actor_created_idx").on(table.actorUserId, table.createdAt),
    index("audit_logs_created_idx").on(table.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type EmailVerification = typeof emailVerifications.$inferSelect;
export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type KakaoSignupToken = typeof kakaoSignupTokens.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Brand = typeof brands.$inferSelect;
export type BrandFollow = typeof brandFollows.$inferSelect;
export type Color = typeof colors.$inferSelect;
export type Size = typeof sizes.$inferSelect;
export type Partner = typeof partners.$inferSelect;
export type Product = typeof products.$inferSelect;
export type ProductSku = typeof productSkus.$inferSelect;
export type RecentProductView = typeof recentProductViews.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type StylePost = typeof stylePosts.$inferSelect;
export type StylePostProduct = typeof stylePostProducts.$inferSelect;
export type StylePostLike = typeof stylePostLikes.$inferSelect;
