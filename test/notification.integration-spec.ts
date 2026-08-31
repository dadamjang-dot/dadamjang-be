import type { INestApplication } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import type { Pool, PoolClient } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { FIXTURE } from "src/database/fixtures";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { NotificationRepository } from "src/modules/notification/notification.repository";
import { NotificationService } from "src/modules/notification/notification.service";
import { NotificationOutboxWorker } from "src/modules/notification/notification.outbox";
import {
  ExpoPushSender,
  RetryablePushError,
  type ExpoPushMessage,
  type ExpoPushReceipt,
} from "src/modules/notification/notification.sender";
import { FoPushPlatform } from "src/modules/notification/notification.types";
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

const waitFor = async (condition: () => Promise<boolean>) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for notification lock barrier");
};

const postgresErrorCode = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return null;
  if ("code" in value && typeof value.code === "string") return value.code;
  return "cause" in value ? postgresErrorCode(value.cause) : null;
};

const startPushDeviceBlocker = async (pool: Pool, pushDeviceIds: string | readonly string[]) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '30s'");
    await client.query(
      `SELECT "pushDeviceId"
       FROM "pushDevices"
       WHERE "pushDeviceId" = ANY($1::uuid[])
       ORDER BY "pushDeviceId"
       FOR UPDATE`,
      [typeof pushDeviceIds === "string" ? [pushDeviceIds] : pushDeviceIds],
    );
    const pid = (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]?.pid;
    if (!pid) throw new Error("Failed to identify notification blocker");
    return { client, pid };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw error;
  }
};

const blockedQueries = async (pool: Pool, blockerPid: number) => {
  const result = await pool.query<{ query: string }>(
    `WITH RECURSIVE blocked(pid) AS (
       SELECT pid
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND $1 = ANY(pg_blocking_pids(pid))
       UNION
       SELECT activity.pid
       FROM pg_stat_activity activity
       INNER JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
       WHERE activity.datname = current_database()
         AND activity.pid <> pg_backend_pid()
     )
     SELECT activity.query
     FROM pg_stat_activity activity
     INNER JOIN blocked ON blocked.pid = activity.pid
     ORDER BY activity.pid`,
    [blockerPid],
  );
  return result.rows.map(({ query }) => query);
};

const rowCanBeLocked = async (pool: Pool, query: string, values: readonly unknown[]) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '100ms'");
    await client.query(query, [...values]);
    await client.query("ROLLBACK");
    return true;
  } catch {
    await client.query("ROLLBACK").catch(() => undefined);
    return false;
  } finally {
    client.release();
  }
};

const releaseBlocker = async (client: PoolClient) => {
  await client.query("COMMIT");
  client.release();
};

const rollbackBlocker = async (client: PoolClient) => {
  await client.query("ROLLBACK").catch(() => undefined);
  client.release();
};

const raceAfterQueuedRegistration = async <T>(
  pool: Pool,
  pushDeviceId: string,
  userId: string,
  installationId: string,
  registration: () => PromiseLike<request.Response>,
  participant: () => PromiseLike<T>,
) => {
  const blocker = await startPushDeviceBlocker(pool, pushDeviceId);
  const registrationRequest = Promise.resolve(registration());
  let participantRequest: Promise<T> | undefined;
  let released = false;
  try {
    await waitFor(async () => (await blockedQueries(pool, blocker.pid)).length === 1);
    const refreshSessionCanBeLocked = await rowCanBeLocked(
      pool,
      `SELECT id FROM "refreshToken" WHERE "userId" = $1 AND "deviceId" = $2 FOR UPDATE NOWAIT`,
      [userId, installationId],
    );
    participantRequest = Promise.resolve(participant());
    await waitFor(async () => (await blockedQueries(pool, blocker.pid)).length >= 2);
    const queries = await blockedQueries(pool, blocker.pid);
    await releaseBlocker(blocker.client);
    released = true;
    const [registrationResponse, participantResponse] = await Promise.all([registrationRequest, participantRequest]);
    return { participantResponse, queries, refreshSessionCanBeLocked, registrationResponse };
  } catch (error) {
    if (!released) await rollbackBlocker(blocker.client);
    await Promise.allSettled([registrationRequest, ...(participantRequest ? [participantRequest] : [])]);
    throw error;
  }
};

const rawCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

const seedSecondUser = (pool: Pool) =>
  pool.query(
    `INSERT INTO users ("userId", userid, email, password, role)
     SELECT $1, $2, $3, password, 'PARTNER' FROM users WHERE "userId" = $4`,
    [SECOND_USER.userId, SECOND_USER.userid, SECOND_USER.email, FIXTURE.userId],
  );

const seedPushDevice = async (pool: Pool, userId: string, key: string, disabled = false) => {
  const pushDeviceId = randomUUID();
  await pool.query(
    `INSERT INTO "pushDevices"
      ("pushDeviceId", "userId", "installationId", "expoPushToken", platform, "disabledAt", "disabledReason")
     VALUES ($1, $2, $3, $4, 'IOS', CASE WHEN $5 THEN transaction_timestamp() ELSE NULL END,
       CASE WHEN $5 THEN 'TEST_DISABLED' ELSE NULL END)`,
    [pushDeviceId, userId, `notification-${key}-installation`, `ExponentPushToken[notification-${key}]`, disabled],
  );
  return pushDeviceId;
};

const createdNotificationRows = async (pool: Pool, userId: string) =>
  (
    await pool.query<{
      type: string;
      title: string;
      body: string;
      route: string;
      entityId: string;
      dedupeKey: string;
    }>(
      `SELECT type, title, body, route, "entityId", "dedupeKey"
       FROM notifications
       WHERE "userId" = $1
       ORDER BY "dedupeKey"`,
      [userId],
    )
  ).rows;

const createdDeliveryRows = async (pool: Pool, userId: string) =>
  (
    await pool.query<{ dedupeKey: string; pushDeviceId: string }>(
      `SELECT notification."dedupeKey", outbox."pushDeviceId"
       FROM "pushOutbox" outbox
       INNER JOIN notifications notification ON notification."notificationId" = outbox."notificationId"
       WHERE notification."userId" = $1
       ORDER BY notification."dedupeKey", outbox."pushDeviceId"`,
      [userId],
    )
  ).rows;

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

