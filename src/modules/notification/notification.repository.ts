import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { requireResult } from "src/common/invariants/require-result";
import { Database, DatabaseTransaction, DRIZZLE } from "src/modules/database/database.module";
import {
  notificationPreferences,
  notifications,
  pushDevices,
  pushOutbox,
  refreshTokens,
} from "src/modules/database/schema";
import type { RegisterFoPushDeviceInput, UpdateFoNotificationPreferencesInput } from "./notification.types";
import type { ExpoPushReceipt, ExpoPushTicket } from "./notification.sender";

export type FoNotificationCursor = { createdAt: Date; notificationId: string };

type NotificationPreferenceCategory = "orderPushEnabled" | "wishPushEnabled" | "stylePushEnabled";

type CreateNotificationInput = {
  userId: string;
  preferenceCategory: NotificationPreferenceCategory;
  notification: typeof notifications.$inferInsert;
};

const notificationFields = {
  notificationId: notifications.notificationId,
  type: notifications.type,
  title: notifications.title,
  body: notifications.body,
  route: notifications.route,
  entityId: notifications.entityId,
  readAt: notifications.readAt,
  createdAt: notifications.createdAt,
};

const unsettledStatuses = ["PENDING", "PROCESSING", "TICKETED"];
const PUSH_CLAIM_STALE_MS = 30_000;
const PUSH_MAX_ATTEMPTS = 8;
const PUSH_RECEIPT_DELAY_MS = 15 * 60_000;
const PUSH_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const PUSH_TERMINAL_RETENTION_BATCH_SIZE = 100;

type PushClaim = Readonly<{
  pushOutboxId: string;
  pushDeviceId: string;
  claimToken: string;
  attemptCount: number;
  expoTicketId?: string;
}>;

export type ClaimedPushSend = PushClaim &
  Readonly<{
    notificationId: string;
    expoPushToken: string;
    type: "ORDER_STATUS" | "WISH_PRICE_DROP" | "WISH_RESTOCK" | "STYLE_LIKE";
    title: string;
    body: string;
    entityId: string;
  }>;

export type ClaimedPushReceipt = PushClaim & Readonly<{ expoTicketId: string }>;

const pushErrorMessage = (error: unknown) =>
  (error instanceof Error ? `${error.name}: ${error.message}` : "Unknown Push delivery error").slice(0, 500);

const expoErrorMessage = (result: Extract<ExpoPushTicket | ExpoPushReceipt, { status: "error" }>) =>
  [result.details?.error, result.message].filter(Boolean).join(": ").slice(0, 500);

const deviceNotRegistered = (result: ExpoPushTicket | ExpoPushReceipt) =>
  result.status === "error" && result.details?.error === "DeviceNotRegistered";

