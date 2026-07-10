import { integer, pgTable, text, timestamp, unique, uuid, varchar } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  userId: uuid("userId").primaryKey(),
  userid: varchar("userid", { length: 40 }).notNull().unique(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  password: text("password").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export const refreshTokens = pgTable(
  "refreshToken",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("userId").notNull().references(() => users.userId),
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
    userId: uuid("userId").notNull().references(() => users.userId),
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
  verificationId: uuid("verificationId").notNull().references(() => emailVerifications.id),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const passwordResetTokens = pgTable("passwordResetToken", {
  tokenHash: text("tokenHash").primaryKey(),
  userId: uuid("userId").notNull().references(() => users.userId),
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

export type User = typeof users.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
export type EmailVerification = typeof emailVerifications.$inferSelect;
export type EmailVerificationToken = typeof emailVerificationTokens.$inferSelect;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type KakaoSignupToken = typeof kakaoSignupTokens.$inferSelect;