const seedPushDelivery = async (
  pool: Pool,
  pushDeviceId: string,
  key: string,
  input?: {
    status?: "PENDING" | "PROCESSING" | "TICKETED" | "RECEIPT_OK" | "FAILED";
    claimToken?: string;
    claimedAt?: Date;
    expoTicketId?: string;
    receiptAvailableAt?: Date;
    attemptCount?: number;
    availableAt?: Date;
    updatedAt?: Date;
    userId?: string;
  },
) => {
  const pushOutboxId = randomUUID();
  const notificationId = await insertNotification(pool, {
    dedupeKey: key,
    ...(input?.userId ? { userId: input.userId } : {}),
  });
  await pool.query(
    `INSERT INTO "pushOutbox"
      ("pushOutboxId", "notificationId", "pushDeviceId", status, "attemptCount", "availableAt",
       "claimToken", "claimedAt", "expoTicketId", "receiptAvailableAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, transaction_timestamp()), $7, $8, $9, $10,
       COALESCE($11, transaction_timestamp()))`,
    [
      pushOutboxId,
      notificationId,
      pushDeviceId,
      input?.status ?? "PENDING",
      input?.attemptCount ?? 0,
      input?.availableAt ?? null,
      input?.claimToken ?? null,
      input?.claimedAt ?? null,
      input?.expoTicketId ?? null,
      input?.receiptAvailableAt ?? null,
      input?.updatedAt ?? null,
    ],
  );
  return { notificationId, pushOutboxId };
};

const recordingPushSender = (input?: {
  send?: (messages: readonly ExpoPushMessage[]) => Promise<
    readonly (
      | { status: "ok"; id: string }
      | {
          status: "error";
          message: string;
          details?: Readonly<{ error?: string }>;
        }
    )[]
  >;
  receipts?: (ticketIds: readonly string[]) => Promise<Readonly<Record<string, ExpoPushReceipt>>>;
}) => {
  const sent: ExpoPushMessage[][] = [];
  const receiptRequests: string[][] = [];
  const sender = {
    send: async (messages: readonly ExpoPushMessage[]) => {
      sent.push([...messages]);
      return input?.send
        ? input.send(messages)
        : messages.map(({ data }) => ({ status: "ok" as const, id: `ticket-${data.notificationId}` }));
    },
    getReceipts: async (ticketIds: readonly string[]) => {
      receiptRequests.push([...ticketIds]);
      return input?.receipts
        ? input.receipts(ticketIds)
        : Object.fromEntries(ticketIds.map((ticketId) => [ticketId, { status: "ok" as const }]));
    },
  };
  return { receiptRequests, sender: sender as ExpoPushSender, sent };
};

const pushWorker = (repository: NotificationRepository, sender: ExpoPushSender) =>
  new NotificationOutboxWorker(repository, { get: () => "false" } as unknown as ConfigService, sender);

