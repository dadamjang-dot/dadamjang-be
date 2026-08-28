import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, gt, isNull, sql } from "drizzle-orm";
import { hashToken } from "src/common/security/token-hash";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  emailVerificationTokens,
  emailVerifications,
  passwordResetTokens,
  refreshTokens,
  users,
  type EmailVerification,
} from "src/modules/database/schema";
import type { EmailVerificationPurposeValue } from "./email.types";

@Injectable()
export class EmailRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}
  createVerification = async (input: {
    email: string;
    purpose: EmailVerificationPurposeValue;
    codeHash: string;
    expiresAt: Date;
    requestIpHash: string;
  }) => (await this.db.insert(emailVerifications).values(input).returning())[0];
  deleteVerification = async (id: string) => {
    await this.db.delete(emailVerifications).where(eq(emailVerifications.id, id));
  };
  latestVerification = (
    email: string,
    purpose: EmailVerificationPurposeValue,
  ): Promise<EmailVerification | undefined> =>
    this.db.query.emailVerifications.findFirst({
      where: and(eq(emailVerifications.email, email), eq(emailVerifications.purpose, purpose)),
      orderBy: desc(emailVerifications.createdAt),
    });
  verificationsSince = (email: string, since: Date) =>
    this.db
      .select()
      .from(emailVerifications)
      .where(and(eq(emailVerifications.email, email), gte(emailVerifications.createdAt, since)));
  ipVerificationsSince = (requestIpHash: string, since: Date) =>
    this.db
      .select()
      .from(emailVerifications)
      .where(and(eq(emailVerifications.requestIpHash, requestIpHash), gte(emailVerifications.createdAt, since)));
  incrementAttempt = async (id: string) => {
    const [result] = await this.db
      .update(emailVerifications)
      .set({ attemptCount: sql`${emailVerifications.attemptCount} + 1` })
      .where(eq(emailVerifications.id, id))
      .returning();
    return result;
  };
  markVerified = async (id: string) =>
    (
      await this.db
        .update(emailVerifications)
        .set({ verifiedAt: new Date() })
        .where(and(eq(emailVerifications.id, id), isNull(emailVerifications.verifiedAt)))
        .returning()
    )[0];
  createVerificationToken = async (
    token: string,
    email: string,
    purpose: EmailVerificationPurposeValue,
    verificationId: string,
    expiresAt: Date,
  ) => {
    await this.db
      .insert(emailVerificationTokens)
      .values({ tokenHash: hashToken(token), email, purpose, verificationId, expiresAt });
  };
  consumeVerifiedEmailToken = async (token: string, email: string) =>
    (
      await this.db
        .update(emailVerificationTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(emailVerificationTokens.tokenHash, hashToken(token)),
            eq(emailVerificationTokens.email, email),
            eq(emailVerificationTokens.purpose, "SIGNUP"),
            isNull(emailVerificationTokens.usedAt),
            gt(emailVerificationTokens.expiresAt, new Date()),
          ),
        )
        .returning()
    )[0];
  findUserByEmail = (email: string) => this.db.query.users.findFirst({ where: eq(users.email, email) });
  createPasswordResetToken = async (token: string, userId: string, expiresAt: Date, requestIpHash: string) => {
    await this.db.insert(passwordResetTokens).values({ tokenHash: hashToken(token), userId, expiresAt, requestIpHash });
  };
  resetPasswordWithToken = (token: string, password: string) =>
    this.db.transaction(async (tx) => {
      const lookupAt = new Date();
      const tokenHash = hashToken(token);
      const [linkProof] = await tx
        .select({ userId: passwordResetTokens.userId })
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHash),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, lookupAt),
          ),
        )
        .limit(1);
      const [emailProof] = linkProof
        ? []
        : await tx
            .select({ userId: users.userId })
            .from(emailVerificationTokens)
            .innerJoin(users, eq(users.email, emailVerificationTokens.email))
            .where(
              and(
                eq(emailVerificationTokens.tokenHash, tokenHash),
                eq(emailVerificationTokens.purpose, "PASSWORD_RESET"),
                isNull(emailVerificationTokens.usedAt),
                gt(emailVerificationTokens.expiresAt, lookupAt),
              ),
            )
            .limit(1);
      const userId = linkProof?.userId ?? emailProof?.userId;
      if (!userId) return false;
      const [user] = await tx.select().from(users).where(eq(users.userId, userId)).for("update");
      if (!user) return false;
      const now = new Date();
      const [consumedProof] = linkProof
        ? await tx
            .update(passwordResetTokens)
            .set({ usedAt: now })
            .where(
              and(
                eq(passwordResetTokens.tokenHash, tokenHash),
                eq(passwordResetTokens.userId, user.userId),
                isNull(passwordResetTokens.usedAt),
                gt(passwordResetTokens.expiresAt, now),
              ),
            )
            .returning({ tokenHash: passwordResetTokens.tokenHash })
        : await tx
            .update(emailVerificationTokens)
            .set({ usedAt: now })
            .where(
              and(
                eq(emailVerificationTokens.tokenHash, tokenHash),
                eq(emailVerificationTokens.email, user.email),
                eq(emailVerificationTokens.purpose, "PASSWORD_RESET"),
                isNull(emailVerificationTokens.usedAt),
                gt(emailVerificationTokens.expiresAt, now),
              ),
            )
            .returning({ tokenHash: emailVerificationTokens.tokenHash });
      if (!consumedProof) return false;
      await tx.update(users).set({ password, updatedAt: now }).where(eq(users.userId, user.userId));
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: now })
        .where(and(eq(passwordResetTokens.userId, user.userId), isNull(passwordResetTokens.usedAt)));
      await tx
        .update(emailVerificationTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(emailVerificationTokens.email, user.email),
            eq(emailVerificationTokens.purpose, "PASSWORD_RESET"),
            isNull(emailVerificationTokens.usedAt),
          ),
        );
      await tx
        .update(emailVerifications)
        .set({ expiresAt: now })
        .where(
          and(
            eq(emailVerifications.email, user.email),
            eq(emailVerifications.purpose, "PASSWORD_RESET"),
            gt(emailVerifications.expiresAt, now),
          ),
        );
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, user.userId));
      return true;
    });
}
