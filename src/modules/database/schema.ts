import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

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

export const kakaoSignupTokens = pgTable("kakaoSignupToken", {
  tokenHash: text("tokenHash").primaryKey(),
  providerUserId: varchar("providerUserId", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

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
    status: varchar("status", { length: 20 }).notNull().default("PENDING"),
    rejectionReason: text("rejectionReason"),
    reviewedByUserId: uuid("reviewedByUserId").references(() => users.userId),
    reviewedAt: timestamp("reviewedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [index("partners_status_idx").on(table.status)],
);

export const products = pgTable(
  "products",
  {
    productId: uuid("productId").primaryKey().defaultRandom(),
    partnerId: uuid("partnerId")
      .notNull()
      .references(() => partners.partnerId),
    categoryId: uuid("categoryId")
      .notNull()
      .references(() => categories.categoryId),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description").notNull(),
    imageUrls: jsonb("imageUrls").$type<string[]>().notNull().default([]),
    status: varchar("status", { length: 20 }).notNull().default("DRAFT"),
    approvalStatus: varchar("approvalStatus", { length: 20 }).notNull().default("PENDING"),
    rejectionReason: text("rejectionReason"),
    publishedAt: timestamp("publishedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [
    index("products_catalog_idx").on(table.status, table.categoryId, table.createdAt),
    index("products_partner_idx").on(table.partnerId, table.status),
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
    isPartner: boolean("isPartner").notNull().default(false),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [index("style_posts_author_created_idx").on(table.authorId, table.createdAt)],
);

export const productSkus = pgTable(
  "productSkus",
  {
    skuId: uuid("skuId").primaryKey().defaultRandom(),
    productId: uuid("productId")
      .notNull()
      .references(() => products.productId),
    code: varchar("code", { length: 80 }).notNull().unique(),
    optionName: varchar("optionName", { length: 160 }).notNull(),
    price: integer("price").notNull(),
    stock: integer("stock").notNull().default(0),
    isActive: boolean("isActive").notNull().default(true),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  },
  (table) => [index("product_skus_product_idx").on(table.productId, table.isActive)],
);

export const wishlists = pgTable(
  "wishlists",
  {
    wishlistId: uuid("wishlistId").primaryKey().defaultRandom(),
    userId: uuid("userId")
      .notNull()
      .references(() => users.userId),
    productId: uuid("productId")
      .notNull()
      .references(() => products.productId),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [
    unique("wishlists_user_product_unique").on(table.userId, table.productId),
    index("wishlists_user_created_idx").on(table.userId, table.createdAt),
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
  (table) => [index("orders_user_created_idx").on(table.userId, table.createdAt)],
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
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (table) => [index("admin_invites_expiry_idx").on(table.expiresAt)],
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
  ],
);

export type User = typeof users.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type EmailVerification = typeof emailVerifications.$inferSelect;
export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type KakaoSignupToken = typeof kakaoSignupTokens.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type Partner = typeof partners.$inferSelect;
export type Product = typeof products.$inferSelect;
export type ProductSku = typeof productSkus.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type StylePost = typeof stylePosts.$inferSelect;
