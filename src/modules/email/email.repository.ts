import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { requireResult } from "src/common/invariants/require-result";
import { hashToken } from "src/common/security/token-hash";
import { Database, type DatabaseExecutor, DRIZZLE } from "src/modules/database/database.module";
import {
  adminInvites,
  emailDeliveryOutbox,
  emailVerificationTokens,
  emailVerifications,
  passwordResetTokens,
  refreshTokens,
  users,
  type EmailVerification,
} from "src/modules/database/schema";
import {
  EmailDeliveryKind,
  EmailVerificationPurpose,
  type EmailDeliveryKindValue,
  type EmailVerificationPurposeValue,
} from "./email.types";

type Delivery = typeof emailDeliveryOutbox.$inferSelect;
type ClaimedDelivery = Delivery & { claimToken: string };

type DeliveryPreparation = Readonly<{
  codeHash?: string;
  payloadCiphertext: string;
  proofExpiresAt: Date;
  token?: string;
}>;

@Injectable()
export class EmailRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}
  latestVerification = (
    email: string,
    purpose: EmailVerificationPurposeValue,
  ): Promise<EmailVerification | undefined> =>
    this.db.query.emailVerifications.findFirst({
      where: and(eq(emailVerifications.email, email), eq(emailVerifications.purpose, purpose)),
      orderBy: desc(emailVerifications.createdAt),
    });
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
  hasValidRecoveryToken = async (token: string) => {
    const tokenHash = hashToken(token);
    const now = new Date();
    const [linkProof] = await this.db
      .select({ tokenHash: passwordResetTokens.tokenHash })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, now),
        ),
      )
      .limit(1);
    if (linkProof) return true;
    const [emailProof] = await this.db
      .select({ tokenHash: emailVerificationTokens.tokenHash })
      .from(emailVerificationTokens)
      .where(
        and(
          eq(emailVerificationTokens.tokenHash, tokenHash),
          eq(emailVerificationTokens.purpose, "PASSWORD_RESET"),
          isNull(emailVerificationTokens.usedAt),
          gt(emailVerificationTokens.expiresAt, now),
        ),
      )
      .limit(1);
    return !!emailProof;
  };
  enqueueDelivery = async (
    input: Readonly<{
      email: string;
      expiresAt: Date;
      kind: EmailDeliveryKindValue;
      payloadCiphertext?: string;
      proofId?: string;
      requestIpHash?: string;
    }>,
    executor: DatabaseExecutor = this.db,
  ) =>
    requireResult(
      (
        await executor
          .insert(emailDeliveryOutbox)
          .values({
            email: input.email,
            expiresAt: input.expiresAt,
            kind: input.kind,
            ...(input.payloadCiphertext ? { payloadCiphertext: input.payloadCiphertext } : {}),
            ...(input.proofId ? { proofId: input.proofId } : {}),
            ...(input.requestIpHash ? { requestIpHash: input.requestIpHash } : {}),
          })
          .returning()
      )[0],
    );

  claimDelivery = async (now = new Date()) =>
    this.db.transaction(async (tx) => {
      await tx
        .update(emailDeliveryOutbox)
        .set({ claimedAt: null, claimToken: null, status: "FAILED", updatedAt: now })
        .where(
          and(inArray(emailDeliveryOutbox.status, ["PENDING", "PROCESSING"]), lte(emailDeliveryOutbox.expiresAt, now)),
        );
      const staleAt = new Date(now.getTime() - 30_000);
      const [delivery] = await tx
        .select()
        .from(emailDeliveryOutbox)
        .where(
          and(
            gt(emailDeliveryOutbox.expiresAt, now),
            or(
              and(eq(emailDeliveryOutbox.status, "PENDING"), lte(emailDeliveryOutbox.availableAt, now)),
              and(eq(emailDeliveryOutbox.status, "PROCESSING"), lt(emailDeliveryOutbox.claimedAt, staleAt)),
            ),
          ),
        )
        .orderBy(asc(emailDeliveryOutbox.availableAt), asc(emailDeliveryOutbox.createdAt), asc(emailDeliveryOutbox.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!delivery) return undefined;
      const claimToken = randomUUID();
      const claimed = requireResult(
        (
          await tx
            .update(emailDeliveryOutbox)
            .set({
              attemptCount: sql`${emailDeliveryOutbox.attemptCount} + 1`,
              claimedAt: now,
              claimToken,
              status: "PROCESSING",
              updatedAt: now,
            })
            .where(eq(emailDeliveryOutbox.id, delivery.id))
            .returning()
        )[0],
      );
      return { ...claimed, claimToken } as ClaimedDelivery;
    });

  prepareDelivery = async (claimed: ClaimedDelivery, preparation: DeliveryPreparation, now = new Date()) =>
    this.db.transaction(async (tx) => {
      const [delivery] = await tx
        .select()
        .from(emailDeliveryOutbox)
        .where(
          and(
            eq(emailDeliveryOutbox.id, claimed.id),
            eq(emailDeliveryOutbox.claimToken, claimed.claimToken),
            eq(emailDeliveryOutbox.status, "PROCESSING"),
          ),
        )
        .limit(1)
        .for("update");
      if (!delivery) throw new Error("Email delivery claim was lost");
      if (delivery.payloadCiphertext && delivery.proofId)
        return {
          ...delivery,
          claimToken: claimed.claimToken,
          payloadCiphertext: delivery.payloadCiphertext,
          proofId: delivery.proofId,
        };
      const purpose =
        delivery.kind === EmailDeliveryKind.SignupCode
          ? EmailVerificationPurpose.Signup
          : EmailVerificationPurpose.PasswordReset;
      const user =
        delivery.kind === EmailDeliveryKind.SignupCode
          ? { email: delivery.email }
          : await tx.query.users.findFirst({ where: eq(users.email, delivery.email) });
      if (!user) {
        await tx
          .update(emailDeliveryOutbox)
          .set({ claimToken: null, claimedAt: null, status: "SUPPRESSED", updatedAt: now })
          .where(eq(emailDeliveryOutbox.id, delivery.id));
        return undefined;
      }
      let proofId: string;
      if (delivery.kind === EmailDeliveryKind.PasswordResetLink) {
        const token = requireResult(preparation.token);
        const tokenHash = hashToken(token);
        await tx.insert(passwordResetTokens).values({
          tokenHash,
          userId: requireResult("userId" in user ? user.userId : undefined),
          expiresAt: preparation.proofExpiresAt,
          requestIpHash: delivery.requestIpHash,
        });
        proofId = tokenHash;
      } else {
        const verification = requireResult(
          (
            await tx
              .insert(emailVerifications)
              .values({
                email: delivery.email,
                purpose,
                codeHash: requireResult(preparation.codeHash),
                expiresAt: preparation.proofExpiresAt,
                requestIpHash: delivery.requestIpHash,
              })
              .returning({ id: emailVerifications.id })
          )[0],
        );
        proofId = verification.id;
      }
      const prepared = requireResult(
        (
          await tx
            .update(emailDeliveryOutbox)
            .set({
              expiresAt: preparation.proofExpiresAt,
              payloadCiphertext: preparation.payloadCiphertext,
              proofId,
              updatedAt: now,
            })
            .where(eq(emailDeliveryOutbox.id, delivery.id))
            .returning()
        )[0],
      );
      return {
        ...prepared,
        claimToken: claimed.claimToken,
        payloadCiphertext: preparation.payloadCiphertext,
        proofId,
      };
    });

  isDeliveryCurrent = async (delivery: Delivery & { proofId: string }, secret: string, now = new Date()) => {
    if (delivery.kind === EmailDeliveryKind.AdminInvite) {
      const [invite] = await this.db
        .select({ inviteId: adminInvites.inviteId })
        .from(adminInvites)
        .where(
          and(
            eq(adminInvites.inviteId, delivery.proofId),
            eq(adminInvites.email, delivery.email),
            eq(adminInvites.tokenHash, hashToken(secret)),
            isNull(adminInvites.acceptedAt),
            isNull(adminInvites.revokedAt),
            gt(adminInvites.expiresAt, now),
          ),
        )
        .limit(1);
      return !!invite;
    }
    if (delivery.kind === EmailDeliveryKind.PasswordResetLink) {
      const [token] = await this.db
        .select({ tokenHash: passwordResetTokens.tokenHash })
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.tokenHash, delivery.proofId),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, now),
          ),
        )
        .limit(1);
      return !!token;
    }
    const purpose = delivery.kind === EmailDeliveryKind.SignupCode ? "SIGNUP" : "PASSWORD_RESET";
    const [verification] = await this.db
      .select({ id: emailVerifications.id })
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.id, delivery.proofId),
          eq(emailVerifications.email, delivery.email),
          eq(emailVerifications.purpose, purpose),
          isNull(emailVerifications.verifiedAt),
          gt(emailVerifications.expiresAt, now),
        ),
      )
      .limit(1);
    return !!verification;
  };

  completeDelivery = async (id: string, claimToken: string, now = new Date()) => {
    const [completed] = await this.db
      .update(emailDeliveryOutbox)
      .set({ claimToken: null, claimedAt: null, sentAt: now, status: "SENT", updatedAt: now })
      .where(
        and(
          eq(emailDeliveryOutbox.id, id),
          eq(emailDeliveryOutbox.claimToken, claimToken),
          eq(emailDeliveryOutbox.status, "PROCESSING"),
        ),
      )
      .returning({ id: emailDeliveryOutbox.id });
    if (!completed) throw new Error("Email delivery claim was lost");
  };

  suppressDelivery = async (id: string, claimToken: string, now = new Date()) => {
    await this.db
      .update(emailDeliveryOutbox)
      .set({ claimToken: null, claimedAt: null, status: "SUPPRESSED", updatedAt: now })
      .where(
        and(
          eq(emailDeliveryOutbox.id, id),
          eq(emailDeliveryOutbox.claimToken, claimToken),
          eq(emailDeliveryOutbox.status, "PROCESSING"),
        ),
      );
  };

  retryDelivery = async (delivery: ClaimedDelivery, error: unknown, now = new Date()) => {
    const retryAt = new Date(now.getTime() + Math.min(2 ** delivery.attemptCount, 300) * 1_000);
    const retry = delivery.attemptCount < 8 && retryAt.getTime() < delivery.expiresAt.getTime();
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : "Unknown delivery error").slice(
      0,
      500,
    );
    await this.db
      .update(emailDeliveryOutbox)
      .set({
        availableAt: retry ? retryAt : delivery.expiresAt,
        claimToken: null,
        claimedAt: null,
        lastError: message,
        status: retry ? "PENDING" : "FAILED",
        updatedAt: now,
      })
      .where(
        and(
          eq(emailDeliveryOutbox.id, delivery.id),
          eq(emailDeliveryOutbox.claimToken, delivery.claimToken),
          eq(emailDeliveryOutbox.status, "PROCESSING"),
        ),
      );
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