describe("FO notification GraphQL integration", () => {
  let app: INestApplication;
  let notificationService: NotificationService;
  let db: Database;
  let notificationRepository: NotificationRepository;
  let pool: Pool;

  beforeAll(async () => {
    pool = testPool();
    app = await createApp();
    await app.listen(0, "127.0.0.1");
    db = app.get(DRIZZLE);
    notificationService = app.get(NotificationService);
    notificationRepository = app.get(NotificationRepository);
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

  it("rejects cursor fields that rely on JSON type coercion", async () => {
    const deviceId = "notification-cursor-validation-device";
    const token = await signin(app, deviceId);
    const notificationId = "81000000-0000-4000-8000-000000000001";
    const payloads = [
      { createdAt: 0, notificationId },
      { createdAt: "2026-08-31T01:00:00.000Z", notificationId: [notificationId] },
    ];

    const responses = await Promise.all(
      payloads.map((payload) =>
        authenticated(
          app,
          token.accessToken,
          deviceId,
          `query InvalidFoNotificationCursor($after: String) {
            foNotifications(first: 1, after: $after) { nodes { notificationId } }
          }`,
          { after: rawCursor(payload) },
        ),
      ),
    );

    expect(responses.map((response) => response.body.errors?.[0]?.extensions.code)).toEqual([
      "BAD_USER_INPUT",
      "BAD_USER_INPUT",
    ]);
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

  it("rejects explicit null notification preferences", async () => {
    const deviceId = "notification-null-preference-device";
    const token = await signin(app, deviceId);

    const response = await authenticated(
      app,
      token.accessToken,
      deviceId,
      `mutation UpdateFoNotificationPreferences($input: UpdateFoNotificationPreferencesInput!) {
        updateFoNotificationPreferences(input: $input) { pushEnabled }
      }`,
      { input: { pushEnabled: null } },
    );

    expect(response.body.errors?.[0]?.extensions.code).toBe("BAD_USER_INPUT");
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
    const rejectedAgain = await registerDevice(app, token.accessToken, deviceId, invalidToken);
    const tombstone = await pool.query<{
      installationId: string;
      disabledReason: string | null;
    }>(`SELECT "installationId", "disabledReason" FROM "pushDevices" WHERE "expoPushToken" = $1`, [invalidToken]);

    expect(rejected.body).toEqual({ data: { registerFoPushDevice: false } });
    expect(stillDisabled.rows[0]).toEqual({ disabledReason: "DEVICE_NOT_REGISTERED" });
    expect(replaced.body).toEqual({ data: { registerFoPushDevice: true } });
    expect(active.rows[0]).toEqual({ expoPushToken: replacementToken, disabledAt: null, disabledReason: null });
    expect(rejectedAgain.body).toEqual({ data: { registerFoPushDevice: false } });
    expect(tombstone.rows[0]?.disabledReason).toBe("DEVICE_NOT_REGISTERED");
    expect(tombstone.rows[0]?.installationId).not.toBe(deviceId);
  });

  it("serializes device registration before logout and leaves the installation disabled", async () => {
    const deviceId = "notification-logout-race-device";
    const token = await signin(app, deviceId);
    await registerDevice(app, token.accessToken, deviceId, "ExponentPushToken[notification-logout-race-old]");
    const device = await pool.query<{ pushDeviceId: string }>(
      `SELECT "pushDeviceId" FROM "pushDevices" WHERE "installationId" = $1`,
      [deviceId],
    );

    const raced = await raceAfterQueuedRegistration(
      pool,
      device.rows[0]?.pushDeviceId as string,
      FIXTURE.userId,
      deviceId,
      () => registerDevice(app, token.accessToken, deviceId, "ExponentPushToken[notification-logout-race-new]"),
      () =>
        request(app.getHttpServer())
          .post("/graphql")
          .set("Authorization", `Bearer ${token.refreshToken}`)
          .send({ query: `mutation NotificationRaceLogout { logout }` }),
    );
    const active = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "pushDevices" WHERE "installationId" = $1 AND "disabledAt" IS NULL`,
      [deviceId],
    );

    expect(raced.refreshSessionCanBeLocked).toBe(false);
    expect(raced.queries.some((query) => query.includes('delete from "refreshToken"'))).toBe(true);
    expect(raced.registrationResponse.body).toEqual({ data: { registerFoPushDevice: true } });
    expect(raced.participantResponse.body).toEqual({ data: { logout: true } });
    expect(active.rows[0]?.count).toBe(0);
  });

  it("serializes device registration before deactivation and leaves every device disabled", async () => {
    const deviceId = "notification-deactivation-race-device";
    const token = await signin(app, deviceId);
    await registerDevice(app, token.accessToken, deviceId, "ExponentPushToken[notification-deactivation-race-old]");
    const device = await pool.query<{ pushDeviceId: string }>(
      `SELECT "pushDeviceId" FROM "pushDevices" WHERE "installationId" = $1`,
      [deviceId],
    );

    const raced = await raceAfterQueuedRegistration(
      pool,
      device.rows[0]?.pushDeviceId as string,
      FIXTURE.userId,
      deviceId,
      () => registerDevice(app, token.accessToken, deviceId, "ExponentPushToken[notification-deactivation-race-new]"),
      () =>
        authenticated(
          app,
          token.accessToken,
          deviceId,
          `mutation NotificationRaceDeactivation { deactivateFoAccount { ok } }`,
        ),
    );
    const state = await pool.query<{ activeDevices: number; sessions: number }>(
      `SELECT
        (SELECT count(*)::int FROM "pushDevices" WHERE "userId" = $1 AND "disabledAt" IS NULL) AS "activeDevices",
        (SELECT count(*)::int FROM "refreshToken" WHERE "userId" = $1) AS sessions`,
      [FIXTURE.userId],
    );

    expect(raced.refreshSessionCanBeLocked).toBe(false);
    expect(raced.queries.some((query) => query.includes('delete from "refreshToken"'))).toBe(true);
    expect(raced.registrationResponse.body).toEqual({ data: { registerFoPushDevice: true } });
    expect(raced.participantResponse.body.data.deactivateFoAccount).toEqual({ ok: true });
    expect(state.rows[0]).toEqual({ activeDevices: 0, sessions: 0 });
  });

  it("locks multi-device disables by pushDeviceId before waiting on later rows", async () => {
    const lowDeviceId = "11000000-0000-4000-8000-000000000001";
    const highDeviceId = "ee000000-0000-4000-8000-000000000001";
    const targetToken = "ExponentPushToken[notification-lock-order-target]";
    const transferredToken = "ExponentPushToken[notification-lock-order-transferred]";
    await pool.query(
      `INSERT INTO "pushDevices"
        ("pushDeviceId", "userId", "installationId", "expoPushToken", platform)
       VALUES
        ($1, $3, 'notification-device-lock-order-other', $4, 'IOS'),
        ($2, $3, $5, $6, 'IOS')`,
      [highDeviceId, lowDeviceId, FIXTURE.userId, transferredToken, "notification-device-lock-order", targetToken],
    );
    const blocker = await startPushDeviceBlocker(pool, highDeviceId);
    const disableRequest = db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_indexscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      await notificationRepository.disableUserDevices(tx, FIXTURE.userId, "LOCK_ORDER_TEST");
    });
    let released = false;
    let lowDeviceCanBeLocked: boolean | undefined;
    try {
      await waitFor(async () => (await blockedQueries(pool, blocker.pid)).length === 1);
      lowDeviceCanBeLocked = await rowCanBeLocked(
        pool,
        `SELECT "pushDeviceId" FROM "pushDevices" WHERE "pushDeviceId" = $1 FOR UPDATE NOWAIT`,
        [lowDeviceId],
      );
      await releaseBlocker(blocker.client);
      released = true;
      await disableRequest;
    } finally {
      if (!released) {
        await rollbackBlocker(blocker.client);
        await Promise.allSettled([disableRequest]);
      }
    }
    const active = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "pushDevices" WHERE "userId" = $1 AND "disabledAt" IS NULL`,
      [FIXTURE.userId],
    );

    expect(lowDeviceCanBeLocked).toBe(false);
    expect(active.rows[0]?.count).toBe(0);
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

  it("creates exact order alerts once and delivers only to active devices", async () => {
    const orderId = "91000000-0000-4000-8000-000000000001";
    const activeDeviceId = await seedPushDevice(pool, FIXTURE.userId, "order-active");
    await seedPushDevice(pool, FIXTURE.userId, "order-disabled", true);

    await db.transaction(async (tx) => {
      for (const status of ["PAID", "FULFILLING", "COMPLETED", "FAILED", "CANCELLED"] as const)
        await notificationService.createOrderStatus(tx, { userId: FIXTURE.userId, orderId, status });
      await notificationService.createOrderStatus(tx, { userId: FIXTURE.userId, orderId, status: "PAID" });
      await notificationService.createOrderStatus(tx, {
        userId: FIXTURE.userId,
        orderId,
        status: "PAYMENT_PENDING",
      });
    });

    expect(await createdNotificationRows(pool, FIXTURE.userId)).toEqual([
      {
        type: "ORDER_STATUS",
        title: "주문이 취소됐어요",
        body: "주문 상세에서 취소 내용을 확인해 주세요.",
        route: `/order/${orderId}`,
        entityId: orderId,
        dedupeKey: `order:${orderId}:CANCELLED`,
      },
      {
        type: "ORDER_STATUS",
        title: "주문이 완료됐어요",
        body: "구매한 상품을 확인해 보세요.",
        route: `/order/${orderId}`,
        entityId: orderId,
        dedupeKey: `order:${orderId}:COMPLETED`,
      },
      {
        type: "ORDER_STATUS",
        title: "주문 처리가 완료되지 않았어요",
        body: "주문 상세에서 상태를 확인해 주세요.",
        route: `/order/${orderId}`,
        entityId: orderId,
        dedupeKey: `order:${orderId}:FAILED`,
      },
      {
        type: "ORDER_STATUS",
        title: "상품을 준비하고 있어요",
        body: "준비가 끝나면 다시 알려드릴게요.",
        route: `/order/${orderId}`,
        entityId: orderId,
        dedupeKey: `order:${orderId}:FULFILLING`,
      },
      {
        type: "ORDER_STATUS",
        title: "결제가 완료됐어요",
        body: "주문 상품을 준비할게요.",
        route: `/order/${orderId}`,
        entityId: orderId,
        dedupeKey: `order:${orderId}:PAID`,
      },
    ]);
    expect(await createdDeliveryRows(pool, FIXTURE.userId)).toEqual(
      ["CANCELLED", "COMPLETED", "FAILED", "FULFILLING", "PAID"].map((status) => ({
        dedupeKey: `order:${orderId}:${status}`,
        pushDeviceId: activeDeviceId,
      })),
    );
  });

  it("creates exact wish alerts once for every distinct recipient", async () => {
    await seedSecondUser(pool);
    const firstDeviceId = await seedPushDevice(pool, FIXTURE.userId, "wish-first");
    const secondDeviceId = await seedPushDevice(pool, SECOND_USER.userId, "wish-second");
    const skuUpdatedAt = new Date("2026-08-31T09:30:45.678Z");
    const input = {
      userIds: [FIXTURE.userId, SECOND_USER.userId, FIXTURE.userId],
      productId: FIXTURE.productId,
      skuUpdatedAt,
    } as const;

    await db.transaction(async (tx) => {
      await notificationService.createWishPriceDrop(tx, { ...input, newPrice: 9000 });
      await notificationService.createWishPriceDrop(tx, { ...input, newPrice: 9000 });
      await notificationService.createWishRestock(tx, input);
      await notificationService.createWishRestock(tx, input);
    });

    const expectedRows = [
      {
        type: "WISH_PRICE_DROP",
        title: "위시 상품 가격이 내려갔어요",
        body: "찜한 상품을 지금 확인해 보세요.",
        route: `/product/${FIXTURE.productId}`,
        entityId: FIXTURE.productId,
        dedupeKey: `wish-price:${FIXTURE.productId}:${skuUpdatedAt.toISOString()}:9000`,
      },
      {
        type: "WISH_RESTOCK",
        title: "위시 상품이 다시 입고됐어요",
        body: "품절되기 전에 확인해 보세요.",
        route: `/product/${FIXTURE.productId}`,
        entityId: FIXTURE.productId,
        dedupeKey: `wish-stock:${FIXTURE.productId}:${skuUpdatedAt.toISOString()}`,
      },
    ];
    expect(await createdNotificationRows(pool, FIXTURE.userId)).toEqual(expectedRows);
    expect(await createdNotificationRows(pool, SECOND_USER.userId)).toEqual(expectedRows);
    expect(await createdDeliveryRows(pool, FIXTURE.userId)).toEqual(
      expectedRows.map(({ dedupeKey }) => ({ dedupeKey, pushDeviceId: firstDeviceId })),
    );
    expect(await createdDeliveryRows(pool, SECOND_USER.userId)).toEqual(
      expectedRows.map(({ dedupeKey }) => ({ dedupeKey, pushDeviceId: secondDeviceId })),
    );
  });

  it("commits opposite wish recipient orders without a deadlock", async () => {
    await seedSecondUser(pool);
    const firstDeviceId = await seedPushDevice(pool, FIXTURE.userId, "wish-order-first");
    const secondDeviceId = await seedPushDevice(pool, SECOND_USER.userId, "wish-order-second");
    const blocker = await startPushDeviceBlocker(pool, [firstDeviceId, secondDeviceId]);
    const skuUpdatedAt = new Date("2026-08-31T09:45:00.000Z");
    const create = (userIds: readonly string[]) =>
      db.transaction((tx) =>
        notificationService.createWishPriceDrop(tx, {
          userIds,
          productId: FIXTURE.productId,
          skuUpdatedAt,
          newPrice: 8500,
        }),
      );
    const outcomesPromise = Promise.allSettled([
      create([FIXTURE.userId, SECOND_USER.userId]),
      create([SECOND_USER.userId, FIXTURE.userId]),
    ]);
    let released = false;
    try {
      await waitFor(async () => (await blockedQueries(pool, blocker.pid)).length >= 2);
      await releaseBlocker(blocker.client);
      released = true;
      const outcomes = await outcomesPromise;
      expect(
        outcomes.map((outcome) =>
          outcome.status === "rejected" &&
          typeof outcome.reason === "object" &&
          outcome.reason !== null &&
          "code" in outcome.reason
            ? outcome.reason.code
            : null,
        ),
      ).toEqual([null, null]);
      expect(outcomes.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      if (!released) await rollbackBlocker(blocker.client);
      await outcomesPromise;
    }

    const dedupeKey = `wish-price:${FIXTURE.productId}:${skuUpdatedAt.toISOString()}:8500`;
    expect(await createdNotificationRows(pool, FIXTURE.userId)).toEqual([expect.objectContaining({ dedupeKey })]);
    expect(await createdNotificationRows(pool, SECOND_USER.userId)).toEqual([expect.objectContaining({ dedupeKey })]);
    expect(await createdDeliveryRows(pool, FIXTURE.userId)).toEqual([{ dedupeKey, pushDeviceId: firstDeviceId }]);
    expect(await createdDeliveryRows(pool, SECOND_USER.userId)).toEqual([{ dedupeKey, pushDeviceId: secondDeviceId }]);
  });

  it("commits wish fanout with a cross-user device transfer without a deadlock", async () => {
    await seedSecondUser(pool);
    const highDeviceId = "ee000000-0000-4000-8000-000000000002";
    const lowDeviceId = "11000000-0000-4000-8000-000000000002";
    const installationId = "notification-wish-transfer-target";
    const targetToken = "ExponentPushToken[notification-wish-transfer-target]";
    const transferredToken = "ExponentPushToken[notification-wish-transfer-source]";
    await pool.query(
      `INSERT INTO "pushDevices"
        ("pushDeviceId", "userId", "installationId", "expoPushToken", platform)
       VALUES
        ($1, $3, $4, $5, 'IOS'),
        ($2, $6, 'notification-wish-transfer-source', $7, 'IOS')`,
      [highDeviceId, lowDeviceId, FIXTURE.userId, installationId, targetToken, SECOND_USER.userId, transferredToken],
    );
    const highBlocker = await startPushDeviceBlocker(pool, highDeviceId);
    const lowBlocker = await startPushDeviceBlocker(pool, lowDeviceId);
    const skuUpdatedAt = new Date("2026-08-31T09:47:00.000Z");
    const creation = db.transaction((tx) =>
      notificationService.createWishRestock(tx, {
        userIds: [FIXTURE.userId, SECOND_USER.userId],
        productId: FIXTURE.productId,
        skuUpdatedAt,
      }),
    );
    await waitFor(async () => (await blockedQueries(pool, highBlocker.pid)).length === 1);
    const transfer = db.transaction((tx) =>
      notificationRepository.transferDevice(tx, {
        userId: FIXTURE.userId,
        installationId,
        expoPushToken: transferredToken,
        platform: FoPushPlatform.IOS,
      }),
    );
    const outcomesPromise = Promise.allSettled([creation, transfer]);
    let highReleased = false;
    let lowReleased = false;
    try {
      await waitFor(async () => {
        const [blockedByHigh, blockedByLow] = await Promise.all([
          blockedQueries(pool, highBlocker.pid),
          blockedQueries(pool, lowBlocker.pid),
        ]);
        return blockedByHigh.length + blockedByLow.length >= 2;
      });
      await releaseBlocker(highBlocker.client);
      highReleased = true;
      await waitFor(async () => (await blockedQueries(pool, lowBlocker.pid)).length >= 2);
      await releaseBlocker(lowBlocker.client);
      lowReleased = true;
      const outcomes = await outcomesPromise;
      expect(
        outcomes.map((outcome) => (outcome.status === "rejected" ? postgresErrorCode(outcome.reason) : null)),
      ).toEqual([null, null]);
      expect(outcomes.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      if (!highReleased) await rollbackBlocker(highBlocker.client);
      if (!lowReleased) await rollbackBlocker(lowBlocker.client);
      await outcomesPromise;
    }

    const dedupeKey = `wish-stock:${FIXTURE.productId}:${skuUpdatedAt.toISOString()}`;
    const expectedNotification = {
      type: "WISH_RESTOCK",
      title: "위시 상품이 다시 입고됐어요",
      body: "품절되기 전에 확인해 보세요.",
      route: `/product/${FIXTURE.productId}`,
      entityId: FIXTURE.productId,
      dedupeKey,
    };
    expect(await createdNotificationRows(pool, FIXTURE.userId)).toEqual([expectedNotification]);
    expect(await createdNotificationRows(pool, SECOND_USER.userId)).toEqual([expectedNotification]);
    expect(await createdDeliveryRows(pool, FIXTURE.userId)).toEqual([{ dedupeKey, pushDeviceId: highDeviceId }]);
    expect(await createdDeliveryRows(pool, SECOND_USER.userId)).toEqual([{ dedupeKey, pushDeviceId: lowDeviceId }]);
    const deliveries = await pool.query<{
      userId: string;
      pushDeviceId: string;
      status: string;
      lastError: string | null;
    }>(
      `SELECT notification."userId", outbox."pushDeviceId", outbox.status, outbox."lastError"
       FROM "pushOutbox" outbox
       INNER JOIN notifications notification ON notification."notificationId" = outbox."notificationId"
       ORDER BY notification."userId"`,
    );
    expect(deliveries.rows).toEqual([
      { userId: FIXTURE.userId, pushDeviceId: highDeviceId, status: "FAILED", lastError: "DEVICE_TRANSFERRED" },
      { userId: SECOND_USER.userId, pushDeviceId: lowDeviceId, status: "FAILED", lastError: "DEVICE_TRANSFERRED" },
    ]);
    const devices = await pool.query<{
      pushDeviceId: string;
      userId: string;
      installationId: string;
      expoPushToken: string;
      disabledAt: Date | null;
      disabledReason: string | null;
    }>(
      `SELECT "pushDeviceId", "userId", "installationId", "expoPushToken", "disabledAt", "disabledReason"
       FROM "pushDevices"
       WHERE "pushDeviceId" = ANY($1::uuid[])
       ORDER BY "pushDeviceId"`,
      [[lowDeviceId, highDeviceId]],
    );
    expect(devices.rows).toEqual([
      {
        pushDeviceId: lowDeviceId,
        userId: SECOND_USER.userId,
        installationId: `retired-installation:${lowDeviceId}`,
        expoPushToken: `retired-token:${lowDeviceId}`,
        disabledAt: expect.any(Date),
        disabledReason: "DEVICE_TRANSFERRED",
      },
      {
        pushDeviceId: highDeviceId,
        userId: FIXTURE.userId,
        installationId,
        expoPushToken: transferredToken,
        disabledAt: null,
        disabledReason: null,
      },
    ]);
  });

  it("serializes preference disable after in-flight creation and suppresses later delivery", async () => {
    const pushDeviceId = await seedPushDevice(pool, FIXTURE.userId, "preference-order");
    const blocker = await startPushDeviceBlocker(pool, pushDeviceId);
    const firstUpdatedAt = new Date("2026-08-31T09:50:00.000Z");
    const secondUpdatedAt = new Date("2026-08-31T09:51:00.000Z");
    const creation = db.transaction((tx) =>
      notificationService.createWishPriceDrop(tx, {
        userIds: [FIXTURE.userId],
        productId: FIXTURE.productId,
        skuUpdatedAt: firstUpdatedAt,
        newPrice: 8200,
      }),
    );
    const creationOutcome = creation.then(
      () => ({ status: "fulfilled" as const }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let update: ReturnType<NotificationService["updatePreferences"]> | undefined;
    let updateSettled = false;
    let released = false;
    try {
      await waitFor(async () => (await blockedQueries(pool, blocker.pid)).length === 1);
      update = notificationService.updatePreferences(FIXTURE.userId, { pushEnabled: false }).then(
        (preferences) => {
          updateSettled = true;
          return preferences;
        },
        (error: unknown) => {
          updateSettled = true;
          throw error;
        },
      );
      await waitFor(async () => updateSettled || (await blockedQueries(pool, blocker.pid)).length >= 2);
      expect(updateSettled).toBe(false);
      expect((await blockedQueries(pool, blocker.pid)).length).toBeGreaterThanOrEqual(2);
      await releaseBlocker(blocker.client);
      released = true;
      const preferences = await update;
      expect(preferences.pushEnabled).toBe(false);
      expect(await creationOutcome).toEqual({ status: "fulfilled" });
    } finally {
      if (!released) await rollbackBlocker(blocker.client);
      await Promise.allSettled([creationOutcome, ...(update ? [update] : [])]);
    }

    await db.transaction((tx) =>
      notificationService.createWishRestock(tx, {
        userIds: [FIXTURE.userId],
        productId: FIXTURE.productId,
        skuUpdatedAt: secondUpdatedAt,
      }),
    );
    expect(await createdNotificationRows(pool, FIXTURE.userId)).toHaveLength(2);
    expect(await createdDeliveryRows(pool, FIXTURE.userId)).toEqual([
      {
        dedupeKey: `wish-price:${FIXTURE.productId}:${firstUpdatedAt.toISOString()}:8200`,
        pushDeviceId,
      },
    ]);
  });

  it("keeps app alerts while overall and category preferences suppress Push", async () => {
    await seedSecondUser(pool);
    const pushDeviceId = await seedPushDevice(pool, FIXTURE.userId, "preferences");
    const orderId = "91000000-0000-4000-8000-000000000001";
    const firstUpdatedAt = new Date("2026-08-31T10:00:00.000Z");
    const secondUpdatedAt = new Date("2026-08-31T10:01:00.000Z");
    const stylePostIds = [
      "82000000-0000-4000-8000-000000000001",
      "82000000-0000-4000-8000-000000000002",
      "82000000-0000-4000-8000-000000000003",
      "82000000-0000-4000-8000-000000000004",
    ];
    await pool.query(
      `INSERT INTO "notificationPreferences"
        ("userId", "pushEnabled", "orderPushEnabled", "wishPushEnabled", "stylePushEnabled")
       VALUES ($1, true, false, true, true)`,
      [FIXTURE.userId],
    );

    await db.transaction(async (tx) => {
      await notificationService.createOrderStatus(tx, { userId: FIXTURE.userId, orderId, status: "PAID" });
      await notificationService.createWishPriceDrop(tx, {
        userIds: [FIXTURE.userId],
        productId: FIXTURE.productId,
        skuUpdatedAt: firstUpdatedAt,
        newPrice: 9000,
      });
      await notificationService.createStyleLike(tx, {
        authorUserId: FIXTURE.userId,
        actorUserId: SECOND_USER.userId,
        stylePostId: stylePostIds[0] as string,
      });
    });
    await pool.query(
      `UPDATE "notificationPreferences"
       SET "orderPushEnabled" = true, "wishPushEnabled" = false
       WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    await db.transaction(async (tx) => {
      await notificationService.createOrderStatus(tx, { userId: FIXTURE.userId, orderId, status: "FULFILLING" });
      await notificationService.createWishRestock(tx, {
        userIds: [FIXTURE.userId],
        productId: FIXTURE.productId,
        skuUpdatedAt: firstUpdatedAt,
      });
      await notificationService.createStyleLike(tx, {
        authorUserId: FIXTURE.userId,
        actorUserId: SECOND_USER.userId,
        stylePostId: stylePostIds[1] as string,
      });
    });
    await pool.query(
      `UPDATE "notificationPreferences"
       SET "wishPushEnabled" = true, "stylePushEnabled" = false
       WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    await db.transaction(async (tx) => {
      await notificationService.createWishPriceDrop(tx, {
        userIds: [FIXTURE.userId],
        productId: FIXTURE.productId,
        skuUpdatedAt: secondUpdatedAt,
        newPrice: 8000,
      });
      await notificationService.createStyleLike(tx, {
        authorUserId: FIXTURE.userId,
        actorUserId: SECOND_USER.userId,
        stylePostId: stylePostIds[2] as string,
      });
    });
    await pool.query(`UPDATE "notificationPreferences" SET "pushEnabled" = false WHERE "userId" = $1`, [
      FIXTURE.userId,
    ]);
    await db.transaction(async (tx) => {
      await notificationService.createOrderStatus(tx, { userId: FIXTURE.userId, orderId, status: "COMPLETED" });
      await notificationService.createWishRestock(tx, {
        userIds: [FIXTURE.userId],
        productId: FIXTURE.productId,
        skuUpdatedAt: secondUpdatedAt,
      });
      await notificationService.createStyleLike(tx, {
        authorUserId: FIXTURE.userId,
        actorUserId: SECOND_USER.userId,
        stylePostId: stylePostIds[3] as string,
      });
    });

    expect(await createdNotificationRows(pool, FIXTURE.userId)).toHaveLength(11);
    expect(await createdDeliveryRows(pool, FIXTURE.userId)).toEqual([
      { dedupeKey: `order:${orderId}:FULFILLING`, pushDeviceId },
      {
        dedupeKey: `style-like:${stylePostIds[0]}:${SECOND_USER.userId}`,
        pushDeviceId,
      },
      {
        dedupeKey: `style-like:${stylePostIds[1]}:${SECOND_USER.userId}`,
        pushDeviceId,
      },
      {
        dedupeKey: `wish-price:${FIXTURE.productId}:${firstUpdatedAt.toISOString()}:9000`,
        pushDeviceId,
      },
      {
        dedupeKey: `wish-price:${FIXTURE.productId}:${secondUpdatedAt.toISOString()}:8000`,
        pushDeviceId,
      },
    ]);
  });

  it("creates one exact style alert for a non-self actor", async () => {
    await seedSecondUser(pool);
    const pushDeviceId = await seedPushDevice(pool, FIXTURE.userId, "style");
    const stylePostId = "82000000-0000-4000-8000-000000000010";

    await db.transaction(async (tx) => {
      await notificationService.createStyleLike(tx, {
        authorUserId: FIXTURE.userId,
        actorUserId: FIXTURE.userId,
        stylePostId,
      });
      await notificationService.createStyleLike(tx, {
        authorUserId: FIXTURE.userId,
        actorUserId: SECOND_USER.userId,
        stylePostId,
      });
      await notificationService.createStyleLike(tx, {
        authorUserId: FIXTURE.userId,
        actorUserId: SECOND_USER.userId,
        stylePostId,
      });
    });

    expect(await createdNotificationRows(pool, FIXTURE.userId)).toEqual([
      {
        type: "STYLE_LIKE",
        title: "스타일에 좋아요가 달렸어요",
        body: "내 스타일 게시물을 확인해 보세요.",
        route: `/style/${stylePostId}`,
        entityId: stylePostId,
        dedupeKey: `style-like:${stylePostId}:${SECOND_USER.userId}`,
      },
    ]);
    expect(await createdDeliveryRows(pool, FIXTURE.userId)).toEqual([
      { dedupeKey: `style-like:${stylePostId}:${SECOND_USER.userId}`, pushDeviceId },
    ]);
  });

  it("lets two Push workers claim every delivery exactly once", async () => {
    const pushDeviceId = await seedPushDevice(pool, FIXTURE.userId, "worker-concurrency");
    await pool.query(
      `WITH inserted AS (
         INSERT INTO notifications
           ("userId", type, title, body, route, "entityId", "dedupeKey")
         SELECT $1, 'ORDER_STATUS', 'Title', 'Body', '/order/90000000-0000-4000-8000-000000000001',
           '90000000-0000-4000-8000-000000000001', 'push-worker-' || value
         FROM generate_series(1, 100) AS value
         RETURNING "notificationId"
       )
       INSERT INTO "pushOutbox" ("notificationId", "pushDeviceId")
       SELECT "notificationId", $2 FROM inserted`,
      [FIXTURE.userId, pushDeviceId],
    );
    const provider = recordingPushSender();
    const now = new Date("2026-08-31T12:00:00.000Z");

    await Promise.all([
      pushWorker(notificationRepository, provider.sender).runOnce(now),
      pushWorker(notificationRepository, provider.sender).runOnce(now),
    ]);

    const sent = provider.sent.flat();
    const rows = await pool.query<{ status: string; expoTicketId: string | null }>(
      `SELECT status, "expoTicketId" FROM "pushOutbox" ORDER BY "pushOutboxId"`,
    );
    expect(sent).toHaveLength(100);
    expect(new Set(sent.map(({ data }) => data.notificationId)).size).toBe(100);
    expect(rows.rows).toHaveLength(100);
    expect(rows.rows.every(({ status, expoTicketId }) => status === "TICKETED" && expoTicketId !== null)).toBe(true);
  });

  it("persists a cross-user worker batch with device transfer in canonical lock order", async () => {
    await seedSecondUser(pool);
    const highDeviceId = "ee000000-0000-4000-8000-000000000003";
    const lowDeviceId = "11000000-0000-4000-8000-000000000003";
    const installationId = "notification-worker-transfer-target";
    const targetToken = "ExponentPushToken[notification-worker-transfer-target]";
    const transferredToken = "ExponentPushToken[notification-worker-transfer-source]";
    await pool.query(
      `INSERT INTO "pushDevices"
        ("pushDeviceId", "userId", "installationId", "expoPushToken", platform)
       VALUES
        ($1, $3, $4, $5, 'IOS'),
        ($2, $6, 'notification-worker-transfer-source', $7, 'IOS')`,
      [highDeviceId, lowDeviceId, FIXTURE.userId, installationId, targetToken, SECOND_USER.userId, transferredToken],
    );
    await seedPushDelivery(pool, highDeviceId, "push-worker-transfer-target");
    await seedPushDelivery(pool, lowDeviceId, "push-worker-transfer-source", { userId: SECOND_USER.userId });
    const highBlocker = await startPushDeviceBlocker(pool, highDeviceId);
    const lowBlocker = await startPushDeviceBlocker(pool, lowDeviceId);
    const provider = recordingPushSender();
    const workerRun = pushWorker(notificationRepository, provider.sender).runOnce(new Date("2026-08-31T12:00:00.000Z"));
    let transfer: Promise<unknown> | undefined;
    let highReleased = false;
    let lowReleased = false;
    try {
      await waitFor(async () => {
        const [blockedByHigh, blockedByLow] = await Promise.all([
          blockedQueries(pool, highBlocker.pid),
          blockedQueries(pool, lowBlocker.pid),
        ]);
        return blockedByHigh.length === 1 && blockedByLow.length === 0;
      });
      transfer = db.transaction((tx) =>
        notificationRepository.transferDevice(tx, {
          userId: FIXTURE.userId,
          installationId,
          expoPushToken: transferredToken,
          platform: FoPushPlatform.IOS,
        }),
      );
      const outcomesPromise = Promise.allSettled([workerRun, transfer]);
      await waitFor(async () => (await blockedQueries(pool, highBlocker.pid)).length >= 2);
      await releaseBlocker(highBlocker.client);
      highReleased = true;
      await waitFor(async () => (await blockedQueries(pool, lowBlocker.pid)).length >= 1);
      await releaseBlocker(lowBlocker.client);
      lowReleased = true;
      const outcomes = await outcomesPromise;
      expect(
        outcomes.map((outcome) => (outcome.status === "rejected" ? postgresErrorCode(outcome.reason) : null)),
      ).toEqual([null, null]);
      expect(outcomes.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      if (!highReleased) await rollbackBlocker(highBlocker.client);
      if (!lowReleased) await rollbackBlocker(lowBlocker.client);
      await Promise.allSettled([workerRun, ...(transfer ? [transfer] : [])]);
    }
  }, 15_000);

  it("recovers a thirty-second stale claim and resets the receipt retry budget without letting its old token complete", async () => {
    const pushDeviceId = await seedPushDevice(pool, FIXTURE.userId, "worker-stale");
    const now = new Date("2026-08-31T12:00:00.000Z");
    const oldClaimToken = randomUUID();
    const delivery = await seedPushDelivery(pool, pushDeviceId, "push-worker-stale", {
      status: "PROCESSING",
      claimToken: oldClaimToken,
      claimedAt: new Date(now.getTime() - 30_001),
      attemptCount: 1,
    });
    const provider = recordingPushSender();

    await pushWorker(notificationRepository, provider.sender).runOnce(now);
    await expect(
      notificationRepository.persistPushTickets(
        [
          {
            ...delivery,
            pushDeviceId,
            claimToken: oldClaimToken,
            attemptCount: 1,
            expoPushToken: "ExponentPushToken[notification-worker-stale]",
            type: "ORDER_STATUS",
            title: "Title",
            body: "Body",
            entityId: "90000000-0000-4000-8000-000000000001",
          },
        ],
        [{ status: "ok", id: "old-ticket" }],
        now,
      ),
    ).rejects.toThrow("Push delivery claim was lost");
    const state = await pool.query<{ status: string; expoTicketId: string | null; attemptCount: number }>(
      `SELECT status, "expoTicketId", "attemptCount" FROM "pushOutbox" WHERE "pushOutboxId" = $1`,
      [delivery.pushOutboxId],
    );
    expect(state.rows[0]).toEqual({
      status: "TICKETED",
      expoTicketId: `ticket-${delivery.notificationId}`,
      attemptCount: 0,
    });
  });

  it("terminally fails a disabled device before calling Expo", async () => {
    const pushDeviceId = await seedPushDevice(pool, FIXTURE.userId, "worker-disabled", true);
    const delivery = await seedPushDelivery(pool, pushDeviceId, "push-worker-disabled");
    const provider = recordingPushSender();

    await pushWorker(notificationRepository, provider.sender).runOnce(new Date("2026-08-31T12:00:00.000Z"));

    const state = await pool.query<{ status: string; lastError: string | null }>(
      `SELECT status, "lastError" FROM "pushOutbox" WHERE "pushOutboxId" = $1`,
      [delivery.pushOutboxId],
    );
    expect(provider.sent).toEqual([]);
    expect(state.rows[0]).toEqual({ status: "FAILED", lastError: "DEVICE_DISABLED" });
  });

  it("persists tickets for fifteen minutes then reconciles success and DeviceNotRegistered receipts", async () => {
    const validDeviceId = await seedPushDevice(pool, FIXTURE.userId, "worker-receipt-valid");
    const invalidDeviceId = await seedPushDevice(pool, FIXTURE.userId, "worker-receipt-invalid");
    const valid = await seedPushDelivery(pool, validDeviceId, "push-worker-receipt-valid");
    const invalid = await seedPushDelivery(pool, invalidDeviceId, "push-worker-receipt-invalid");
    const now = new Date("2026-08-31T12:00:00.000Z");
    const provider = recordingPushSender({
      receipts: async (ticketIds) =>
        Object.fromEntries(
          ticketIds.map((ticketId) => [
            ticketId,
            ticketId === `ticket-${invalid.notificationId}`
              ? { status: "error" as const, message: "unregistered", details: { error: "DeviceNotRegistered" } }
              : { status: "ok" as const },
          ]),
        ),
    });

    await pushWorker(notificationRepository, provider.sender).runOnce(now);
    const ticketed = await pool.query<{
      pushOutboxId: string;
      status: string;
      receiptAvailableAt: Date | null;
      attemptCount: number;
    }>(
      `SELECT "pushOutboxId", status, "receiptAvailableAt", "attemptCount"
       FROM "pushOutbox" ORDER BY "pushOutboxId"`,
    );
    expect(ticketed.rows).toHaveLength(2);
    expect(ticketed.rows.every(({ status }) => status === "TICKETED")).toBe(true);
    expect(ticketed.rows.map(({ attemptCount }) => attemptCount)).toEqual([0, 0]);
    expect(ticketed.rows.map(({ receiptAvailableAt }) => receiptAvailableAt)).toEqual([
      new Date(now.getTime() + 15 * 60_000),
      new Date(now.getTime() + 15 * 60_000),
    ]);
    const invalidPending = await seedPushDelivery(pool, invalidDeviceId, "push-worker-receipt-invalid-pending");

    await pushWorker(notificationRepository, provider.sender).runOnce(new Date(now.getTime() + 15 * 60_000));

    const states = await pool.query<{ pushOutboxId: string; status: string }>(
      `SELECT "pushOutboxId", status FROM "pushOutbox" WHERE "pushOutboxId" = ANY($1::uuid[])`,
      [[valid.pushOutboxId, invalid.pushOutboxId, invalidPending.pushOutboxId]],
    );
    const byId = Object.fromEntries(states.rows.map(({ pushOutboxId, status }) => [pushOutboxId, status]));
    const invalidDevice = await pool.query<{ disabledReason: string | null }>(
      `SELECT "disabledReason" FROM "pushDevices" WHERE "pushDeviceId" = $1`,
      [invalidDeviceId],
    );
    expect(byId).toEqual({
      [valid.pushOutboxId]: "RECEIPT_OK",
      [invalid.pushOutboxId]: "FAILED",
      [invalidPending.pushOutboxId]: "FAILED",
    });
    expect(invalidDevice.rows[0]).toEqual({ disabledReason: "DEVICE_NOT_REGISTERED" });
  });

  it("disables DeviceNotRegistered tickets and fails every unsettled device row", async () => {
    const pushDeviceId = await seedPushDevice(pool, FIXTURE.userId, "worker-ticket-invalid");
    const first = await seedPushDelivery(pool, pushDeviceId, "push-worker-ticket-invalid-first");
    const second = await seedPushDelivery(pool, pushDeviceId, "push-worker-ticket-invalid-second");
    const provider = recordingPushSender({
      send: async (messages) =>
        messages.map(() => ({
          status: "error" as const,
          message: "unregistered",
          details: { error: "DeviceNotRegistered" },
        })),
    });

    await pushWorker(notificationRepository, provider.sender).runOnce(new Date("2026-08-31T12:00:00.000Z"));

    const states = await pool.query<{ status: string }>(
      `SELECT status FROM "pushOutbox" WHERE "pushOutboxId" = ANY($1::uuid[]) ORDER BY "pushOutboxId"`,
      [[first.pushOutboxId, second.pushOutboxId]],
    );
    const device = await pool.query<{ disabledReason: string | null }>(
      `SELECT "disabledReason" FROM "pushDevices" WHERE "pushDeviceId" = $1`,
      [pushDeviceId],
    );
    expect(states.rows).toEqual([{ status: "FAILED" }, { status: "FAILED" }]);
    expect(device.rows[0]).toEqual({ disabledReason: "DEVICE_NOT_REGISTERED" });
  });

  it("uses exponential retries and terminally fails the eighth Push attempt", async () => {
    const pushDeviceId = await seedPushDevice(pool, FIXTURE.userId, "worker-retry");
    const delivery = await seedPushDelivery(pool, pushDeviceId, "push-worker-retry");
    const provider = recordingPushSender({
      send: async () => {
        throw new RetryablePushError(503);
      },
    });
    const worker = pushWorker(notificationRepository, provider.sender);
    let attemptAt = new Date("2026-08-31T12:00:00.000Z");

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await worker.runOnce(attemptAt);
      const state = await pool.query<{ status: string; attemptCount: number; availableAt: Date }>(
        `SELECT status, "attemptCount", "availableAt" FROM "pushOutbox" WHERE "pushOutboxId" = $1`,
        [delivery.pushOutboxId],
      );
      expect(state.rows[0]?.attemptCount).toBe(attempt);
      expect(state.rows[0]?.status).toBe(attempt === 8 ? "FAILED" : "PENDING");
      attemptAt = state.rows[0]?.availableAt ?? attemptAt;
    }
  });

  it("preserves a fresh eighth Push claim while terminally failing exhausted and stale claims", async () => {
    const pushDeviceId = await seedPushDevice(pool, FIXTURE.userId, "worker-eighth-claim");
    const now = new Date("2026-08-31T12:00:00.000Z");
    const claimToken = randomUUID();
    const fresh = await seedPushDelivery(pool, pushDeviceId, "push-worker-eighth-fresh", {
      status: "PROCESSING",
      claimToken,
      claimedAt: now,
      attemptCount: 8,
    });
    const pending = await seedPushDelivery(pool, pushDeviceId, "push-worker-eighth-pending", {
      attemptCount: 8,
    });
    const ticketed = await seedPushDelivery(pool, pushDeviceId, "push-worker-eighth-ticketed", {
      status: "TICKETED",
      expoTicketId: "exhausted-ticket",
      receiptAvailableAt: now,
      attemptCount: 8,
    });
    const stale = await seedPushDelivery(pool, pushDeviceId, "push-worker-eighth-stale", {
      status: "PROCESSING",
      claimToken: randomUUID(),
      claimedAt: new Date(now.getTime() - 30_001),
      attemptCount: 8,
    });

    await notificationRepository.claimPushSendBatch(now, 100);

    const beforeCompletion = await pool.query<{ pushOutboxId: string; status: string }>(
      `SELECT "pushOutboxId", status FROM "pushOutbox" WHERE "pushOutboxId" = ANY($1::uuid[])`,
      [[fresh.pushOutboxId, pending.pushOutboxId, ticketed.pushOutboxId, stale.pushOutboxId]],
    );
    expect(new Map(beforeCompletion.rows.map(({ pushOutboxId, status }) => [pushOutboxId, status]))).toEqual(
      new Map([
        [fresh.pushOutboxId, "PROCESSING"],
        [pending.pushOutboxId, "FAILED"],
        [ticketed.pushOutboxId, "FAILED"],
        [stale.pushOutboxId, "FAILED"],
      ]),
    );
    await notificationRepository.persistPushTickets(
      [
        {
          ...fresh,
          pushDeviceId,
          claimToken,
          attemptCount: 8,
          expoPushToken: "ExponentPushToken[notification-worker-eighth]",
          type: "ORDER_STATUS",
          title: "Title",
          body: "Body",
          entityId: "90000000-0000-4000-8000-000000000001",
        },
      ],
      [{ status: "ok", id: "eighth-ticket" }],
      now,
    );
    const completed = await pool.query<{ status: string; attemptCount: number }>(
      `SELECT status, "attemptCount" FROM "pushOutbox" WHERE "pushOutboxId" = $1`,
      [fresh.pushOutboxId],
    );
    expect(completed.rows[0]).toEqual({ status: "TICKETED", attemptCount: 0 });
  });

  it("purges only Push terminal rows retained for seven days", async () => {
    const pushDeviceId = await seedPushDevice(pool, FIXTURE.userId, "worker-retention");
    const now = new Date("2026-08-31T12:00:00.000Z");
    const expired = await seedPushDelivery(pool, pushDeviceId, "push-worker-retention-expired", {
      status: "FAILED",
      updatedAt: new Date(now.getTime() - 8 * 24 * 60 * 60_000),
    });
    const retained = await seedPushDelivery(pool, pushDeviceId, "push-worker-retention-retained", {
      status: "FAILED",
      updatedAt: new Date(now.getTime() - 6 * 24 * 60 * 60_000),
    });
    const provider = recordingPushSender();

    await pushWorker(notificationRepository, provider.sender).runOnce(now);

    const rows = await pool.query<{ pushOutboxId: string }>(
      `SELECT "pushOutboxId" FROM "pushOutbox" WHERE "pushOutboxId" = ANY($1::uuid[])`,
      [[expired.pushOutboxId, retained.pushOutboxId]],
    );
    expect(rows.rows).toEqual([{ pushOutboxId: retained.pushOutboxId }]);
  });

  it("rejects unauthenticated inbox access", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `query FoNotifications { foNotifications { unreadCount } }` });

    expect(response.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
  });
});
