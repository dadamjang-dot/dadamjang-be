import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  CustomConflictException,
  CustomForbiddenException,
  CustomUnauthorizedException,
} from "src/common/errors/custom-exceptions";
import { requireResult } from "src/common/invariants/require-result";
import { Database, DatabaseExecutor, DatabaseTransaction, DRIZZLE } from "src/modules/database/database.module";
import { accountReactivationTokens, orders, refreshTokens, users, type User } from "src/modules/database/schema";

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
