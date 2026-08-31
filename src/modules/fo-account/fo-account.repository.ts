import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { hasDatabaseErrorCode } from "src/common/errors/database-error";
import {
  CustomConflictException,
  CustomForbiddenException,
  CustomUnauthorizedException,
} from "src/common/errors/custom-exceptions";
import { requireResult } from "src/common/invariants/require-result";
import { Database, DatabaseExecutor, DatabaseTransaction, DRIZZLE } from "src/modules/database/database.module";
import {
  accountReactivationTokens,
  activityEvents,
  authIdentities,
  brandFollows,
  cartItems,
  carts,
  checkoutIdempotencyKeys,
  comparisonItems,
  emailDeliveryOutbox,
  emailVerificationTokens,
  emailVerifications,
  identityVerificationSessions,
  kakaoLoginFlows,
  kakaoSignupTokens,
  orders,
  passwordResetTokens,
  recentProductViews,
  refreshTokens,
  stylePostLikes,
  users,
  verifiedIdentities,
  wishes,
  type User,
} from "src/modules/database/schema";
import { tryLockEmailDelivery } from "src/modules/email/email-delivery-lock";

type IssueTokens<T> = (user: User, store: DatabaseTransaction) => Promise<T>;

@Injectable()
export class FoAccountRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  deactivate = (userId: string) =>
    this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.userId, userId)).for("update").limit(1);
      if (!user || user.role !== "USER" || user.deactivatedAt || user.anonymizedAt)
        throw new CustomForbiddenException("탈퇴할 수 없는 계정입니다.");
      const [blockingOrder] = await tx
        .select({ orderId: orders.orderId })
        .from(orders)
        .where(and(eq(orders.userId, userId), inArray(orders.status, ["PAYMENT_PENDING", "PAID", "FULFILLING"])))
        .limit(1);
      if (blockingOrder) throw new CustomConflictException("진행 중인 주문이 있어 탈퇴할 수 없습니다.");
      const updated = requireResult(
        (
          await tx
            .update(users)
            .set({
              deactivatedAt: sql`transaction_timestamp()`,
              scheduledAnonymizationAt: sql`transaction_timestamp() + interval '30 days'`,
            })
            .where(eq(users.userId, userId))
            .returning({ scheduledAnonymizationAt: users.scheduledAnonymizationAt })
        )[0],
      );
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
      if (!updated.scheduledAnonymizationAt) throw new Error("Scheduled anonymization timestamp is missing");
      return { ok: true, scheduledAnonymizationAt: updated.scheduledAnonymizationAt };
    });

  insertReactivationToken = (
    userId: string,
    tokenHash: string,
    deviceIdHash: string,
    store: DatabaseExecutor = this.db,
  ) =>
    store.insert(accountReactivationTokens).values({
      tokenHash,
      userId,
      deviceIdHash,
      createdAt: sql`statement_timestamp()`,
      expiresAt: sql`statement_timestamp() + interval '10 minutes'`,
    });

  anonymizeDueBatch = async (batchSize: number): Promise<string[]> => {
    const anonymizedUserIds: string[] = [];
    const skippedUserIds: string[] = [];
    for (let candidateCount = 0; candidateCount < batchSize; candidateCount += 1) {
      let claimedUserId: string | undefined;
      try {
        const anonymizedUserId = await this.db.transaction(async (tx) => {
          const [user] = await tx
            .select()
            .from(users)
            .where(
              and(
                eq(users.role, "USER"),
                isNotNull(users.deactivatedAt),
                isNotNull(users.scheduledAnonymizationAt),
                isNull(users.anonymizedAt),
                lte(users.scheduledAnonymizationAt, sql`transaction_timestamp()`),
                skippedUserIds.length ? notInArray(users.userId, skippedUserIds) : undefined,
              ),
            )
            .orderBy(asc(users.scheduledAnonymizationAt), asc(users.userId))
            .limit(1)
            .for("update", { skipLocked: true });
          if (!user) return undefined;
          claimedUserId = user.userId;
          if (!(await tryLockEmailDelivery(tx, user.email))) return null;
          const resetProofs = await tx
            .select({ tokenHash: passwordResetTokens.tokenHash })
            .from(passwordResetTokens)
            .where(eq(passwordResetTokens.userId, user.userId));
          const verificationProofs = await tx
            .select({ id: emailVerifications.id })
            .from(emailVerifications)
            .where(eq(emailVerifications.email, user.email));
          const proofIds = [
            ...resetProofs.map(({ tokenHash }) => tokenHash),
            ...verificationProofs.map(({ id }) => id),
          ];
          const outboxCondition = or(
            eq(emailDeliveryOutbox.email, user.email),
            proofIds.length ? inArray(emailDeliveryOutbox.proofId, proofIds) : undefined,
          );
          await tx
            .select({ id: emailDeliveryOutbox.id })
            .from(emailDeliveryOutbox)
            .where(outboxCondition)
            .for("update", { noWait: true });
          const kakaoIdentities = await tx
            .select({ providerUserId: authIdentities.providerUserId })
            .from(authIdentities)
            .where(and(eq(authIdentities.userId, user.userId), eq(authIdentities.provider, "kakao")));
          const identities = await tx
            .select({ ciHash: verifiedIdentities.ciHash })
            .from(verifiedIdentities)
            .where(eq(verifiedIdentities.userId, user.userId));
          const providerUserIds = kakaoIdentities.map(({ providerUserId }) => providerUserId);
          const ciHashes = identities.map(({ ciHash }) => ciHash);
          const verificationIds = verificationProofs.map(({ id }) => id);
          await tx.delete(accountReactivationTokens).where(eq(accountReactivationTokens.userId, user.userId));
          await tx.delete(refreshTokens).where(eq(refreshTokens.userId, user.userId));
          await tx.delete(emailDeliveryOutbox).where(outboxCondition);
          await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, user.userId));
          await tx
            .delete(emailVerificationTokens)
            .where(
              or(
                eq(emailVerificationTokens.email, user.email),
                verificationIds.length ? inArray(emailVerificationTokens.verificationId, verificationIds) : undefined,
              ),
            );
          await tx.delete(emailVerifications).where(eq(emailVerifications.email, user.email));
          await tx
            .delete(kakaoSignupTokens)
            .where(
              or(
                eq(kakaoSignupTokens.email, user.email),
                providerUserIds.length ? inArray(kakaoSignupTokens.providerUserId, providerUserIds) : undefined,
              ),
            );
          await tx
            .delete(kakaoLoginFlows)
            .where(
              or(
                eq(kakaoLoginFlows.userId, user.userId),
                eq(kakaoLoginFlows.email, user.email),
                providerUserIds.length ? inArray(kakaoLoginFlows.providerUserId, providerUserIds) : undefined,
              ),
            );
          if (ciHashes.length)
            await tx.delete(identityVerificationSessions).where(inArray(identityVerificationSessions.ciHash, ciHashes));
          await tx.delete(authIdentities).where(eq(authIdentities.userId, user.userId));
          await tx.delete(verifiedIdentities).where(eq(verifiedIdentities.userId, user.userId));
          await tx.delete(brandFollows).where(eq(brandFollows.userId, user.userId));
          await tx.delete(stylePostLikes).where(eq(stylePostLikes.userId, user.userId));
          await tx.delete(wishes).where(eq(wishes.userId, user.userId));
          await tx.delete(recentProductViews).where(eq(recentProductViews.userId, user.userId));
          await tx.delete(comparisonItems).where(eq(comparisonItems.userId, user.userId));
          const userCarts = await tx.select({ cartId: carts.cartId }).from(carts).where(eq(carts.userId, user.userId));
          if (userCarts.length)
            await tx.delete(cartItems).where(
              inArray(
                cartItems.cartId,
                userCarts.map(({ cartId }) => cartId),
              ),
            );
          await tx.delete(carts).where(eq(carts.userId, user.userId));
          await tx.delete(checkoutIdempotencyKeys).where(eq(checkoutIdempotencyKeys.userId, user.userId));
          await tx.delete(activityEvents).where(eq(activityEvents.actorUserId, user.userId));
          const compactUserId = user.userId.replaceAll("-", "");
          await tx
            .update(users)
            .set({
              userid: `deleted-${compactUserId}`,
              email: `deleted+${compactUserId}@invalid.local`,
              password: null,
              anonymizedAt: sql`transaction_timestamp()`,
              updatedAt: sql`transaction_timestamp()`,
            })
            .where(eq(users.userId, user.userId));
          return user.userId;
        });
        if (anonymizedUserId === null) {
          skippedUserIds.push(requireResult(claimedUserId));
          continue;
        }
        if (!anonymizedUserId) break;
        anonymizedUserIds.push(anonymizedUserId);
      } catch (error) {
        if (!claimedUserId || !hasDatabaseErrorCode(error, "55P03")) throw error;
        skippedUserIds.push(claimedUserId);
      }
    }
    return anonymizedUserIds;
  };

  reactivate = <T>(tokenHash: string, deviceIdHash: string, issueTokens: IssueTokens<T>) =>
    this.db.transaction(async (tx) => {
      const [token] = await tx
        .select()
        .from(accountReactivationTokens)
        .where(eq(accountReactivationTokens.tokenHash, tokenHash))
        .limit(1);
      if (!token) throw new CustomUnauthorizedException("계정 복구 요청이 유효하지 않습니다.");
      const [user] = await tx.select().from(users).where(eq(users.userId, token.userId)).for("update").limit(1);
      if (!user || user.role !== "USER" || !user.deactivatedAt || !user.scheduledAnonymizationAt || user.anonymizedAt)
        throw new CustomUnauthorizedException("계정 복구 요청이 유효하지 않습니다.");
      const [consumed] = await tx
        .update(accountReactivationTokens)
        .set({ usedAt: sql`transaction_timestamp()` })
        .where(
          and(
            eq(accountReactivationTokens.tokenHash, tokenHash),
            eq(accountReactivationTokens.userId, user.userId),
            eq(accountReactivationTokens.deviceIdHash, deviceIdHash),
            isNull(accountReactivationTokens.usedAt),
            gt(accountReactivationTokens.expiresAt, sql`transaction_timestamp()`),
            gte(accountReactivationTokens.createdAt, user.deactivatedAt),
            sql`transaction_timestamp() < ${user.scheduledAnonymizationAt}`,
          ),
        )
        .returning({ tokenHash: accountReactivationTokens.tokenHash });
      if (!consumed) throw new CustomUnauthorizedException("계정 복구 요청이 유효하지 않습니다.");
      const currentUser = requireResult(
        (
          await tx
            .update(users)
            .set({ deactivatedAt: null, scheduledAnonymizationAt: null })
            .where(eq(users.userId, user.userId))
            .returning()
        )[0],
      );
      return issueTokens(currentUser, tx);
    });
}
