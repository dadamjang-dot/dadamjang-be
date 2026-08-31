import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { FIXTURE } from "src/database/fixtures";
import { resetTestFixtures, testPool } from "./support/database";

const SECOND_USER = {
  userId: "10000000-0000-4000-8000-000000000002",
  userid: "notification-partner",
  email: "notification-partner@example.test",
} as const;

const signin = async (app: INestApplication, deviceId: string, userid: string = FIXTURE.userid) => {
  const response = await request(app.getHttpServer())
    .post("/graphql")
    .set("x-device-id", deviceId)
    .send({
      query: `mutation NotificationSignin($input: SigninAuthInput!) {
        signin(input: $input) { accessToken refreshToken }
      }`,
      variables: { input: { userid, password: FIXTURE.password, portal: "FO" } },
    });
  expect(response.body.errors).toBeUndefined();
  return response.body.data.signin as { accessToken: string; refreshToken: string };
};

const authenticated = (
  app: INestApplication,
  accessToken: string,
  deviceId: string,
  query: string,
  variables?: Record<string, unknown>,
) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .set("x-device-id", deviceId)
    .send({ query, variables });

const registerDevice = (app: INestApplication, accessToken: string, deviceId: string, expoPushToken: string) =>
  authenticated(
    app,
    accessToken,
    deviceId,
    `mutation RegisterFoPushDevice($input: RegisterFoPushDeviceInput!) {
      registerFoPushDevice(input: $input)
    }`,
    { input: { expoPushToken, platform: "IOS" } },
  );

const seedSecondUser = (pool: Pool) =>
  pool.query(
    `INSERT INTO users ("userId", userid, email, password, role)
     SELECT $1, $2, $3, password, 'PARTNER' FROM users WHERE "userId" = $4`,
    [SECOND_USER.userId, SECOND_USER.userid, SECOND_USER.email, FIXTURE.userId],
  );

const insertNotification = (
  pool: Pool,
  input: {
    notificationId?: string;
    userId?: string;
    dedupeKey: string;
    createdAt?: string;
    read?: boolean;
  },
) => {
  const notificationId = input.notificationId ?? randomUUID();
  return pool
    .query(
      `INSERT INTO notifications
        ("notificationId", "userId", type, title, body, route, "entityId", "dedupeKey", "readAt", "createdAt")
       VALUES ($1, $2, 'ORDER_STATUS', 'Title', 'Body', '/order/90000000-0000-4000-8000-000000000001',
         '90000000-0000-4000-8000-000000000001', $3,
         CASE WHEN $4 THEN transaction_timestamp() ELSE NULL END,
         COALESCE($5::timestamptz, transaction_timestamp()))`,
      [notificationId, input.userId ?? FIXTURE.userId, input.dedupeKey, input.read ?? false, input.createdAt ?? null],
    )
    .then(() => notificationId);
};

