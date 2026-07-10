import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, gt, isNull, sql } from "drizzle-orm";
import { hashToken } from "src/common/security/token-hash";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { emailVerificationTokens, emailVerifications, passwordResetTokens, refreshTokens, users, type EmailVerification } from "src/modules/database/schema";

@Injectable()
export class EmailRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}
  createVerification = async (input: { email: string; codeHash: string; expiresAt: Date; requestIpHash: string }) => (await this.db.insert(emailVerifications).values(input).returning())[0];
  deleteVerification = async (id: string) => { await this.db.delete(emailVerifications).where(eq(emailVerifications.id, id)); };
  latestVerification = (email: string): Promise<EmailVerification | undefined> => this.db.query.emailVerifications.findFirst({ where: eq(emailVerifications.email, email), orderBy: desc(emailVerifications.createdAt) });
  verificationsSince = (email: string, since: Date) => this.db.select().from(emailVerifications).where(and(eq(emailVerifications.email, email), gte(emailVerifications.createdAt, since)));
  ipVerificationsSince = (requestIpHash: string, since: Date) => this.db.select().from(emailVerifications).where(and(eq(emailVerifications.requestIpHash, requestIpHash), gte(emailVerifications.createdAt, since)));
  incrementAttempt = async (id: string) => { const [result] = await this.db.update(emailVerifications).set({ attemptCount: sql`${emailVerifications.attemptCount} + 1` }).where(eq(emailVerifications.id, id)).returning(); return result; };
  markVerified = async (id: string) => (await this.db.update(emailVerifications).set({ verifiedAt: new Date() }).where(and(eq(emailVerifications.id, id), isNull(emailVerifications.verifiedAt))).returning())[0];
  createSignupToken = async (token: string, email: string, verificationId: string, expiresAt: Date) => { await this.db.insert(emailVerificationTokens).values({ tokenHash: hashToken(token), email, verificationId, expiresAt }); };
  consumeSignupTokenAndCreateUser = async (token: string, input: { userId: string; userid: string; email: string; password: string }) => this.db.transaction(async (tx) => {
    const [verificationToken] = await tx.update(emailVerificationTokens).set({ usedAt: new Date() }).where(and(eq(emailVerificationTokens.tokenHash, hashToken(token)), eq(emailVerificationTokens.email, input.email), isNull(emailVerificationTokens.usedAt), gt(emailVerificationTokens.expiresAt, new Date()))).returning();
    if (!verificationToken) return undefined;
    return (await tx.insert(users).values(input).returning())[0];
  });
  findUserByEmail = (email: string) => this.db.query.users.findFirst({ where: eq(users.email, email) });
  createPasswordResetToken = async (token: string, userId: string, expiresAt: Date, requestIpHash: string) => { await this.db.insert(passwordResetTokens).values({ tokenHash: hashToken(token), userId, expiresAt, requestIpHash }); };
  consumePasswordResetToken = async (token: string) => (await this.db.update(passwordResetTokens).set({ usedAt: new Date() }).where(and(eq(passwordResetTokens.tokenHash, hashToken(token)), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date()))).returning())[0];
  findUser = (userId: string) => this.db.query.users.findFirst({ where: eq(users.userId, userId) });
  resetPassword = async (userId: string, password: string) => this.db.transaction(async (tx) => { await tx.update(users).set({ password, updatedAt: new Date() }).where(eq(users.userId, userId)); await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId)); });
}