@Injectable()
export class NotificationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  list = async (userId: string, first: number, cursor?: FoNotificationCursor) => {
    const cursorCondition = cursor
      ? or(
          lt(notifications.createdAt, cursor.createdAt),
          and(eq(notifications.createdAt, cursor.createdAt), lt(notifications.notificationId, cursor.notificationId)),
        )
      : undefined;
    const [rows, unread] = await Promise.all([
      this.db
        .select(notificationFields)
        .from(notifications)
        .where(and(eq(notifications.userId, userId), cursorCondition))
        .orderBy(desc(notifications.createdAt), desc(notifications.notificationId))
        .limit(first + 1),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt))),
    ]);
    return { rows, unreadCount: unread[0]?.count ?? 0 };
  };

  get = (userId: string, notificationId: string) =>
    this.db
      .select(notificationFields)
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.notificationId, notificationId)))
      .limit(1)
      .then(([notification]) => notification);

  markRead = (userId: string, notificationId: string) =>
    this.db
      .update(notifications)
      .set({ readAt: sql`COALESCE(${notifications.readAt}, transaction_timestamp())` })
      .where(and(eq(notifications.userId, userId), eq(notifications.notificationId, notificationId)))
      .returning(notificationFields)
      .then(([notification]) => notification);

  markAllRead = async (userId: string) => {
    await this.db
      .update(notifications)
      .set({ readAt: sql`transaction_timestamp()` })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return true;
  };

  getPreferences = async (userId: string) => {
    await this.db.insert(notificationPreferences).values({ userId }).onConflictDoNothing();
    return requireResult(
      await this.db.query.notificationPreferences.findFirst({
        where: eq(notificationPreferences.userId, userId),
      }),
    );
  };

  updatePreferences = async (userId: string, input: UpdateFoNotificationPreferencesInput) => {
    const [preferences] = await this.db
      .insert(notificationPreferences)
      .values({ userId, ...input, updatedAt: sql`transaction_timestamp()` })
      .onConflictDoUpdate({
        target: notificationPreferences.userId,
        set: { ...input, updatedAt: sql`transaction_timestamp()` },
      })
      .returning();
    return requireResult(preferences);
  };

  create = async (store: DatabaseTransaction, input: CreateNotificationInput) => {
    const [notification] = await store
      .insert(notifications)
      .values(input.notification)
      .onConflictDoNothing()
      .returning({ notificationId: notifications.notificationId });
    if (!notification) return;
    const devices = await this.activeEligibleDevices(store, input.userId, input.preferenceCategory);
    if (!devices.length) return;
    await store.insert(pushOutbox).values(
      devices.map(({ pushDeviceId }) => ({
        notificationId: notification.notificationId,
        pushDeviceId,
      })),
    );
  };

  lockActiveRefreshSession = async (store: DatabaseTransaction, userId: string, installationId: string) => {
    const [session] = await store
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.deviceId, installationId),
          gt(refreshTokens.refreshTokenExp, sql`transaction_timestamp()`),
        ),
      )
      .limit(1)
      .for("share");
    return Boolean(session);
  };

  transferDevice = async (
    store: DatabaseTransaction,
    input: RegisterFoPushDeviceInput & { userId: string; installationId: string },
  ) => {
    await store.execute(
      sql`SELECT
        pg_advisory_xact_lock(hashtextextended(${`push-installation:${input.installationId}`}, 5)),
        pg_advisory_xact_lock(hashtextextended(${`push-token:${input.expoPushToken}`}, 5))`,
    );
    const devices = await store
      .select()
      .from(pushDevices)
      .where(
        or(eq(pushDevices.installationId, input.installationId), eq(pushDevices.expoPushToken, input.expoPushToken)),
      )
      .orderBy(pushDevices.userId, pushDevices.pushDeviceId)
      .for("update");
    const tokenDevice = devices.find(({ expoPushToken }) => expoPushToken === input.expoPushToken);
    if (tokenDevice?.disabledReason === "DEVICE_NOT_REGISTERED") return false;
    let installationDevice = devices.find(({ installationId }) => installationId === input.installationId);
    if (installationDevice?.disabledReason === "DEVICE_NOT_REGISTERED") {
      await store
        .update(pushDevices)
        .set({
          installationId: `retired-installation:${installationDevice.pushDeviceId}`,
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(eq(pushDevices.pushDeviceId, installationDevice.pushDeviceId));
      installationDevice = undefined;
    }
    const target = installationDevice ?? tokenDevice;
    if (target && tokenDevice && target.pushDeviceId !== tokenDevice.pushDeviceId) {
      await this.disableDeviceIds(store, [tokenDevice.pushDeviceId], "DEVICE_TRANSFERRED");
      await store
        .update(pushDevices)
        .set({
          installationId: `retired-installation:${tokenDevice.pushDeviceId}`,
          expoPushToken: `retired-token:${tokenDevice.pushDeviceId}`,
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(eq(pushDevices.pushDeviceId, tokenDevice.pushDeviceId));
    }
    if (target) {
      if (
        target.userId !== input.userId ||
        target.installationId !== input.installationId ||
        target.expoPushToken !== input.expoPushToken
      )
        await this.failUnsettled(store, [target.pushDeviceId], "DEVICE_TRANSFERRED");
      await store
        .update(pushDevices)
        .set({
          userId: input.userId,
          installationId: input.installationId,
          expoPushToken: input.expoPushToken,
          platform: input.platform,
          disabledAt: null,
          disabledReason: null,
          lastSeenAt: sql`transaction_timestamp()`,
          updatedAt: sql`transaction_timestamp()`,
        })
        .where(eq(pushDevices.pushDeviceId, target.pushDeviceId));
      return true;
    }
    await store.insert(pushDevices).values({
      userId: input.userId,
      installationId: input.installationId,
      expoPushToken: input.expoPushToken,
      platform: input.platform,
      lastSeenAt: sql`transaction_timestamp()`,
      updatedAt: sql`transaction_timestamp()`,
    });
    return true;
  };

  disableInstallation = async (store: DatabaseTransaction, userId: string, installationId: string, reason: string) => {
    const devices = await store
      .select({ pushDeviceId: pushDevices.pushDeviceId })
      .from(pushDevices)
      .where(and(eq(pushDevices.userId, userId), eq(pushDevices.installationId, installationId)))
      .orderBy(pushDevices.pushDeviceId)
      .for("update");
    await this.disableDeviceIds(
      store,
      devices.map(({ pushDeviceId }) => pushDeviceId),
      reason,
    );
  };

  disableUserDevices = async (store: DatabaseTransaction, userId: string, reason: string) => {
    const devices = await store
      .select({ pushDeviceId: pushDevices.pushDeviceId })
      .from(pushDevices)
      .where(eq(pushDevices.userId, userId))
      .orderBy(pushDevices.pushDeviceId)
      .for("update");
    await this.disableDeviceIds(
      store,
      devices.map(({ pushDeviceId }) => pushDeviceId),
      reason,
    );
  };

  deleteUserData = async (store: DatabaseTransaction, userId: string) => {
    await store.delete(notifications).where(eq(notifications.userId, userId));
    await store.delete(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    await store.delete(pushDevices).where(eq(pushDevices.userId, userId));
  };

  claimPushSendBatch = async (now = new Date(), limit = 100): Promise<readonly ClaimedPushSend[]> =>
    this.db.transaction(async (tx) => {
      await this.failUnavailablePushDeliveries(tx, now);
      const staleAt = new Date(now.getTime() - PUSH_CLAIM_STALE_MS);
      const candidates = await tx
        .select({
          pushOutboxId: pushOutbox.pushOutboxId,
          notificationId: pushOutbox.notificationId,
          pushDeviceId: pushOutbox.pushDeviceId,
          expoPushToken: pushDevices.expoPushToken,
          type: notifications.type,
          title: notifications.title,
          body: notifications.body,
          entityId: notifications.entityId,
        })
        .from(pushOutbox)
        .innerJoin(pushDevices, eq(pushDevices.pushDeviceId, pushOutbox.pushDeviceId))
        .innerJoin(notifications, eq(notifications.notificationId, pushOutbox.notificationId))
        .where(
          and(
            isNull(pushDevices.disabledAt),
            isNull(pushOutbox.expoTicketId),
            or(
              and(eq(pushOutbox.status, "PENDING"), lte(pushOutbox.availableAt, now)),
              and(eq(pushOutbox.status, "PROCESSING"), lte(pushOutbox.claimedAt, staleAt)),
            ),
          ),
        )
        .orderBy(asc(pushOutbox.availableAt), asc(pushOutbox.createdAt), asc(pushOutbox.pushOutboxId))
        .limit(Math.min(Math.max(Math.trunc(limit), 0), 100))
        .for("update", { of: pushOutbox, skipLocked: true });
      if (!candidates.length) return [];
      const claimToken = randomUUID();
      const claimed = await tx
        .update(pushOutbox)
        .set({
          attemptCount: sql`${pushOutbox.attemptCount} + 1`,
          claimedAt: now,
          claimToken,
          status: "PROCESSING",
          updatedAt: now,
        })
        .where(
          inArray(
            pushOutbox.pushOutboxId,
            candidates.map(({ pushOutboxId }) => pushOutboxId),
          ),
        )
        .returning({ pushOutboxId: pushOutbox.pushOutboxId, attemptCount: pushOutbox.attemptCount });
      const attempts = new Map(claimed.map((row) => [row.pushOutboxId, row.attemptCount]));
      return candidates.map((candidate) => ({
        ...candidate,
        type: candidate.type as ClaimedPushSend["type"],
        claimToken,
        attemptCount: requireResult(attempts.get(candidate.pushOutboxId)),
      }));
    });

  claimPushReceiptBatch = async (now = new Date(), limit = 1_000): Promise<readonly ClaimedPushReceipt[]> =>
    this.db.transaction(async (tx) => {
      await this.failUnavailablePushDeliveries(tx, now);
      const staleAt = new Date(now.getTime() - PUSH_CLAIM_STALE_MS);
      const candidates = await tx
        .select({
          pushOutboxId: pushOutbox.pushOutboxId,
          pushDeviceId: pushOutbox.pushDeviceId,
          expoTicketId: pushOutbox.expoTicketId,
        })
        .from(pushOutbox)
        .innerJoin(pushDevices, eq(pushDevices.pushDeviceId, pushOutbox.pushDeviceId))
        .where(
          and(
            isNull(pushDevices.disabledAt),
            isNotNull(pushOutbox.expoTicketId),
            or(
              and(eq(pushOutbox.status, "TICKETED"), lte(pushOutbox.receiptAvailableAt, now)),
              and(eq(pushOutbox.status, "PROCESSING"), lte(pushOutbox.claimedAt, staleAt)),
            ),
          ),
        )
        .orderBy(asc(pushOutbox.receiptAvailableAt), asc(pushOutbox.createdAt), asc(pushOutbox.pushOutboxId))
        .limit(Math.min(Math.max(Math.trunc(limit), 0), 1_000))
        .for("update", { of: pushOutbox, skipLocked: true });
      if (!candidates.length) return [];
      const claimToken = randomUUID();
      const claimed = await tx
        .update(pushOutbox)
        .set({
          attemptCount: sql`${pushOutbox.attemptCount} + 1`,
          claimedAt: now,
          claimToken,
          status: "PROCESSING",
          updatedAt: now,
        })
        .where(
          inArray(
            pushOutbox.pushOutboxId,
            candidates.map(({ pushOutboxId }) => pushOutboxId),
          ),
        )
        .returning({ pushOutboxId: pushOutbox.pushOutboxId, attemptCount: pushOutbox.attemptCount });
      const attempts = new Map(claimed.map((row) => [row.pushOutboxId, row.attemptCount]));
      return candidates.map((candidate) => {
        if (!candidate.expoTicketId) throw new Error("Push receipt ticket is missing");
        return {
          pushOutboxId: candidate.pushOutboxId,
          pushDeviceId: candidate.pushDeviceId,
          expoTicketId: candidate.expoTicketId,
          claimToken,
          attemptCount: requireResult(attempts.get(candidate.pushOutboxId)),
        };
      });
    });

  persistPushTickets = async (
    claims: readonly ClaimedPushSend[],
    tickets: readonly ExpoPushTicket[],
    now = new Date(),
  ) => {
    if (claims.length !== tickets.length) throw new Error("Expo Push ticket count mismatch");
    if (!claims.length) return;
    await this.db.transaction(async (tx) => {
      await this.lockPushClaims(tx, claims);
      const invalidDeviceIds = [
        ...new Set(
          claims
            .filter((_, index) => deviceNotRegistered(requireResult(tickets[index])))
            .map(({ pushDeviceId }) => pushDeviceId),
        ),
      ];
      await this.disableDeviceIds(tx, invalidDeviceIds, "DEVICE_NOT_REGISTERED");
      const validResults = claims
        .map((claim, index) => ({ claim, ticket: requireResult(tickets[index]) }))
        .filter(({ claim }) => !invalidDeviceIds.includes(claim.pushDeviceId));
      const accepted = validResults.filter(
        (result): result is { claim: ClaimedPushSend; ticket: Extract<ExpoPushTicket, { status: "ok" }> } =>
          result.ticket.status === "ok",
      );
      if (accepted.length) {
        const values = sql.join(
          accepted.map(({ claim, ticket }) => sql`(${claim.pushOutboxId}::uuid, ${ticket.id}::text)`),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE "pushOutbox" AS outbox
          SET status = 'TICKETED',
              "attemptCount" = 0,
              "claimToken" = NULL,
              "claimedAt" = NULL,
              "expoTicketId" = ticket."expoTicketId",
              "receiptAvailableAt" = ${new Date(now.getTime() + PUSH_RECEIPT_DELAY_MS)},
              "lastError" = NULL,
              "updatedAt" = ${now}
          FROM (VALUES ${values}) AS ticket("pushOutboxId", "expoTicketId")
          WHERE outbox."pushOutboxId" = ticket."pushOutboxId"
        `);
      }
      const rejected = validResults.filter(
        (result): result is { claim: ClaimedPushSend; ticket: Extract<ExpoPushTicket, { status: "error" }> } =>
          result.ticket.status === "error",
      );
      if (rejected.length) {
        const values = sql.join(
          rejected.map(({ claim, ticket }) => sql`(${claim.pushOutboxId}::uuid, ${expoErrorMessage(ticket)}::text)`),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE "pushOutbox" AS outbox
          SET status = 'FAILED',
              "claimToken" = NULL,
              "claimedAt" = NULL,
              "lastError" = result.error,
              "updatedAt" = ${now}
          FROM (VALUES ${values}) AS result("pushOutboxId", error)
          WHERE outbox."pushOutboxId" = result."pushOutboxId"
        `);
      }
    });
  };

  persistPushReceipts = async (
    claims: readonly ClaimedPushReceipt[],
    receipts: Readonly<Record<string, ExpoPushReceipt>>,
    now = new Date(),
  ) => {
    if (
      Object.keys(receipts).length !== claims.length ||
      claims.some(({ expoTicketId }) => !Object.prototype.hasOwnProperty.call(receipts, expoTicketId))
    )
      throw new Error("Expo Push receipt count mismatch");
    if (!claims.length) return;
    await this.db.transaction(async (tx) => {
      await this.lockPushClaims(tx, claims);
      const invalidDeviceIds = [
        ...new Set(
          claims
            .filter(({ expoTicketId }) => deviceNotRegistered(requireResult(receipts[expoTicketId])))
            .map(({ pushDeviceId }) => pushDeviceId),
        ),
      ];
      await this.disableDeviceIds(tx, invalidDeviceIds, "DEVICE_NOT_REGISTERED");
      const validClaims = claims.filter(({ pushDeviceId }) => !invalidDeviceIds.includes(pushDeviceId));
      const acceptedIds = validClaims
        .filter(({ expoTicketId }) => requireResult(receipts[expoTicketId]).status === "ok")
        .map(({ pushOutboxId }) => pushOutboxId);
      if (acceptedIds.length)
        await tx
          .update(pushOutbox)
          .set({ status: "RECEIPT_OK", claimToken: null, claimedAt: null, lastError: null, updatedAt: now })
          .where(inArray(pushOutbox.pushOutboxId, acceptedIds));
      const rejected = validClaims.flatMap((claim) => {
        const receipt = requireResult(receipts[claim.expoTicketId]);
        return receipt.status === "error" ? [{ claim, receipt }] : [];
      });
      if (rejected.length) {
        const values = sql.join(
          rejected.map(({ claim, receipt }) => sql`(${claim.pushOutboxId}::uuid, ${expoErrorMessage(receipt)}::text)`),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE "pushOutbox" AS outbox
          SET status = 'FAILED',
              "claimToken" = NULL,
              "claimedAt" = NULL,
              "lastError" = result.error,
              "updatedAt" = ${now}
          FROM (VALUES ${values}) AS result("pushOutboxId", error)
          WHERE outbox."pushOutboxId" = result."pushOutboxId"
        `);
      }
    });
  };

  retryPushClaims = async (claims: readonly PushClaim[], error: unknown, now = new Date()) => {
    if (!claims.length) return;
    await this.db.transaction(async (tx) => {
      await this.lockPushClaims(tx, claims);
      const retryable = claims.filter(({ attemptCount }) => attemptCount < PUSH_MAX_ATTEMPTS);
      const retryAt = (attemptCount: number) => new Date(now.getTime() + Math.min(2 ** attemptCount, 300) * 1_000);
      const sendRetries = retryable.filter((claim) => !("expoTicketId" in claim));
      if (sendRetries.length) {
        const values = sql.join(
          sendRetries.map((claim) => sql`(${claim.pushOutboxId}::uuid, ${retryAt(claim.attemptCount)}::timestamptz)`),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE "pushOutbox" AS outbox
          SET status = 'PENDING',
              "availableAt" = result."retryAt",
              "claimToken" = NULL,
              "claimedAt" = NULL,
              "lastError" = ${pushErrorMessage(error)},
              "updatedAt" = ${now}
          FROM (VALUES ${values}) AS result("pushOutboxId", "retryAt")
          WHERE outbox."pushOutboxId" = result."pushOutboxId"
        `);
      }
      const receiptRetries = retryable.filter(
        (claim): claim is ClaimedPushReceipt => "expoTicketId" in claim && typeof claim.expoTicketId === "string",
      );
      if (receiptRetries.length) {
        const values = sql.join(
          receiptRetries.map(
            (claim) => sql`(${claim.pushOutboxId}::uuid, ${retryAt(claim.attemptCount)}::timestamptz)`,
          ),
          sql`, `,
        );
        await tx.execute(sql`
          UPDATE "pushOutbox" AS outbox
          SET status = 'TICKETED',
              "receiptAvailableAt" = result."retryAt",
              "claimToken" = NULL,
              "claimedAt" = NULL,
              "lastError" = ${pushErrorMessage(error)},
              "updatedAt" = ${now}
          FROM (VALUES ${values}) AS result("pushOutboxId", "retryAt")
          WHERE outbox."pushOutboxId" = result."pushOutboxId"
        `);
      }
      const terminalIds = claims
        .filter(({ attemptCount }) => attemptCount >= PUSH_MAX_ATTEMPTS)
        .map(({ pushOutboxId }) => pushOutboxId);
      if (terminalIds.length)
        await tx
          .update(pushOutbox)
          .set({
            status: "FAILED",
            claimToken: null,
            claimedAt: null,
            lastError: pushErrorMessage(error),
            updatedAt: now,
          })
          .where(inArray(pushOutbox.pushOutboxId, terminalIds));
    });
  };

  failPushClaims = async (claims: readonly PushClaim[], error: unknown, now = new Date()) => {
    if (!claims.length) return;
    await this.db.transaction(async (tx) => {
      await this.lockPushClaims(tx, claims);
      await tx
        .update(pushOutbox)
        .set({
          status: "FAILED",
          claimToken: null,
          claimedAt: null,
          lastError: pushErrorMessage(error),
          updatedAt: now,
        })
        .where(
          inArray(
            pushOutbox.pushOutboxId,
            claims.map(({ pushOutboxId }) => pushOutboxId),
          ),
        );
    });
  };

  purgeTerminalPushDeliveries = async (now = new Date()) => {
    const retainedAfter = new Date(now.getTime() - PUSH_TERMINAL_RETENTION_MS);
    const result = await this.db.execute<{ pushOutboxId: string }>(sql`
      WITH candidates AS (
        SELECT "pushOutboxId"
        FROM "pushOutbox"
        WHERE status IN ('RECEIPT_OK', 'FAILED')
          AND "updatedAt" <= ${retainedAfter}
        ORDER BY "updatedAt", "pushOutboxId"
        FOR UPDATE SKIP LOCKED
        LIMIT ${PUSH_TERMINAL_RETENTION_BATCH_SIZE}
      )
      DELETE FROM "pushOutbox" AS outbox
      USING candidates
      WHERE outbox."pushOutboxId" = candidates."pushOutboxId"
      RETURNING outbox."pushOutboxId"
    `);
    return result.rows.length;
  };

  private failUnavailablePushDeliveries = async (store: DatabaseTransaction, now: Date) => {
    const staleAt = new Date(now.getTime() - PUSH_CLAIM_STALE_MS);
    await store
      .update(pushOutbox)
      .set({
        status: "FAILED",
        claimToken: null,
        claimedAt: null,
        lastError: "DEVICE_DISABLED",
        updatedAt: now,
      })
      .where(
        and(
          inArray(pushOutbox.status, unsettledStatuses),
          sql`EXISTS (
            SELECT 1 FROM ${pushDevices}
            WHERE ${pushDevices.pushDeviceId} = ${pushOutbox.pushDeviceId}
              AND ${pushDevices.disabledAt} IS NOT NULL
          )`,
        ),
      );
    await store
      .update(pushOutbox)
      .set({
        status: "FAILED",
        claimToken: null,
        claimedAt: null,
        lastError: "MAX_ATTEMPTS_EXCEEDED",
        updatedAt: now,
      })
      .where(
        and(
          gte(pushOutbox.attemptCount, PUSH_MAX_ATTEMPTS),
          or(
            inArray(pushOutbox.status, ["PENDING", "TICKETED"]),
            and(eq(pushOutbox.status, "PROCESSING"), lte(pushOutbox.claimedAt, staleAt)),
          ),
        ),
      );
  };

  private lockPushClaims = async (store: DatabaseTransaction, claims: readonly PushClaim[]) => {
    const pushOutboxIds = claims.map(({ pushOutboxId }) => pushOutboxId);
    if (new Set(pushOutboxIds).size !== claims.length) throw new Error("Push delivery claim was lost");
    const pushDeviceIds = [...new Set(claims.map(({ pushDeviceId }) => pushDeviceId))];
    await store
      .select({ userId: pushDevices.userId, pushDeviceId: pushDevices.pushDeviceId })
      .from(pushDevices)
      .where(inArray(pushDevices.pushDeviceId, pushDeviceIds))
      .orderBy(pushDevices.userId, pushDevices.pushDeviceId)
      .for("update");
    const rows = await store
      .select({
        pushOutboxId: pushOutbox.pushOutboxId,
        pushDeviceId: pushOutbox.pushDeviceId,
        claimToken: pushOutbox.claimToken,
        status: pushOutbox.status,
        expoTicketId: pushOutbox.expoTicketId,
      })
      .from(pushOutbox)
      .where(inArray(pushOutbox.pushOutboxId, pushOutboxIds))
      .orderBy(pushOutbox.pushOutboxId)
      .for("update");
    const byId = new Map(rows.map((row) => [row.pushOutboxId, row]));
    const lost = claims.some((claim) => {
      const row = byId.get(claim.pushOutboxId);
      const expoTicketId = "expoTicketId" in claim ? claim.expoTicketId : null;
      return (
        !row ||
        row.pushDeviceId !== claim.pushDeviceId ||
        row.claimToken !== claim.claimToken ||
        row.status !== "PROCESSING" ||
        row.expoTicketId !== (expoTicketId ?? null)
      );
    });
    if (lost) throw new Error("Push delivery claim was lost");
  };

  private activeEligibleDevices = async (
    store: DatabaseTransaction,
    userId: string,
    preferenceCategory: NotificationPreferenceCategory,
  ) => {
    await store.insert(notificationPreferences).values({ userId }).onConflictDoNothing();
    const [preferences] = await store
      .select({
        pushEnabled: notificationPreferences.pushEnabled,
        categoryEnabled: notificationPreferences[preferenceCategory],
      })
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, userId))
      .limit(1)
      .for("share");
    const eligiblePreferences = requireResult(preferences);
    if (!eligiblePreferences.pushEnabled || !eligiblePreferences.categoryEnabled) return [];
    return store
      .select({ pushDeviceId: pushDevices.pushDeviceId })
      .from(pushDevices)
      .where(and(eq(pushDevices.userId, userId), isNull(pushDevices.disabledAt)))
      .orderBy(pushDevices.pushDeviceId)
      .for("share");
  };

  private disableDeviceIds = async (store: DatabaseTransaction, pushDeviceIds: string[], reason: string) => {
    if (!pushDeviceIds.length) return;
    await this.failUnsettled(store, pushDeviceIds, reason);
    await store
      .update(pushDevices)
      .set({
        disabledAt: sql`COALESCE(${pushDevices.disabledAt}, transaction_timestamp())`,
        disabledReason: sql`COALESCE(${pushDevices.disabledReason}, ${reason})`,
        updatedAt: sql`transaction_timestamp()`,
      })
      .where(inArray(pushDevices.pushDeviceId, pushDeviceIds));
  };

  private failUnsettled = async (store: DatabaseTransaction, pushDeviceIds: string[], reason: string) => {
    if (!pushDeviceIds.length) return;
    await store
      .update(pushOutbox)
      .set({
        status: "FAILED",
        claimToken: null,
        claimedAt: null,
        lastError: reason,
        updatedAt: sql`transaction_timestamp()`,
      })
      .where(and(inArray(pushOutbox.pushDeviceId, pushDeviceIds), inArray(pushOutbox.status, unsettledStatuses)));
  };
}