const seedUnsettledDeliveries = async (pool: Pool, userId: string, pushDeviceId: string) => {
  const pendingNotificationId = await insertNotification(pool, { userId, dedupeKey: randomUUID() });
  const processingNotificationId = await insertNotification(pool, { userId, dedupeKey: randomUUID() });
  const ticketedNotificationId = await insertNotification(pool, { userId, dedupeKey: randomUUID() });
  await pool.query(`INSERT INTO "pushOutbox" ("notificationId", "pushDeviceId") VALUES ($1, $2)`, [
    pendingNotificationId,
    pushDeviceId,
  ]);
  await pool.query(
    `INSERT INTO "pushOutbox"
      ("notificationId", "pushDeviceId", status, "claimToken", "claimedAt")
     VALUES ($1, $2, 'PROCESSING', $3, transaction_timestamp())`,
    [processingNotificationId, pushDeviceId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO "pushOutbox"
      ("notificationId", "pushDeviceId", status, "expoTicketId", "receiptAvailableAt")
     VALUES ($1, $2, 'TICKETED', 'ticket-1', transaction_timestamp())`,
    [ticketedNotificationId, pushDeviceId],
  );
};

const expectFailedDeliveries = async (pool: Pool, pushDeviceId: string) => {
  const deliveries = await pool.query<{
    status: string;
    claimToken: string | null;
    claimedAt: Date | null;
  }>(
    `SELECT status, "claimToken", "claimedAt"
     FROM "pushOutbox" WHERE "pushDeviceId" = $1 ORDER BY status`,
    [pushDeviceId],
  );
  expect(deliveries.rows).toHaveLength(3);
  expect(deliveries.rows).toEqual(deliveries.rows.map(() => ({ status: "FAILED", claimToken: null, claimedAt: null })));
};

const expectDisabledDeliveries = async (pool: Pool, pushDeviceId: string) => {
  const device = await pool.query<{ disabledAt: Date | null; disabledReason: string | null }>(
    `SELECT "disabledAt", "disabledReason" FROM "pushDevices" WHERE "pushDeviceId" = $1`,
    [pushDeviceId],
  );
  expect(device.rows[0]).toEqual({ disabledAt: expect.any(Date), disabledReason: expect.any(String) });
  await expectFailedDeliveries(pool, pushDeviceId);
  const claimable = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM "pushOutbox" outbox
     INNER JOIN "pushDevices" device ON device."pushDeviceId" = outbox."pushDeviceId"
     WHERE outbox."pushDeviceId" = $1 AND outbox.status = 'PENDING' AND device."disabledAt" IS NULL`,
    [pushDeviceId],
  );
  expect(claimable.rows[0]?.count).toBe(0);
};

describe("FO notification GraphQL integration", () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    pool = testPool();
    app = await createApp();
    await app.listen(0, "127.0.0.1");
  });

  beforeEach(async () => {
    await resetTestFixtures(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("paginates by createdAt and notificationId while reporting all unread rows", async () => {
    const deviceId = "notification-pagination-device";
    const token = await signin(app, deviceId);
    const createdAt = "2026-08-31T01:00:00.000Z";
    const oldestId = "81000000-0000-4000-8000-000000000001";
    const middleId = "81000000-0000-4000-8000-000000000002";
    const newestId = "81000000-0000-4000-8000-000000000003";
    await insertNotification(pool, { notificationId: oldestId, dedupeKey: "oldest", createdAt });
    await insertNotification(pool, { notificationId: middleId, dedupeKey: "middle", createdAt });
    await insertNotification(pool, { notificationId: newestId, dedupeKey: "newest", createdAt, read: true });

    const firstPage = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `query FoNotifications($first: Int, $after: String) {
        foNotifications(first: $first, after: $after) {
          nodes { notificationId type title body route entityId readAt createdAt }
          nextCursor hasNextPage unreadCount
        }
      }`,
      { first: 1 },
    );

    expect(firstPage.body.errors).toBeUndefined();
    expect(firstPage.body.data.foNotifications).toMatchObject({
      nodes: [{ notificationId: newestId, type: "ORDER_STATUS" }],
      hasNextPage: true,
      unreadCount: 2,
    });
    const secondPage = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `query FoNotifications($first: Int, $after: String) {
        foNotifications(first: $first, after: $after) {
          nodes { notificationId }
          nextCursor hasNextPage unreadCount
        }
      }`,
      { first: 1, after: firstPage.body.data.foNotifications.nextCursor },
    );
    expect(secondPage.body.data.foNotifications).toMatchObject({
      nodes: [{ notificationId: middleId }],
      hasNextPage: true,
      unreadCount: 2,
    });
  });

  it("defaults pages to 30 and serves the maximum page size of 100", async () => {
    const deviceId = "notification-page-boundary-device";
    const token = await signin(app, deviceId);
    await pool.query(
      `INSERT INTO notifications ("userId", type, title, body, route, "entityId", "dedupeKey", "createdAt")
       SELECT $1, 'ORDER_STATUS', 'Title', 'Body', '/order/90000000-0000-4000-8000-000000000001',
         '90000000-0000-4000-8000-000000000001', 'bulk-' || value,
         transaction_timestamp() - value * interval '1 second'
       FROM generate_series(1, 101) AS value`,
      [FIXTURE.userId],
    );

    const defaultPage = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `query DefaultFoNotifications { foNotifications { nodes { notificationId } hasNextPage } }`,
    );
    const cappedPage = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `query CappedFoNotifications { foNotifications(first: 100) { nodes { notificationId } hasNextPage } }`,
    );

    expect(defaultPage.body.data.foNotifications).toMatchObject({ hasNextPage: true });
    expect(defaultPage.body.data.foNotifications.nodes).toHaveLength(30);
    expect(cappedPage.body.data.foNotifications).toMatchObject({ hasNextPage: true });
    expect(cappedPage.body.data.foNotifications.nodes).toHaveLength(100);
  });

  it("authorizes singular lookup and read mutations by the authenticated owner", async () => {
    const deviceId = "notification-read-device";
    const token = await signin(app, deviceId);
    await seedSecondUser(pool);
    const ownId = await insertNotification(pool, { dedupeKey: "own-read" });
    const otherId = await insertNotification(pool, {
      userId: SECOND_USER.userId,
      dedupeKey: "other-read",
    });

    const own = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `query FoNotification($notificationId: ID!) {
        foNotification(notificationId: $notificationId) { notificationId readAt }
      }`,
      { notificationId: ownId },
    );
    const crossUserLookup = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `query FoNotification($notificationId: ID!) {
        foNotification(notificationId: $notificationId) { notificationId }
      }`,
      { notificationId: otherId },
    );
    const crossUserRead = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `mutation MarkFoNotificationRead($notificationId: ID!) {
        markFoNotificationRead(notificationId: $notificationId) { notificationId }
      }`,
      { notificationId: otherId },
    );
    const marked = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `mutation MarkFoNotificationRead($notificationId: ID!) {
        markFoNotificationRead(notificationId: $notificationId) { notificationId readAt }
      }`,
      { notificationId: ownId },
    );
    const allMarked = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `mutation MarkAllFoNotificationsRead { markAllFoNotificationsRead }`,
    );
    const unread = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `query FoNotifications { foNotifications { unreadCount nodes { notificationId } } }`,
    );

    expect(own.body.data.foNotification).toMatchObject({ notificationId: ownId, readAt: null });
    expect(crossUserLookup.body.errors[0].extensions.code).toBe("NOT_FOUND");
    expect(crossUserRead.body.errors[0].extensions.code).toBe("NOT_FOUND");
    expect(marked.body.data.markFoNotificationRead).toEqual({ notificationId: ownId, readAt: expect.any(String) });
    expect(allMarked.body).toEqual({ data: { markAllFoNotificationsRead: true } });
    expect(unread.body.data.foNotifications.unreadCount).toBe(0);
  });

  it("returns default preferences and preserves omitted fields in partial updates", async () => {
    const deviceId = "notification-preference-device";
    const token = await signin(app, deviceId);

    const defaults = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `query FoNotificationPreferences {
        foNotificationPreferences {
          pushEnabled orderPushEnabled wishPushEnabled stylePushEnabled updatedAt
        }
      }`,
    );
    const updated = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `mutation UpdateFoNotificationPreferences($input: UpdateFoNotificationPreferencesInput!) {
        updateFoNotificationPreferences(input: $input) {
          pushEnabled orderPushEnabled wishPushEnabled stylePushEnabled updatedAt
        }
      }`,
      { input: { wishPushEnabled: false } },
    );

    expect(defaults.body.data.foNotificationPreferences).toEqual({
      pushEnabled: true,
      orderPushEnabled: true,
      wishPushEnabled: true,
      stylePushEnabled: true,
      updatedAt: expect.any(String),
    });
    expect(updated.body.data.updateFoNotificationPreferences).toEqual({
      pushEnabled: true,
      orderPushEnabled: true,
      wishPushEnabled: false,
      stylePushEnabled: true,
      updatedAt: expect.any(String),
    });
  });

  it("transfers installations and tokens only for active FO refresh sessions", async () => {
    const sharedDevice = "notification-shared-device";
    const secondDevice = "notification-second-device";
    const expoPushToken = "ExponentPushToken[notification-shared-token]";
    const first = await signin(app, sharedDevice);
    expect((await registerDevice(app, first.accessToken, sharedDevice, expoPushToken)).body).toEqual({
      data: { registerFoPushDevice: true },
    });
    const originalDevice = await pool.query<{ pushDeviceId: string }>(
      `SELECT "pushDeviceId" FROM "pushDevices" WHERE "installationId" = $1`,
      [sharedDevice],
    );
    const pushDeviceId = originalDevice.rows[0]?.pushDeviceId as string;
    await seedUnsettledDeliveries(pool, FIXTURE.userId, pushDeviceId);
    await seedSecondUser(pool);
    const second = await signin(app, sharedDevice, SECOND_USER.userid);
    expect((await registerDevice(app, second.accessToken, sharedDevice, expoPushToken)).body).toEqual({
      data: { registerFoPushDevice: true },
    });
    await expectFailedDeliveries(pool, pushDeviceId);
    const secondInstallation = await signin(app, secondDevice, SECOND_USER.userid);
    expect((await registerDevice(app, secondInstallation.accessToken, secondDevice, expoPushToken)).body).toEqual({
      data: { registerFoPushDevice: true },
    });

    const transferred = await pool.query<{
      userId: string;
      installationId: string;
      disabledAt: Date | null;
    }>(`SELECT "userId", "installationId", "disabledAt" FROM "pushDevices" WHERE "expoPushToken" = $1`, [
      expoPushToken,
    ]);
    expect(transferred.rows[0]).toEqual({
      userId: SECOND_USER.userId,
      installationId: secondDevice,
      disabledAt: null,
    });

    const missingSession = await registerDevice(
      app,
      secondInstallation.accessToken,
      "notification-no-session",
      "ExponentPushToken[notification-no-session]",
    );
    expect(missingSession.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
  });

  it("keeps DeviceNotRegistered tokens terminal until the installation receives a new token", async () => {
    const deviceId = "notification-invalid-token-device";
    const invalidToken = "ExponentPushToken[notification-invalid-token]";
    const replacementToken = "ExponentPushToken[notification-replacement-token]";
    const token = await signin(app, deviceId);
    await registerDevice(app, token.accessToken, deviceId, invalidToken);
    await pool.query(
      `UPDATE "pushDevices"
       SET "disabledAt" = transaction_timestamp(), "disabledReason" = 'DEVICE_NOT_REGISTERED'
       WHERE "expoPushToken" = $1`,
      [invalidToken],
    );

    const rejected = await registerDevice(app, token.accessToken, deviceId, invalidToken);
    const stillDisabled = await pool.query<{ disabledReason: string | null }>(
      `SELECT "disabledReason" FROM "pushDevices" WHERE "expoPushToken" = $1`,
      [invalidToken],
    );
    const replaced = await registerDevice(app, token.accessToken, deviceId, replacementToken);
    const active = await pool.query<{ expoPushToken: string; disabledAt: Date | null; disabledReason: string | null }>(
      `SELECT "expoPushToken", "disabledAt", "disabledReason"
       FROM "pushDevices" WHERE "installationId" = $1`,
      [deviceId],
    );

    expect(rejected.body).toEqual({ data: { registerFoPushDevice: false } });
    expect(stillDisabled.rows[0]).toEqual({ disabledReason: "DEVICE_NOT_REGISTERED" });
    expect(replaced.body).toEqual({ data: { registerFoPushDevice: true } });
    expect(active.rows[0]).toEqual({ expoPushToken: replacementToken, disabledAt: null, disabledReason: null });
  });

  it("disables a device and terminally fails unsettled deliveries on unregister", async () => {
    const deviceId = "notification-unregister-device";
    const token = await signin(app, deviceId);
    await registerDevice(app, token.accessToken, deviceId, "ExponentPushToken[notification-unregister]");
    const device = await pool.query<{ pushDeviceId: string }>(
      `SELECT "pushDeviceId" FROM "pushDevices" WHERE "installationId" = $1`,
      [deviceId],
    );
    const pushDeviceId = device.rows[0]?.pushDeviceId as string;
    await seedUnsettledDeliveries(pool, FIXTURE.userId, pushDeviceId);

    const response = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `mutation UnregisterFoPushDevice { unregisterFoPushDevice }`,
    );

    expect(response.body).toEqual({ data: { unregisterFoPushDevice: true } });
    await expectDisabledDeliveries(pool, pushDeviceId);
  });

  it("deletes the refresh session and disables its Push delivery state in one logout", async () => {
    const deviceId = "notification-logout-device";
    const token = await signin(app, deviceId);
    await registerDevice(app, token.accessToken, deviceId, "ExponentPushToken[notification-logout]");
    const device = await pool.query<{ pushDeviceId: string }>(
      `SELECT "pushDeviceId" FROM "pushDevices" WHERE "installationId" = $1`,
      [deviceId],
    );
    const pushDeviceId = device.rows[0]?.pushDeviceId as string;
    await seedUnsettledDeliveries(pool, FIXTURE.userId, pushDeviceId);

    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("Authorization", `Bearer ${token.refreshToken}`)
      .send({ query: `mutation NotificationLogout { logout }` });

    expect(response.body).toEqual({ data: { logout: true } });
    const sessions = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "refreshToken" WHERE "userId" = $1 AND "deviceId" = $2`,
      [FIXTURE.userId, deviceId],
    );
    expect(sessions.rows[0]?.count).toBe(0);
    await expectDisabledDeliveries(pool, pushDeviceId);
  });

  it("rejects unauthenticated inbox access", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `query FoNotifications { foNotifications { unreadCount } }` });

    expect(response.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
  });
});
