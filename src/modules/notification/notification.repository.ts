import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
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

export type FoNotificationCursor = { createdAt: Date; notificationId: string };

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

  hasActiveRefreshSession = async (store: DatabaseTransaction, userId: string, installationId: string) =>
    Boolean(
      await store.query.refreshTokens.findFirst({
        columns: { id: true },
        where: and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.deviceId, installationId),
          gt(refreshTokens.refreshTokenExp, sql`transaction_timestamp()`),
        ),
      }),
    );

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
      .orderBy(pushDevices.pushDeviceId)
      .for("update");
    const tokenDevice = devices.find(({ expoPushToken }) => expoPushToken === input.expoPushToken);
    if (tokenDevice?.disabledReason === "DEVICE_NOT_REGISTERED") return false;
    const installationDevice = devices.find(({ installationId }) => installationId === input.installationId);
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
      .for("update");
    await this.disableDeviceIds(
      store,
      devices.map(({ pushDeviceId }) => pushDeviceId),
      reason,
    );
  };

  deleteUserData = async (store: DatabaseTransaction, userId: string) => {
    const notificationIds = store
      .select({ notificationId: notifications.notificationId })
      .from(notifications)
      .where(eq(notifications.userId, userId));
    const deviceIds = store
      .select({ pushDeviceId: pushDevices.pushDeviceId })
      .from(pushDevices)
      .where(eq(pushDevices.userId, userId));
    await store
      .delete(pushOutbox)
      .where(or(inArray(pushOutbox.notificationId, notificationIds), inArray(pushOutbox.pushDeviceId, deviceIds)));
    await store.delete(notifications).where(eq(notifications.userId, userId));
    await store.delete(notificationPreferences).where(eq(notificationPreferences.userId, userId));
    await store.delete(pushDevices).where(eq(pushDevices.userId, userId));
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
