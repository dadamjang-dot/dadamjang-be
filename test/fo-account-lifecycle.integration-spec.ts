import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Pool, PoolClient } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { hasDatabaseErrorCode } from "src/common/errors/database-error";
import { hashToken } from "src/common/security/token-hash";
import { FIXTURE } from "src/database/fixtures";
import { EmailRepository } from "src/modules/email/email.repository";
import { FoAccountRepository } from "src/modules/fo-account/fo-account.repository";
import { KakaoFlowRepository } from "src/modules/fo-auth/kakao-flow.repository";
import { resetTestFixtures, testPool } from "./support/database";

const signin = (app: INestApplication, deviceId: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("x-device-id", deviceId)
    .send({
      query: `mutation Signin($input: SigninAuthInput!) {
        signin(input: $input) { accessToken refreshToken }
      }`,
      variables: {
        input: { userid: FIXTURE.userid, password: FIXTURE.password, portal: "FO" },
      },
    });

const signinFo = (app: INestApplication, deviceId: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("x-device-id", deviceId)
    .send({
      query: `mutation SigninFo($input: SigninFoInput!) {
        signinFo(input: $input) { status tokenPayload { accessToken refreshToken } reactivationToken }
      }`,
      variables: { input: { email: "integration@example.test", password: FIXTURE.password } },
    });

const deactivate = (app: INestApplication, accessToken: string, deviceId: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .set("x-device-id", deviceId)
    .send({
      query: `mutation DeactivateFoAccount {
        deactivateFoAccount { ok scheduledAnonymizationAt }
      }`,
    });

const reactivate = (app: INestApplication, token: string, deviceId: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("x-device-id", deviceId)
    .send({
      query: `mutation ReactivateFoAccount($token: String!) {
        reactivateFoAccount(reactivationToken: $token) { accessToken refreshToken role }
      }`,
      variables: { token },
    });

const refresh = (app: INestApplication, refreshToken: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${refreshToken}`)
    .send({ query: `mutation Refresh { refresh { accessToken refreshToken } }` });

const completeKakaoLogin = (app: INestApplication, flowId: string, callbackToken: string, deviceId: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("x-device-id", deviceId)
    .send({
      query: `mutation Complete($input: CompleteKakaoLoginInput!) {
        completeKakaoLogin(input: $input) {
          status tokenPayload { accessToken refreshToken } reactivationToken
          kakaoSignupToken email emailVerificationRequired
        }
      }`,
      variables: { input: { flowId, callbackToken } },
    });

const me = (app: INestApplication, accessToken: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ query: `query Me { me { userId } }` });

const addCartItem = (app: INestApplication, accessToken: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({
      query: `mutation Add($input: UpsertCartItemInput!) { upsertCartItem(input: $input) { cartId } }`,
      variables: { input: { skuId: FIXTURE.skuId, quantity: 1 } },
    });

const checkout = (app: INestApplication, accessToken: string, idempotencyKey: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({
      query: `mutation Checkout($input: CheckoutCartInput!) {
        checkoutCart(input: $input) { orderId }
      }`,
      variables: { input: { idempotencyKey } },
    });

const cookies = (response: request.Response) => response.headers["set-cookie"] as unknown as string[] | undefined;

const cookieValue = (response: request.Response, name: string) => {
  const cookie = cookies(response)?.find((value) => value.startsWith(`${name}=`));
  return cookie?.split(";", 1)[0]?.slice(name.length + 1);
};

const waitFor = async (condition: () => Promise<boolean>) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for lifecycle lock barrier");
};

const startUserBlocker = async (pool: Pool) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '30s'");
    await client.query(`SELECT "userId" FROM "users" WHERE "userId" = $1 FOR UPDATE`, [FIXTURE.userId]);
    const pid = (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]?.pid;
    if (!pid) throw new Error("Failed to identify lifecycle blocker");
    return { client, pid };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw error;
  }
};

const startAdvisoryBlocker = async (pool: Pool, value: string, seed: number) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '30s'");
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, $2))`, [value, seed]);
    const pid = (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]?.pid;
    if (!pid) throw new Error("Failed to identify advisory blocker");
    return { client, pid };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    throw error;
  }
};

const blockedBy = async (pool: Pool, blockerPid: number) => {
  const result = await pool.query<{ count: number }>(
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
     SELECT count(*)::int AS count FROM blocked`,
    [blockerPid],
  );
  return result.rows[0]?.count ?? 0;
};

const blockedPids = async (pool: Pool, blockerPid: number) => {
  const result = await pool.query<{ pid: number }>(
    `SELECT pid
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND $1 = ANY(pg_blocking_pids(pid))
     ORDER BY pid`,
    [blockerPid],
  );
  return result.rows.map(({ pid }) => pid);
};

const releaseBlocker = async (client: PoolClient) => {
  await client.query("COMMIT");
  client.release();
};

const rollbackBlocker = async (client: PoolClient) => {
  await client.query("ROLLBACK").catch(() => undefined);
  client.release();
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

const expectDeactivatedWithoutSessions = async (pool: Pool) => {
  const state = await pool.query<{ deactivated: boolean; exactDeadline: boolean; sessions: number }>(
    `SELECT "deactivatedAt" IS NOT NULL AS deactivated,
      "scheduledAnonymizationAt" = "deactivatedAt" + interval '30 days' AS "exactDeadline",
      (SELECT count(*)::int FROM "refreshToken" WHERE "userId" = $1) AS sessions
     FROM "users" WHERE "userId" = $1`,
    [FIXTURE.userId],
  );
  expect(state.rows[0]).toEqual({ deactivated: true, exactDeadline: true, sessions: 0 });
};

const raceAfterQueuedDeactivation = async (
  app: INestApplication,
  pool: Pool,
  accessToken: string,
  deviceId: string,
  participant: () => Promise<request.Response>,
  inspectWaiting?: () => Promise<void>,
) => {
  const blocker = await startUserBlocker(pool);
  const deactivationRequest = deactivate(app, accessToken, deviceId).then((response) => response);
  let participantRequest: Promise<request.Response> | undefined;
  let released = false;
  try {
    await waitFor(async () => (await blockedBy(pool, blocker.pid)) >= 1);
    participantRequest = participant();
    await waitFor(async () => (await blockedBy(pool, blocker.pid)) >= 2);
    await inspectWaiting?.();
    await releaseBlocker(blocker.client);
    released = true;
    return Promise.all([deactivationRequest, participantRequest]);
  } catch (error) {
    if (!released) await rollbackBlocker(blocker.client);
    await Promise.allSettled([deactivationRequest, ...(participantRequest ? [participantRequest] : [])]);
    throw error;
  }
};

const consentDocumentIds = [
  "a0000000-0000-4000-8000-000000000011",
  "a0000000-0000-4000-8000-000000000012",
  "a0000000-0000-4000-8000-000000000013",
  "a0000000-0000-4000-8000-000000000014",
] as const;

const ANONYMIZATION_FIXTURE = {
  userId: "12000000-0000-4000-8000-000000000001",
  userid: "anonymization-user",
  email: "anonymization@example.test",
  providerUserId: "anonymization-kakao",
  ciHash: "anonymization-ci",
  verificationId: "13000000-0000-4000-8000-000000000001",
  stylePostId: "14000000-0000-4000-8000-000000000001",
  cartId: "15000000-0000-4000-8000-000000000001",
  orderId: "16000000-0000-4000-8000-000000000001",
  orderItemId: "17000000-0000-4000-8000-000000000001",
  consentDocumentId: "18000000-0000-4000-8000-000000000001",
  outboxId: "19000000-0000-4000-8000-000000000001",
  identitySessionId: "1a000000-0000-4000-8000-000000000001",
  notificationId: "1b000000-0000-4000-8000-000000000001",
  pushDeviceId: "1c000000-0000-4000-8000-000000000001",
  pushOutboxId: "1d000000-0000-4000-8000-000000000001",
  mediaKey: "style-posts/anonymization-user/preserved.jpg",
} as const;

const batchUserId = (index: number) => `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

const seedDueUsers = async (pool: Pool, userIds: readonly string[]) => {
  const userids = userIds.map((_, index) => `due-batch-${index + 1}`);
  const emails = userIds.map((_, index) => `due-batch-${index + 1}@example.test`);
  await pool.query(
    `INSERT INTO "users"
      ("userId", "userid", "email", "password", "role", "deactivatedAt", "scheduledAnonymizationAt")
     SELECT input."userId", input.userid, input.email, NULL, 'USER',
       transaction_timestamp() - interval '31 days',
       transaction_timestamp() - interval '2 days' + (input.position - 1) * interval '1 second'
     FROM unnest($1::uuid[], $2::text[], $3::text[]) WITH ORDINALITY
       AS input("userId", userid, email, position)`,
    [userIds, userids, emails],
  );
};

const seedAnonymizationFixture = async (pool: Pool) => {
  const fixture = ANONYMIZATION_FIXTURE;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO users
        ("userId", userid, email, password, role, "deactivatedAt", "scheduledAnonymizationAt")
       VALUES ($1, $2, $3, 'original-password-hash', 'USER', now() - interval '31 days', now() - interval '1 day')`,
      [fixture.userId, fixture.userid, fixture.email],
    );
    await client.query(
      `INSERT INTO "accountReactivationTokens" ("tokenHash", "userId", "deviceIdHash", "expiresAt")
       VALUES ('anonymization-reactivation', $1, 'anonymization-device', now() + interval '10 minutes')`,
      [fixture.userId],
    );
    await client.query(
      `INSERT INTO "refreshToken" ("userId", "deviceId", "refreshToken", "refreshTokenExp")
       VALUES ($1, 'anonymization-device', 'anonymization-refresh', now() + interval '1 day')`,
      [fixture.userId],
    );
    await client.query(
      `INSERT INTO "refreshTokenRotationMarker" ("userId", "deviceId", "rotationKey", "expiresAt")
       VALUES ($1, 'anonymization-device', 'anonymization-rotation', now() + interval '1 minute')`,
      [fixture.userId],
    );
    await client.query(
      `INSERT INTO notifications
        ("notificationId", "userId", type, title, body, route, "entityId", "dedupeKey")
       VALUES ($1, $2, 'ORDER_STATUS', 'Anonymization', 'Anonymization', $3, $4, 'anonymization-notification')`,
      [fixture.notificationId, fixture.userId, `/order/${fixture.orderId}`, fixture.orderId],
    );
    await client.query(
      `INSERT INTO "pushDevices"
        ("pushDeviceId", "userId", "installationId", "expoPushToken", platform)
       VALUES ($1, $2, 'anonymization-device', 'ExponentPushToken[anonymization]', 'IOS')`,
      [fixture.pushDeviceId, fixture.userId],
    );
    await client.query(`INSERT INTO "notificationPreferences" ("userId") VALUES ($1)`, [fixture.userId]);
    await client.query(
      `INSERT INTO "pushOutbox" ("pushOutboxId", "notificationId", "pushDeviceId") VALUES ($1, $2, $3)`,
      [fixture.pushOutboxId, fixture.notificationId, fixture.pushDeviceId],
    );
    await client.query(
      `INSERT INTO "passwordResetToken" ("tokenHash", "userId", "expiresAt")
       VALUES ('anonymization-reset', $1, now() + interval '10 minutes')`,
      [fixture.userId],
    );
    await client.query(
      `INSERT INTO "emailVerification" (id, email, purpose, "codeHash", "expiresAt", "verifiedAt")
       VALUES ($1, $2, 'PASSWORD_RESET', 'anonymization-code', now() + interval '10 minutes', now())`,
      [fixture.verificationId, fixture.email],
    );
    await client.query(
      `INSERT INTO "emailVerificationToken" ("tokenHash", email, purpose, "verificationId", "expiresAt")
       VALUES ('anonymization-email-token', $1, 'PASSWORD_RESET', $2, now() + interval '10 minutes')`,
      [fixture.email, fixture.verificationId],
    );
    await client.query(
      `INSERT INTO "emailDeliveryOutbox" (id, kind, email, "payloadCiphertext", "proofId", status, "expiresAt")
       VALUES ($1, 'PASSWORD_RESET_LINK', $2, 'anonymization-ciphertext', 'anonymization-reset', 'PENDING', now() + interval '10 minutes')`,
      [fixture.outboxId, fixture.email],
    );
    await client.query(`INSERT INTO "authIdentity" ("userId", provider, "providerUserId") VALUES ($1, 'kakao', $2)`, [
      fixture.userId,
      fixture.providerUserId,
    ]);
    await client.query(
      `INSERT INTO "verifiedIdentities" ("userId", "ciHash", "certificateProvider", "verifiedAt")
       VALUES ($1, $2, 'KAKAO', now())`,
      [fixture.userId, fixture.ciHash],
    );
    await client.query(
      `INSERT INTO "identityVerificationSessions"
        ("sessionId", purpose, provider, "deviceIdHash", "merchantTransactionId", status, "ciHash", "certificateProvider", "isFourteenOrOlder", "expiresAt", "verifiedAt")
       VALUES ($1, 'RECOVERY', 'KAKAO', 'anonymization-device', 'anon-transaction-001', 'VERIFIED', $2, 'KAKAO', true, now() + interval '10 minutes', now())`,
      [fixture.identitySessionId, fixture.ciHash],
    );
    await client.query(
      `INSERT INTO "kakaoSignupToken" ("tokenHash", "providerUserId", email, "emailVerified", "deviceIdHash", "expiresAt")
       VALUES ('anonymization-signup', $1, $2, true, 'anonymization-device', now() + interval '10 minutes')`,
      [fixture.providerUserId, fixture.email],
    );
    await client.query(
      `INSERT INTO "kakaoLoginFlows" ("userId", "deviceIdHash", "providerUserId", email, "emailVerified", status, "expiresAt")
       VALUES ($1, 'anonymization-device', $2, $3, true, 'EXISTING_USER', now() + interval '10 minutes')`,
      [fixture.userId, fixture.providerUserId, fixture.email],
    );
    await client.query(`INSERT INTO "brandFollows" ("userId", "brandId") VALUES ($1, $2)`, [
      fixture.userId,
      FIXTURE.brandId,
    ]);
    await client.query(
      `INSERT INTO "stylePosts" ("stylePostId", "authorId", title, content, "imageUrls", "imageKeys")
       VALUES ($1, $2, 'Preserved style', 'Preserved style', '[]', '[]')`,
      [fixture.stylePostId, fixture.userId],
    );
    await client.query(`INSERT INTO "stylePostProducts" ("stylePostId", "productId") VALUES ($1, $2)`, [
      fixture.stylePostId,
      FIXTURE.productId,
    ]);
    await client.query(`INSERT INTO "stylePostLikes" ("stylePostId", "userId") VALUES ($1, $2)`, [
      fixture.stylePostId,
      fixture.userId,
    ]);
    await client.query(`INSERT INTO wishes ("userId", "productId") VALUES ($1, $2)`, [
      fixture.userId,
      FIXTURE.productId,
    ]);
    await client.query(`INSERT INTO "recentProductViews" ("userId", "productId") VALUES ($1, $2)`, [
      fixture.userId,
      FIXTURE.productId,
    ]);
    await client.query(`INSERT INTO "comparisonItems" ("userId", "productId") VALUES ($1, $2)`, [
      fixture.userId,
      FIXTURE.productId,
    ]);
    await client.query(`INSERT INTO carts ("cartId", "userId") VALUES ($1, $2)`, [fixture.cartId, fixture.userId]);
    await client.query(`INSERT INTO "cartItems" ("cartId", "skuId", quantity) VALUES ($1, $2, 1)`, [
      fixture.cartId,
      FIXTURE.skuId,
    ]);
    await client.query(
      `INSERT INTO orders ("orderId", "orderNumber", "userId", status, "paymentStatus", "totalAmount")
       VALUES ($1, 'DJ-ANONYMIZATION-001', $2, 'COMPLETED', 'APPROVED', 15000)`,
      [fixture.orderId, fixture.userId],
    );
    await client.query(
      `INSERT INTO "orderItems"
        ("orderItemId", "orderId", "productId", "skuId", "productTitle", "skuOptionName", "unitPrice", quantity)
       VALUES ($1, $2, $3, $4, 'Integration Sale Tee', 'Black / M', 15000, 1)`,
      [fixture.orderItemId, fixture.orderId, FIXTURE.productId, FIXTURE.skuId],
    );
    await client.query(
      `INSERT INTO "checkoutIdempotencyKeys" ("userId", "idempotencyKey", "orderId", status)
       VALUES ($1, 'anonymization-checkout', $2, 'COMPLETED')`,
      [fixture.userId, fixture.orderId],
    );
    await client.query(
      `INSERT INTO "activityEvents" ("actorUserId", "eventType", "subjectType", "subjectId", payload)
       VALUES ($1, 'VIEW', 'PRODUCT', $2, '{"source":"fixture"}')`,
      [fixture.userId, FIXTURE.productId],
    );
    await client.query(
      `INSERT INTO "consentDocuments" ("documentId", type, title, body, version, required, "activeFrom")
       VALUES ($1, 'SERVICE_TERMS', 'Terms', 'Terms', 'anonymization', true, now())`,
      [fixture.consentDocumentId],
    );
    await client.query(
      `INSERT INTO "userConsentAcceptances" ("userId", "documentId", agreed, "agreedAt")
       VALUES ($1, $2, true, now())`,
      [fixture.userId, fixture.consentDocumentId],
    );
    await client.query(
      `INSERT INTO "auditLogs" ("actorUserId", action, "entityType", "entityId", metadata)
       VALUES ($1, 'ACCOUNT_EVENT', 'USER', $2, '{"source":"fixture"}')`,
      [fixture.userId, fixture.userId],
    );
    await client.query(
      `INSERT INTO "mediaObjectPromotions"
        ("finalKey", "ownerUserId", kind, "contentType", "objectSize", status, "readyAt")
       VALUES ($1, $2, 'STYLE_POST', 'image/jpeg', 100, 'READY', now())`,
      [fixture.mediaKey, fixture.userId],
    );
    await client.query(
      `INSERT INTO "mediaObjectReferences" ("entityType", "entityId", "finalKey")
       VALUES ('STYLE_POST', $1, $2)`,
      [fixture.stylePostId, fixture.mediaKey],
    );
    await client.query(
      `INSERT INTO "requestAdmission" (action, "scopeType", "scopeHash", "requestCount", "windowStartedAt", "expiresAt")
       VALUES ('anonymization-preserved', 'USER', $1, 1, now(), now() + interval '1 hour')`,
      [fixture.userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

jest.setTimeout(30_000);

describe("FO account lifecycle", () => {
  let app: INestApplication;
  let emailRepository: EmailRepository;
  let pool: Pool;
  let foAccountRepository: FoAccountRepository;
  let kakaoFlowRepository: KakaoFlowRepository;

  beforeAll(async () => {
    pool = testPool();
    app = await createApp();
    await app.listen(0, "127.0.0.1");
    emailRepository = app.get(EmailRepository);
    foAccountRepository = app.get(FoAccountRepository);
    kakaoFlowRepository = app.get(KakaoFlowRepository);
  });

  beforeEach(async () => {
    await resetTestFixtures(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("deactivates with database time, revokes every session, clears cookies, and rejects old tokens", async () => {
    const deviceId = "deactivation-device";
    const secondDeviceId = "deactivation-second-device";
    const first = await signin(app, deviceId);
    const second = await signin(app, secondDeviceId);
    const accessToken = first.body.data.signin.accessToken as string;
    const refreshToken = first.body.data.signin.refreshToken as string;
    expect(second.body.errors).toBeUndefined();
    const pushDeviceIds = ["1e000000-0000-4000-8000-000000000001", "1e000000-0000-4000-8000-000000000002"];
    const notificationIds = [
      "1f000000-0000-4000-8000-000000000001",
      "1f000000-0000-4000-8000-000000000002",
      "1f000000-0000-4000-8000-000000000003",
    ];
    await pool.query(
      `INSERT INTO "pushDevices"
        ("pushDeviceId", "userId", "installationId", "expoPushToken", platform)
       VALUES
        ($1, $3, $4, 'ExponentPushToken[deactivation-one]', 'IOS'),
        ($2, $3, $5, 'ExponentPushToken[deactivation-two]', 'IOS')`,
      [pushDeviceIds[0], pushDeviceIds[1], FIXTURE.userId, deviceId, secondDeviceId],
    );
    await pool.query(
      `INSERT INTO notifications
        ("notificationId", "userId", type, title, body, route, "entityId", "dedupeKey")
       VALUES
        ($1, $3, 'ORDER_STATUS', 'One', 'One', '/order/90000000-0000-4000-8000-000000000001',
          '90000000-0000-4000-8000-000000000001', 'deactivation-one'),
        ($2, $3, 'ORDER_STATUS', 'Two', 'Two', '/order/90000000-0000-4000-8000-000000000002',
          '90000000-0000-4000-8000-000000000002', 'deactivation-two'),
        ($4, $3, 'ORDER_STATUS', 'Three', 'Three', '/order/90000000-0000-4000-8000-000000000003',
          '90000000-0000-4000-8000-000000000003', 'deactivation-three')`,
      [notificationIds[0], notificationIds[1], FIXTURE.userId, notificationIds[2]],
    );
    await pool.query(
      `INSERT INTO "pushOutbox"
        ("notificationId", "pushDeviceId", status, "claimToken", "claimedAt", "expoTicketId", "receiptAvailableAt")
       VALUES
        ($1, $4, 'PENDING', NULL, NULL, NULL, NULL),
        ($2, $4, 'PROCESSING', $6, transaction_timestamp(), NULL, NULL),
        ($3, $5, 'TICKETED', NULL, NULL, 'deactivation-ticket', transaction_timestamp())`,
      [notificationIds[0], notificationIds[1], notificationIds[2], pushDeviceIds[0], pushDeviceIds[1], randomUUID()],
    );

    const response = await deactivate(app, accessToken, deviceId);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.deactivateFoAccount).toMatchObject({ ok: true });
    expect(cookies(response)).toEqual(
      expect.arrayContaining([expect.stringContaining("access_token=;"), expect.stringContaining("refresh_token=;")]),
    );
    const state = await pool.query<{
      exactDeadline: boolean;
      sessions: number;
      deactivatedAt: Date;
      scheduledAnonymizationAt: Date;
    }>(
      `SELECT
        "scheduledAnonymizationAt" = "deactivatedAt" + interval '30 days' AS "exactDeadline",
        (SELECT count(*)::int FROM "refreshToken" WHERE "userId" = $1) AS sessions,
        "deactivatedAt", "scheduledAnonymizationAt"
       FROM "users" WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    expect(state.rows[0]).toMatchObject({ exactDeadline: true, sessions: 0 });
    expect(response.body.data.deactivateFoAccount.scheduledAnonymizationAt).toBe(
      state.rows[0]?.scheduledAnonymizationAt.toISOString(),
    );
    const pushState = await pool.query<{
      activeDevices: number;
      failedDeliveries: number;
      unsettledDeliveries: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM "pushDevices" WHERE "userId" = $1 AND "disabledAt" IS NULL) AS "activeDevices",
        (SELECT count(*)::int FROM "pushOutbox" WHERE "pushDeviceId" = ANY($2::uuid[]) AND status = 'FAILED')
          AS "failedDeliveries",
        (SELECT count(*)::int FROM "pushOutbox"
          WHERE "pushDeviceId" = ANY($2::uuid[]) AND status IN ('PENDING', 'PROCESSING', 'TICKETED'))
          AS "unsettledDeliveries"`,
      [FIXTURE.userId, pushDeviceIds],
    );
    expect(pushState.rows[0]).toEqual({ activeDevices: 0, failedDeliveries: 3, unsettledDeliveries: 0 });
    expect((await me(app, accessToken)).body).toMatchObject({ data: null, errors: [expect.any(Object)] });
    expect((await refresh(app, refreshToken)).body).toMatchObject({ data: null, errors: [expect.any(Object)] });
    expect((await deactivate(app, accessToken, deviceId)).body.data).toBeNull();
  });

  it("rejects deactivation while a blocking order exists", async () => {
    const signedIn = await signin(app, "blocking-order-device");
    await pool.query(
      `INSERT INTO "orders" ("orderNumber", "userId", "status", "totalAmount")
       VALUES ('DJ-LIFECYCLE-BLOCK', $1, 'PAID', 1000)`,
      [FIXTURE.userId],
    );

    const response = await deactivate(app, signedIn.body.data.signin.accessToken, "blocking-order-device");

    expect(response.body.data).toBeNull();
    expect(response.body.errors[0].extensions.code).toBe("CONFLICT");
    const state = await pool.query<{ deactivatedAt: Date | null; sessions: number }>(
      `SELECT "deactivatedAt",
        (SELECT count(*)::int FROM "refreshToken" WHERE "userId" = $1) AS sessions
       FROM "users" WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    expect(state.rows[0]).toMatchObject({ deactivatedAt: null, sessions: 1 });
  });

  it("uses hashed device-bound one-time tokens and reactivates atomically before issuing a session", async () => {
    const deviceId = "reactivation-device";
    const signedIn = await signin(app, deviceId);
    await deactivate(app, signedIn.body.data.signin.accessToken, deviceId);
    const required = await signinFo(app, deviceId);
    const token = required.body.data.signinFo.reactivationToken as string;

    expect(required.body.data.signinFo).toMatchObject({ status: "REACTIVATION_REQUIRED", tokenPayload: null });
    expect(cookies(required)).toBeUndefined();
    const stored = await pool.query<{
      tokenHash: string;
      deviceIdHash: string;
      tenMinutes: boolean;
    }>(
      `SELECT "tokenHash", "deviceIdHash",
        "expiresAt" = "createdAt" + interval '10 minutes' AS "tenMinutes"
       FROM "accountReactivationTokens" WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    expect(stored.rows[0]).toEqual({
      tokenHash: hashToken(token),
      deviceIdHash: hashToken(deviceId),
      tenMinutes: true,
    });
    expect(stored.rows[0]?.tokenHash).not.toBe(token);
    expect((await reactivate(app, token, "other-device")).body.data).toBeNull();

    const recovered = await reactivate(app, token, deviceId);

    expect(recovered.body.errors).toBeUndefined();
    expect(recovered.body.data.reactivateFoAccount).toMatchObject({ role: "USER" });
    const bodyAccessToken = recovered.body.data.reactivateFoAccount.accessToken as string;
    const bodyRefreshToken = recovered.body.data.reactivateFoAccount.refreshToken as string;
    const cookieAccessToken = cookieValue(recovered, "access_token");
    const cookieRefreshToken = cookieValue(recovered, "refresh_token");
    expect(bodyAccessToken).toMatch(/^[^.\s]+\.[^.\s]+\.[^.\s]+$/);
    expect(bodyRefreshToken).toMatch(/^[^.\s]+\.[^.\s]+\.[^.\s]+$/);
    expect(cookieAccessToken).toMatch(/^[^.\s]+\.[^.\s]+\.[^.\s]+$/);
    expect(cookieRefreshToken).toMatch(/^[^.\s]+\.[^.\s]+\.[^.\s]+$/);
    expect(cookieAccessToken).toBe(bodyAccessToken);
    expect(cookieRefreshToken).toBe(bodyRefreshToken);
    const state = await pool.query<{
      deactivatedAt: Date | null;
      scheduledAnonymizationAt: Date | null;
      usedAt: Date | null;
      sessions: number;
    }>(
      `SELECT "deactivatedAt", "scheduledAnonymizationAt",
        (SELECT "usedAt" FROM "accountReactivationTokens" WHERE "tokenHash" = $2) AS "usedAt",
        (SELECT count(*)::int FROM "refreshToken" WHERE "userId" = $1) AS sessions
       FROM "users" WHERE "userId" = $1`,
      [FIXTURE.userId, hashToken(token)],
    );
    expect(state.rows[0]).toMatchObject({
      deactivatedAt: null,
      scheduledAnonymizationAt: null,
      usedAt: expect.any(Date),
      sessions: 1,
    });
    expect((await reactivate(app, token, deviceId)).body.data).toBeNull();
  });

  it("stamps a recovery token after a later deactivation commits to an older Kakao transaction", async () => {
    const ownerDevice = "timestamp-race-owner";
    const kakaoDevice = "timestamp-race-kakao";
    const flowId = "d0000000-0000-4000-8000-000000000032";
    const callbackToken = "timestamp-race-callback";
    const signedIn = await signin(app, ownerDevice);
    await pool.query(
      `INSERT INTO "authIdentity" ("userId", "provider", "providerUserId") VALUES ($1, 'kakao', 'timestamp-race')`,
      [FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "kakaoLoginFlows"
        ("flowId", "deviceIdHash", "providerUserId", "email", "emailVerified", "userId", "status", "callbackTokenHash", "expiresAt", "callbackAt")
       VALUES ($1, $2, 'timestamp-race', 'integration@example.test', true, $3, 'EXISTING_USER', $4, now() + interval '10 minutes', now())`,
      [flowId, hashToken(kakaoDevice), FIXTURE.userId, hashToken(callbackToken)],
    );
    const blocker = await startAdvisoryBlocker(pool, hashToken(kakaoDevice), 0);
    const kakaoRequest = completeKakaoLogin(app, flowId, callbackToken, kakaoDevice).then((response) => response);
    let released = false;

    try {
      await waitFor(async () => (await blockedBy(pool, blocker.pid)) === 1);
      const deactivationResponse = await deactivate(app, signedIn.body.data.signin.accessToken as string, ownerDevice);
      expect(deactivationResponse.body.errors).toBeUndefined();
      await releaseBlocker(blocker.client);
      released = true;
      const kakaoResponse = await kakaoRequest;
      expect(kakaoResponse.body.errors).toBeUndefined();
      expect(kakaoResponse.body.data.completeKakaoLogin).toMatchObject({
        status: "REACTIVATION_REQUIRED",
        tokenPayload: null,
        reactivationToken: expect.any(String),
      });
      const token = kakaoResponse.body.data.completeKakaoLogin.reactivationToken as string;
      const timestamps = await pool.query<{ currentCycle: boolean; tenMinutes: boolean }>(
        `SELECT token."createdAt" >= users."deactivatedAt" AS "currentCycle",
          token."expiresAt" = token."createdAt" + interval '10 minutes' AS "tenMinutes"
         FROM "accountReactivationTokens" token
         INNER JOIN "users" users ON users."userId" = token."userId"
         WHERE token."tokenHash" = $1`,
        [hashToken(token)],
      );
      expect(timestamps.rows[0]).toEqual({ currentCycle: true, tenMinutes: true });
      const recovered = await reactivate(app, token, kakaoDevice);
      expect(recovered.body.errors).toBeUndefined();
      expect(recovered.body.data.reactivateFoAccount.accessToken).toMatch(/^[^.\s]+\.[^.\s]+\.[^.\s]+$/);
      expect(recovered.body.data.reactivateFoAccount.refreshToken).toMatch(/^[^.\s]+\.[^.\s]+\.[^.\s]+$/);
    } finally {
      if (!released) {
        await rollbackBlocker(blocker.client);
        await Promise.allSettled([kakaoRequest]);
      }
    }
  });

  it("rejects a used recovery token while the account remains deactivated", async () => {
    const deviceId = "used-reactivation-device";
    const signedIn = await signin(app, deviceId);
    await deactivate(app, signedIn.body.data.signin.accessToken, deviceId);
    const required = await signinFo(app, deviceId);
    const token = required.body.data.signinFo.reactivationToken as string;
    const usedAt = (
      await pool.query<{ usedAt: Date }>(
        `UPDATE "accountReactivationTokens"
         SET "usedAt" = clock_timestamp()
         WHERE "tokenHash" = $1
         RETURNING "usedAt"`,
        [hashToken(token)],
      )
    ).rows[0]?.usedAt;
    if (!usedAt) throw new Error("Failed to mark recovery token used");
    const userBefore = (
      await pool.query<{ deactivatedAt: Date; scheduledAnonymizationAt: Date }>(
        `SELECT "deactivatedAt", "scheduledAnonymizationAt" FROM "users" WHERE "userId" = $1`,
        [FIXTURE.userId],
      )
    ).rows[0];
    const tokenBefore = (
      await pool.query<{
        tokenHash: string;
        userId: string;
        deviceIdHash: string;
        expiresAt: Date;
        usedAt: Date;
        createdAt: Date;
      }>(
        `SELECT "tokenHash", "userId", "deviceIdHash", "expiresAt", "usedAt", "createdAt"
         FROM "accountReactivationTokens" WHERE "tokenHash" = $1`,
        [hashToken(token)],
      )
    ).rows[0];
    if (!userBefore || !tokenBefore) throw new Error("Failed to snapshot used-token state");

    const response = await reactivate(app, token, deviceId);

    expect(response.body.data).toBeNull();
    expect(response.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
    expect(cookies(response)).toBeUndefined();
    const userAfter = (
      await pool.query<{ deactivatedAt: Date; scheduledAnonymizationAt: Date }>(
        `SELECT "deactivatedAt", "scheduledAnonymizationAt" FROM "users" WHERE "userId" = $1`,
        [FIXTURE.userId],
      )
    ).rows[0];
    const tokenAfter = (
      await pool.query<{
        tokenHash: string;
        userId: string;
        deviceIdHash: string;
        expiresAt: Date;
        usedAt: Date;
        createdAt: Date;
      }>(
        `SELECT "tokenHash", "userId", "deviceIdHash", "expiresAt", "usedAt", "createdAt"
         FROM "accountReactivationTokens" WHERE "tokenHash" = $1`,
        [hashToken(token)],
      )
    ).rows[0];
    expect(userAfter).toEqual(userBefore);
    expect(tokenAfter).toEqual(tokenBefore);
    const sessions = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "refreshToken" WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    expect(sessions.rows[0]?.count).toBe(0);
  });

  it("allows only one concurrent reactivation with the same token", async () => {
    const deviceId = "concurrent-reactivation-device";
    const signedIn = await signin(app, deviceId);
    await deactivate(app, signedIn.body.data.signin.accessToken, deviceId);
    const required = await signinFo(app, deviceId);
    const token = required.body.data.signinFo.reactivationToken as string;
    const blocker = await startUserBlocker(pool);
    let released = false;
    const requests = [
      reactivate(app, token, deviceId).then((response) => response),
      reactivate(app, token, deviceId).then((response) => response),
    ];

    try {
      await waitFor(async () => (await blockedBy(pool, blocker.pid)) >= 2);
      await releaseBlocker(blocker.client);
      released = true;
      const responses = await Promise.all(requests);
      const successful = responses.filter((response) => response.body.data?.reactivateFoAccount);
      const rejected = responses.filter((response) => response.body.errors);

      expect(successful).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.body.data).toBeNull();
      expect(rejected[0]?.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
      expect(cookies(rejected[0] as request.Response)).toBeUndefined();
      const winner = successful[0] as request.Response;
      const bodyAccessToken = winner.body.data.reactivateFoAccount.accessToken as string;
      const bodyRefreshToken = winner.body.data.reactivateFoAccount.refreshToken as string;
      const cookieAccessToken = cookieValue(winner, "access_token");
      const cookieRefreshToken = cookieValue(winner, "refresh_token");
      expect(bodyAccessToken).toMatch(/^[^.\s]+\.[^.\s]+\.[^.\s]+$/);
      expect(bodyRefreshToken).toMatch(/^[^.\s]+\.[^.\s]+\.[^.\s]+$/);
      expect(cookieAccessToken).toMatch(/^[^.\s]+\.[^.\s]+\.[^.\s]+$/);
      expect(cookieRefreshToken).toMatch(/^[^.\s]+\.[^.\s]+\.[^.\s]+$/);
      expect(cookieAccessToken).toBe(bodyAccessToken);
      expect(cookieRefreshToken).toBe(bodyRefreshToken);
      const state = await pool.query<{
        deactivatedAt: Date | null;
        refreshToken: string;
        scheduledAnonymizationAt: Date | null;
        used: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM "accountReactivationTokens" WHERE "tokenHash" = $1 AND "usedAt" IS NOT NULL) AS used,
          (SELECT "refreshToken" FROM "refreshToken" WHERE "userId" = $2 AND "deviceId" = $3) AS "refreshToken",
          "deactivatedAt", "scheduledAnonymizationAt"
         FROM "users" WHERE "userId" = $2`,
        [hashToken(token), FIXTURE.userId, deviceId],
      );
      expect(state.rows[0]).toEqual({
        used: 1,
        refreshToken: hashToken(bodyRefreshToken),
        deactivatedAt: null,
        scheduledAnonymizationAt: null,
      });
    } finally {
      if (!released) {
        await rollbackBlocker(blocker.client);
        await Promise.allSettled(requests);
      }
    }
  });

  it("rejects expired tokens, past-deadline recovery, and tokens from an earlier deactivation cycle", async () => {
    const deviceId = "reactivation-boundary-device";
    const signedIn = await signin(app, deviceId);
    await deactivate(app, signedIn.body.data.signin.accessToken, deviceId);
    const firstRequired = await signinFo(app, deviceId);
    const expiredToken = firstRequired.body.data.signinFo.reactivationToken as string;
    await pool.query(`UPDATE "accountReactivationTokens" SET "expiresAt" = now() - interval '1 second'`);
    expect((await reactivate(app, expiredToken, deviceId)).body.data).toBeNull();

    const secondRequired = await signinFo(app, deviceId);
    const pastDeadlineToken = secondRequired.body.data.signinFo.reactivationToken as string;
    await pool.query(
      `UPDATE "users"
       SET "deactivatedAt" = now() - interval '30 days 1 second',
           "scheduledAnonymizationAt" = now() - interval '1 second'
       WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    expect((await reactivate(app, pastDeadlineToken, deviceId)).body.data).toBeNull();

    await pool.query(
      `UPDATE "users"
       SET "deactivatedAt" = now(), "scheduledAnonymizationAt" = now() + interval '30 days'
       WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    expect((await reactivate(app, pastDeadlineToken, deviceId)).body.data).toBeNull();
  });

  it("rejects reactivation at exact expiry and anonymization deadline boundaries", async () => {
    const deviceId = "reactivation-exact-boundary-device";
    const signedIn = await signin(app, deviceId);
    await deactivate(app, signedIn.body.data.signin.accessToken, deviceId);
    const expiryRequired = await signinFo(app, deviceId);
    const expiryToken = expiryRequired.body.data.signinFo.reactivationToken as string;
    const expiryBlocker = await startUserBlocker(pool);
    const expiryRequest = reactivate(app, expiryToken, deviceId).then((response) => response);
    let expiryReleased = false;
    let expired: request.Response;
    try {
      await waitFor(async () => (await blockedBy(pool, expiryBlocker.pid)) === 1);
      const expiryPid = (await blockedPids(pool, expiryBlocker.pid))[0];
      if (!expiryPid) throw new Error("Failed to identify expiry-boundary request");
      await expiryBlocker.client.query(
        `UPDATE "accountReactivationTokens"
         SET "expiresAt" = (SELECT xact_start FROM pg_stat_activity WHERE pid = $1)
         WHERE "tokenHash" = $2`,
        [expiryPid, hashToken(expiryToken)],
      );
      await releaseBlocker(expiryBlocker.client);
      expiryReleased = true;
      expired = await expiryRequest;
    } finally {
      if (!expiryReleased) {
        await rollbackBlocker(expiryBlocker.client);
        await Promise.allSettled([expiryRequest]);
      }
    }

    expect(expired.body.data).toBeNull();
    expect(expired.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
    const deadlineRequired = await signinFo(app, deviceId);
    const deadlineToken = deadlineRequired.body.data.signinFo.reactivationToken as string;
    const deadlineBlocker = await startUserBlocker(pool);
    const deadlineRequest = reactivate(app, deadlineToken, deviceId).then((response) => response);
    let deadlineReleased = false;
    let atDeadline: request.Response;
    try {
      await waitFor(async () => (await blockedBy(pool, deadlineBlocker.pid)) === 1);
      const deadlinePid = (await blockedPids(pool, deadlineBlocker.pid))[0];
      if (!deadlinePid) throw new Error("Failed to identify deadline-boundary request");
      await deadlineBlocker.client.query(
        `UPDATE "users"
         SET "scheduledAnonymizationAt" = (SELECT xact_start FROM pg_stat_activity WHERE pid = $1)
         WHERE "userId" = $2`,
        [deadlinePid, FIXTURE.userId],
      );
      await releaseBlocker(deadlineBlocker.client);
      deadlineReleased = true;
      atDeadline = await deadlineRequest;
    } finally {
      if (!deadlineReleased) {
        await rollbackBlocker(deadlineBlocker.client);
        await Promise.allSettled([deadlineRequest]);
      }
    }

    expect(atDeadline.body.data).toBeNull();
    expect(atDeadline.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
    const state = await pool.query<{ unused: number; sessions: number }>(
      `SELECT
        (SELECT count(*)::int FROM "accountReactivationTokens" WHERE "userId" = $1 AND "usedAt" IS NULL) AS unused,
        (SELECT count(*)::int FROM "refreshToken" WHERE "userId" = $1) AS sessions`,
      [FIXTURE.userId],
    );
    expect(state.rows[0]).toEqual({ unused: 2, sessions: 0 });
  });

  it("queues deactivation before checkout and rejects the checkout without creating an order", async () => {
    const deviceId = "checkout-deactivation-device";
    const signedIn = await signin(app, deviceId);
    const accessToken = signedIn.body.data.signin.accessToken as string;
    await addCartItem(app, accessToken);

    const [deactivationResponse, checkoutResponse] = await raceAfterQueuedDeactivation(
      app,
      pool,
      accessToken,
      deviceId,
      () => checkout(app, accessToken, "checkout-deactivation-race").then((response) => response),
    );

    expect(deactivationResponse.body.errors).toBeUndefined();
    expect(deactivationResponse.body.data.deactivateFoAccount.ok).toBe(true);
    expect(checkoutResponse.body.data).toBeNull();
    expect(checkoutResponse.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
    const state = await pool.query<{ cartItems: number; idempotencyKeys: number; orders: number; stock: number }>(
      `SELECT
        (SELECT count(*)::int FROM "cartItems" ci INNER JOIN "carts" c ON c."cartId" = ci."cartId" WHERE c."userId" = $1) AS "cartItems",
        (SELECT count(*)::int FROM "checkoutIdempotencyKeys" WHERE "userId" = $1) AS "idempotencyKeys",
        (SELECT count(*)::int FROM "orders" WHERE "userId" = $1) AS orders,
        (SELECT stock FROM "productSkus" WHERE "skuId" = $2) AS stock`,
      [FIXTURE.userId, FIXTURE.skuId],
    );
    expect(state.rows[0]).toEqual({ cartItems: 1, idempotencyKeys: 0, orders: 0, stock: 5 });
    await expectDeactivatedWithoutSessions(pool);
  });

  it("queues deactivation before generic sign-in and rejects session issuance", async () => {
    const ownerDevice = "generic-race-owner";
    const signedIn = await signin(app, ownerDevice);

    const [deactivationResponse, signinResponse] = await raceAfterQueuedDeactivation(
      app,
      pool,
      signedIn.body.data.signin.accessToken,
      ownerDevice,
      () => signin(app, "generic-race-participant").then((response) => response),
    );

    expect(deactivationResponse.body.errors).toBeUndefined();
    expect(signinResponse.body.data).toBeNull();
    expect(signinResponse.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
    expect(cookies(signinResponse)).toBeUndefined();
    await expectDeactivatedWithoutSessions(pool);
  });

  it("queues deactivation before FO sign-in and creates recovery without a session cookie", async () => {
    const ownerDevice = "fo-race-owner";
    const participantDevice = "fo-race-participant";
    const signedIn = await signin(app, ownerDevice);

    const [deactivationResponse, signinResponse] = await raceAfterQueuedDeactivation(
      app,
      pool,
      signedIn.body.data.signin.accessToken,
      ownerDevice,
      () => signinFo(app, participantDevice).then((response) => response),
    );

    expect(deactivationResponse.body.errors).toBeUndefined();
    expect(signinResponse.body.errors).toBeUndefined();
    expect(signinResponse.body.data.signinFo).toMatchObject({
      status: "REACTIVATION_REQUIRED",
      tokenPayload: null,
      reactivationToken: expect.any(String),
    });
    expect(cookies(signinResponse)).toBeUndefined();
    const tokens = await pool.query<{ count: number; deviceIdHash: string }>(
      `SELECT count(*)::int AS count, min("deviceIdHash") AS "deviceIdHash"
       FROM "accountReactivationTokens" WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    expect(tokens.rows[0]).toEqual({ count: 1, deviceIdHash: hashToken(participantDevice) });
    await expectDeactivatedWithoutSessions(pool);
  });

  it("revalidates the existing Kakao identity after the user lock before updating its callback flow", async () => {
    const flowId = "d0000000-0000-4000-8000-000000000030";
    await pool.query(
      `INSERT INTO "authIdentity" ("userId", "provider", "providerUserId") VALUES ($1, 'kakao', 'callback-race')`,
      [FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "kakaoLoginFlows" ("flowId", "deviceIdHash", "status", "expiresAt")
       VALUES ($1, $2, 'PENDING', now() + interval '10 minutes')`,
      [flowId, hashToken("callback-race-device")],
    );
    const blocker = await startUserBlocker(pool);
    const callback = kakaoFlowRepository.acceptCallback(
      flowId,
      { providerUserId: "callback-race", email: "integration@example.test", emailVerified: true },
      "integration@example.test",
      hashToken("callback-race-token"),
    );
    let released = false;

    try {
      await waitFor(async () => (await blockedBy(pool, blocker.pid)) === 1);
      expect(
        await rowCanBeLocked(pool, `SELECT "flowId" FROM "kakaoLoginFlows" WHERE "flowId" = $1 FOR UPDATE NOWAIT`, [
          flowId,
        ]),
      ).toBe(true);
      await blocker.client.query(
        `DELETE FROM "authIdentity" WHERE "provider" = 'kakao' AND "providerUserId" = 'callback-race'`,
      );
      await blocker.client.query(
        `UPDATE "users"
         SET "deactivatedAt" = transaction_timestamp() - interval '30 days',
             "scheduledAnonymizationAt" = transaction_timestamp(),
             "anonymizedAt" = transaction_timestamp()
         WHERE "userId" = $1`,
        [FIXTURE.userId],
      );
      await releaseBlocker(blocker.client);
      released = true;
      await expect(callback).resolves.toMatchObject({ status: "SIGNUP_REQUIRED", userId: null });
    } finally {
      if (!released) {
        await rollbackBlocker(blocker.client);
        await Promise.allSettled([callback]);
      }
    }
  });

  it("queues deactivation before existing-user Kakao login and locks the flow only after the user", async () => {
    const ownerDevice = "kakao-race-owner";
    const kakaoDevice = "kakao-race-participant";
    const flowId = "d0000000-0000-4000-8000-000000000031";
    const callbackToken = "kakao-race-callback";
    const signedIn = await signin(app, ownerDevice);
    await pool.query(
      `INSERT INTO "authIdentity" ("userId", "provider", "providerUserId") VALUES ($1, 'kakao', 'kakao-race')`,
      [FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "kakaoLoginFlows"
        ("flowId", "deviceIdHash", "providerUserId", "email", "emailVerified", "userId", "status", "callbackTokenHash", "expiresAt", "callbackAt")
       VALUES ($1, $2, 'kakao-race', 'integration@example.test', true, $3, 'EXISTING_USER', $4, now() + interval '10 minutes', now())`,
      [flowId, hashToken(kakaoDevice), FIXTURE.userId, hashToken(callbackToken)],
    );

    const [deactivationResponse, kakaoResponse] = await raceAfterQueuedDeactivation(
      app,
      pool,
      signedIn.body.data.signin.accessToken,
      ownerDevice,
      () => completeKakaoLogin(app, flowId, callbackToken, kakaoDevice).then((response) => response),
      async () => {
        expect(
          await rowCanBeLocked(pool, `SELECT "flowId" FROM "kakaoLoginFlows" WHERE "flowId" = $1 FOR UPDATE NOWAIT`, [
            flowId,
          ]),
        ).toBe(true);
      },
    );

    expect(deactivationResponse.body.errors).toBeUndefined();
    expect(kakaoResponse.body.errors).toBeUndefined();
    expect(kakaoResponse.body.data.completeKakaoLogin).toMatchObject({
      status: "REACTIVATION_REQUIRED",
      tokenPayload: null,
      reactivationToken: expect.any(String),
      kakaoSignupToken: null,
      email: null,
      emailVerificationRequired: false,
    });
    expect(cookies(kakaoResponse)).toBeUndefined();
    expect(kakaoResponse.headers.authorization).toBeUndefined();
    const state = await pool.query<{ consumed: boolean; tokens: number }>(
      `SELECT "consumedAt" IS NOT NULL AS consumed,
        (SELECT count(*)::int FROM "accountReactivationTokens" WHERE "userId" = $2) AS tokens
       FROM "kakaoLoginFlows" WHERE "flowId" = $1`,
      [flowId, FIXTURE.userId],
    );
    expect(state.rows[0]).toEqual({ consumed: true, tokens: 1 });
    await expectDeactivatedWithoutSessions(pool);
  });

  it("queues deactivation before refresh and rejects rotation without a marker", async () => {
    const ownerDevice = "refresh-race-owner";
    const signedIn = await signin(app, ownerDevice);

    const [deactivationResponse, refreshResponse] = await raceAfterQueuedDeactivation(
      app,
      pool,
      signedIn.body.data.signin.accessToken,
      ownerDevice,
      () => refresh(app, signedIn.body.data.signin.refreshToken).then((response) => response),
    );

    expect(deactivationResponse.body.errors).toBeUndefined();
    expect(refreshResponse.body.data).toBeNull();
    expect(refreshResponse.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
    expect(cookies(refreshResponse)).toBeUndefined();
    const markers = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "refreshTokenRotationMarker" WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    expect(markers.rows[0]?.count).toBe(0);
    await expectDeactivatedWithoutSessions(pool);
  });

  it("queues deactivation before linked Kakao signup and locks proofs only after the user", async () => {
    const ownerDevice = "linked-signup-owner";
    const signupDevice = "linked-signup-device";
    const signedIn = await signin(app, ownerDevice);
    await pool.query(
      `INSERT INTO "consentDocuments" ("documentId", "type", "title", "body", "version", "required", "activeFrom") VALUES
        ($1, 'AGE_OVER_14', 'Age', 'Age body', '1', true, now()),
        ($2, 'SERVICE_TERMS', 'Terms', 'Terms body', '1', true, now()),
        ($3, 'PRIVACY_COLLECTION', 'Privacy', 'Privacy body', '1', true, now()),
        ($4, 'MARKETING', 'Marketing', 'Marketing body', '1', false, now())`,
      [...consentDocumentIds],
    );
    await pool.query(
      `INSERT INTO "verifiedIdentities" ("userId", "ciHash", "certificateProvider", "verifiedAt")
       VALUES ($1, 'linked-signup-ci', 'KAKAO', now())`,
      [FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "identityVerificationSessions"
        ("sessionId", "purpose", "provider", "deviceIdHash", "merchantTransactionId", "status", "ciHash", "certificateProvider", "isFourteenOrOlder", "proofTokenHash", "expiresAt", "verifiedAt", "completedAt")
       VALUES ('c0000000-0000-4000-8000-000000000031', 'SIGNUP', 'KAKAO', $1, '12345678901234567831', 'VERIFIED', 'linked-signup-ci', 'KAKAO', true, $2, now() + interval '10 minutes', now(), now())`,
      [hashToken(signupDevice), hashToken("linked-signup-identity-proof")],
    );
    await pool.query(
      `INSERT INTO "kakaoSignupToken"
        ("tokenHash", "providerUserId", "email", "emailVerified", "deviceIdHash", "expiresAt")
       VALUES ($1, 'linked-signup-provider', 'integration@example.test', true, $2, now() + interval '10 minutes')`,
      [hashToken("linked-signup-proof"), hashToken(signupDevice)],
    );
    const completeSignup = () =>
      request(app.getHttpServer())
        .post("/graphql")
        .set("x-device-id", signupDevice)
        .send({
          query: `mutation CompleteKakaoSignupFo($input: CompleteKakaoSignupFoInput!) {
            completeKakaoSignupFo(input: $input) { accessToken refreshToken role }
          }`,
          variables: {
            input: {
              kakaoSignupToken: "linked-signup-proof",
              identityVerificationToken: "linked-signup-identity-proof",
              consents: consentDocumentIds.map((documentId, index) => ({ documentId, agreed: index < 3 })),
            },
          },
        })
        .then((response) => response);

    const [deactivationResponse, signupResponse] = await raceAfterQueuedDeactivation(
      app,
      pool,
      signedIn.body.data.signin.accessToken,
      ownerDevice,
      completeSignup,
      async () => {
        expect(
          await rowCanBeLocked(
            pool,
            `SELECT "tokenHash" FROM "kakaoSignupToken" WHERE "tokenHash" = $1 FOR UPDATE NOWAIT`,
            [hashToken("linked-signup-proof")],
          ),
        ).toBe(true);
        expect(
          await rowCanBeLocked(
            pool,
            `SELECT "sessionId" FROM "identityVerificationSessions" WHERE "proofTokenHash" = $1 FOR UPDATE NOWAIT`,
            [hashToken("linked-signup-identity-proof")],
          ),
        ).toBe(true);
      },
    );

    expect(deactivationResponse.body.errors).toBeUndefined();
    expect(signupResponse.body.data).toBeNull();
    expect(signupResponse.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
    expect(cookies(signupResponse)).toBeUndefined();
    const state = await pool.query<{ signupUsed: boolean; identityConsumed: boolean; links: number; consents: number }>(
      `SELECT
        (SELECT "usedAt" IS NOT NULL FROM "kakaoSignupToken" WHERE "tokenHash" = $1) AS "signupUsed",
        (SELECT "consumedAt" IS NOT NULL FROM "identityVerificationSessions" WHERE "proofTokenHash" = $2) AS "identityConsumed",
        (SELECT count(*)::int FROM "authIdentity" WHERE "providerUserId" = 'linked-signup-provider') AS links,
        (SELECT count(*)::int FROM "userConsentAcceptances" WHERE "userId" = $3) AS consents`,
      [hashToken("linked-signup-proof"), hashToken("linked-signup-identity-proof"), FIXTURE.userId],
    );
    expect(state.rows[0]).toEqual({ signupUsed: false, identityConsumed: false, links: 0, consents: 0 });
    await expectDeactivatedWithoutSessions(pool);
  });

  it("removes personal rows while preserving legal and authored records", async () => {
    const fixture = ANONYMIZATION_FIXTURE;
    await seedAnonymizationFixture(pool);

    await expect(foAccountRepository.anonymizeDueBatch(100)).resolves.toEqual([fixture.userId]);

    const removed = await pool.query<Record<string, number>>(
      `SELECT
        (SELECT count(*)::int FROM "accountReactivationTokens" WHERE "userId" = $1) AS "reactivationTokens",
        (SELECT count(*)::int FROM "refreshToken" WHERE "userId" = $1) AS "refreshTokens",
        (SELECT count(*)::int FROM "refreshTokenRotationMarker" WHERE "userId" = $1) AS "rotationMarkers",
        (SELECT count(*)::int FROM "passwordResetToken" WHERE "userId" = $1) AS "passwordResetTokens",
        (SELECT count(*)::int FROM "emailVerificationToken" WHERE email = $2) AS "emailVerificationTokens",
        (SELECT count(*)::int FROM "emailVerification" WHERE email = $2) AS "emailVerifications",
        (SELECT count(*)::int FROM "emailDeliveryOutbox" WHERE email = $2) AS "emailOutbox",
        (SELECT count(*)::int FROM "kakaoSignupToken" WHERE "providerUserId" = $3 OR email = $2) AS "kakaoSignupTokens",
        (SELECT count(*)::int FROM "kakaoLoginFlows" WHERE "userId" = $1 OR "providerUserId" = $3 OR email = $2) AS "kakaoLoginFlows",
        (SELECT count(*)::int FROM "identityVerificationSessions" WHERE "ciHash" = $4) AS "identitySessions",
        (SELECT count(*)::int FROM "authIdentity" WHERE "userId" = $1) AS "authIdentities",
        (SELECT count(*)::int FROM "verifiedIdentities" WHERE "userId" = $1) AS "verifiedIdentities",
        (SELECT count(*)::int FROM "brandFollows" WHERE "userId" = $1) AS "brandFollows",
        (SELECT count(*)::int FROM "stylePostLikes" WHERE "userId" = $1) AS "stylePostLikes",
        (SELECT count(*)::int FROM wishes WHERE "userId" = $1) AS wishes,
        (SELECT count(*)::int FROM "recentProductViews" WHERE "userId" = $1) AS "recentProductViews",
        (SELECT count(*)::int FROM "comparisonItems" WHERE "userId" = $1) AS "comparisonItems",
        (SELECT count(*)::int FROM "cartItems" ci INNER JOIN carts c ON c."cartId" = ci."cartId" WHERE c."userId" = $1) AS "cartItems",
        (SELECT count(*)::int FROM carts WHERE "userId" = $1) AS carts,
        (SELECT count(*)::int FROM "checkoutIdempotencyKeys" WHERE "userId" = $1) AS "checkoutIdempotencyKeys",
        (SELECT count(*)::int FROM "activityEvents" WHERE "actorUserId" = $1) AS "activityEvents",
        (SELECT count(*)::int FROM "pushOutbox" WHERE "pushDeviceId" = $5) AS "pushOutbox",
        (SELECT count(*)::int FROM notifications WHERE "userId" = $1) AS notifications,
        (SELECT count(*)::int FROM "notificationPreferences" WHERE "userId" = $1) AS "notificationPreferences",
        (SELECT count(*)::int FROM "pushDevices" WHERE "userId" = $1) AS "pushDevices"`,
      [fixture.userId, fixture.email, fixture.providerUserId, fixture.ciHash, fixture.pushDeviceId],
    );
    expect(removed.rows[0]).toEqual({
      reactivationTokens: 0,
      refreshTokens: 0,
      rotationMarkers: 0,
      passwordResetTokens: 0,
      emailVerificationTokens: 0,
      emailVerifications: 0,
      emailOutbox: 0,
      kakaoSignupTokens: 0,
      kakaoLoginFlows: 0,
      identitySessions: 0,
      authIdentities: 0,
      verifiedIdentities: 0,
      brandFollows: 0,
      stylePostLikes: 0,
      wishes: 0,
      recentProductViews: 0,
      comparisonItems: 0,
      cartItems: 0,
      carts: 0,
      checkoutIdempotencyKeys: 0,
      activityEvents: 0,
      pushOutbox: 0,
      notifications: 0,
      notificationPreferences: 0,
      pushDevices: 0,
    });
    const preserved = await pool.query<{
      auditLogs: number;
      consentAcceptances: number;
      mediaPromotions: number;
      mediaReferences: number;
      orderItems: number;
      orders: number;
      requestAdmissions: number;
      stylePosts: number;
      users: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM users WHERE "userId" = $1) AS users,
        (SELECT count(*)::int FROM orders WHERE "userId" = $1) AS orders,
        (SELECT count(*)::int FROM "orderItems" oi INNER JOIN orders o ON o."orderId" = oi."orderId" WHERE o."userId" = $1) AS "orderItems",
        (SELECT count(*)::int FROM "stylePosts" WHERE "authorId" = $1) AS "stylePosts",
        (SELECT count(*)::int FROM "userConsentAcceptances" WHERE "userId" = $1) AS "consentAcceptances",
        (SELECT count(*)::int FROM "auditLogs" WHERE "actorUserId" = $1) AS "auditLogs",
        (SELECT count(*)::int FROM "mediaObjectPromotions" WHERE "ownerUserId" = $1) AS "mediaPromotions",
        (SELECT count(*)::int FROM "mediaObjectReferences" WHERE "entityId" = $2) AS "mediaReferences",
        (SELECT count(*)::int FROM "requestAdmission" WHERE action = 'anonymization-preserved' AND "scopeHash" = $3) AS "requestAdmissions"`,
      [fixture.userId, fixture.stylePostId, fixture.userId],
    );
    expect(preserved.rows[0]).toEqual({
      users: 1,
      orders: 1,
      orderItems: 1,
      stylePosts: 1,
      consentAcceptances: 1,
      auditLogs: 1,
      mediaPromotions: 1,
      mediaReferences: 1,
      requestAdmissions: 1,
    });
    const user = await pool.query<{
      anonymizedAt: Date | null;
      email: string;
      password: string | null;
      userid: string;
    }>(`SELECT "userid", "email", "password", "anonymizedAt" FROM users WHERE "userId" = $1`, [fixture.userId]);
    expect(user.rows[0]).toEqual({
      userid: `deleted-${fixture.userId.replaceAll("-", "")}`,
      email: `deleted+${fixture.userId.replaceAll("-", "")}@invalid.local`,
      password: null,
      anonymizedAt: expect.any(Date),
    });
  });

  it("masks a preserved style post author after anonymization", async () => {
    const fixture = ANONYMIZATION_FIXTURE;
    await seedAnonymizationFixture(pool);
    await foAccountRepository.anonymizeDueBatch(100);

    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `query StylePost($stylePostId: String!) {
          stylePost(stylePostId: $stylePostId) { author { userId userid } }
        }`,
        variables: { stylePostId: fixture.stylePostId },
      });

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.stylePost.author).toEqual({ userId: fixture.userId, userid: "탈퇴한 사용자" });
  });

  it("claims only the 100 earliest due users in deterministic order", async () => {
    const userIds = Array.from({ length: 101 }, (_, index) => batchUserId(index + 1));
    await seedDueUsers(pool, userIds);

    const anonymized = await foAccountRepository.anonymizeDueBatch(100);

    expect(anonymized).toEqual(userIds.slice(0, 100));
    const remaining = await pool.query<{ userId: string }>(
      `SELECT "userId" FROM users
       WHERE "deactivatedAt" IS NOT NULL AND "anonymizedAt" IS NULL
       ORDER BY "scheduledAnonymizationAt", "userId"`,
    );
    expect(remaining.rows).toEqual([{ userId: userIds[100] }]);
  });

  it("lets two workers skip locked users without processing the same account", async () => {
    const firstUserId = batchUserId(201);
    const secondUserId = batchUserId(202);
    await seedDueUsers(pool, [firstUserId, secondUserId]);
    await pool.query(
      `CREATE OR REPLACE FUNCTION block_first_anonymization() RETURNS trigger AS $$
       BEGIN
         IF NEW."userId" = '${firstUserId}'::uuid AND OLD."anonymizedAt" IS NULL AND NEW."anonymizedAt" IS NOT NULL THEN
           PERFORM pg_advisory_xact_lock(hashtextextended(NEW."userId"::text, 91));
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql;
       CREATE TRIGGER block_first_anonymization_trigger
       BEFORE UPDATE ON users
       FOR EACH ROW EXECUTE FUNCTION block_first_anonymization()`,
    );
    const blocker = await startAdvisoryBlocker(pool, firstUserId, 91);
    const firstRun = foAccountRepository.anonymizeDueBatch(2);
    let released = false;

    try {
      await waitFor(async () => (await blockedBy(pool, blocker.pid)) === 1);
      const secondRun = await foAccountRepository.anonymizeDueBatch(2);
      expect(secondRun).toEqual([secondUserId]);
      await releaseBlocker(blocker.client);
      released = true;
      await expect(firstRun).resolves.toEqual([firstUserId]);
    } finally {
      if (!released) {
        await rollbackBlocker(blocker.client);
        await Promise.allSettled([firstRun]);
      }
      await pool.query(`DROP TRIGGER IF EXISTS block_first_anonymization_trigger ON users`);
      await pool.query(`DROP FUNCTION IF EXISTS block_first_anonymization()`);
    }
    const state = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM users WHERE "userId" = ANY($1::uuid[]) AND "anonymizedAt" IS NOT NULL`,
      [[firstUserId, secondUserId]],
    );
    expect(state.rows[0]?.count).toBe(2);
  });

  it("rolls back every cleanup row when the retained-user update fails", async () => {
    const fixture = ANONYMIZATION_FIXTURE;
    await seedAnonymizationFixture(pool);
    await pool.query(
      `CREATE OR REPLACE FUNCTION reject_anonymization_update() RETURNS trigger AS $$
       BEGIN
         IF NEW."userId" = '${fixture.userId}'::uuid AND NEW."anonymizedAt" IS NOT NULL THEN
           RAISE EXCEPTION 'reject anonymization fixture';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql;
       CREATE TRIGGER reject_anonymization_update_trigger
       BEFORE UPDATE ON users
       FOR EACH ROW EXECUTE FUNCTION reject_anonymization_update()`,
    );

    let failure: unknown;
    try {
      await foAccountRepository.anonymizeDueBatch(100).catch((error: unknown) => {
        failure = error;
      });
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS reject_anonymization_update_trigger ON users`);
      await pool.query(`DROP FUNCTION IF EXISTS reject_anonymization_update()`);
    }
    expect(hasDatabaseErrorCode(failure, "P0001")).toBe(true);
    const state = await pool.query<{
      anonymizedAt: Date | null;
      reactivationTokens: number;
      wishes: number;
      carts: number;
      notifications: number;
      pushDevices: number;
      pushOutbox: number;
    }>(
      `SELECT "anonymizedAt",
        (SELECT count(*)::int FROM "accountReactivationTokens" WHERE "userId" = $1) AS "reactivationTokens",
        (SELECT count(*)::int FROM wishes WHERE "userId" = $1) AS wishes,
        (SELECT count(*)::int FROM carts WHERE "userId" = $1) AS carts,
        (SELECT count(*)::int FROM notifications WHERE "userId" = $1) AS notifications,
        (SELECT count(*)::int FROM "pushDevices" WHERE "userId" = $1) AS "pushDevices",
        (SELECT count(*)::int FROM "pushOutbox" WHERE "pushDeviceId" = $2) AS "pushOutbox"
       FROM users WHERE "userId" = $1`,
      [fixture.userId, fixture.pushDeviceId],
    );
    expect(state.rows[0]).toEqual({
      anonymizedAt: null,
      reactivationTokens: 1,
      wishes: 1,
      carts: 1,
      notifications: 1,
      pushDevices: 1,
      pushOutbox: 1,
    });
  });

  it("leaves unrelated user and behavioral rows unchanged", async () => {
    const fixture = ANONYMIZATION_FIXTURE;
    const otherUserId = batchUserId(301);
    await seedAnonymizationFixture(pool);
    await pool.query(
      `INSERT INTO users ("userId", "userid", "email", "password", role)
       VALUES ($1, 'unrelated-user', 'unrelated@example.test', 'unrelated-password', 'USER')`,
      [otherUserId],
    );
    await pool.query(
      `INSERT INTO "authIdentity" ("userId", provider, "providerUserId") VALUES ($1, 'kakao', 'unrelated-kakao')`,
      [otherUserId],
    );
    await pool.query(`INSERT INTO wishes ("userId", "productId") VALUES ($1, $2)`, [
      otherUserId,
      FIXTURE.secondProductId,
    ]);
    await pool.query(`INSERT INTO carts ("userId") VALUES ($1)`, [otherUserId]);
    await pool.query(
      `INSERT INTO "emailDeliveryOutbox" (kind, email, status, "expiresAt")
       VALUES ('PASSWORD_RESET_LINK', 'unrelated@example.test', 'PENDING', now() + interval '10 minutes')`,
    );

    await foAccountRepository.anonymizeDueBatch(100);

    const state = await pool.query<{
      authIdentities: number;
      carts: number;
      email: string;
      emailOutbox: number;
      password: string;
      userid: string;
      wishes: number;
    }>(
      `SELECT userid, email, password,
        (SELECT count(*)::int FROM "authIdentity" WHERE "userId" = $1) AS "authIdentities",
        (SELECT count(*)::int FROM wishes WHERE "userId" = $1) AS wishes,
        (SELECT count(*)::int FROM carts WHERE "userId" = $1) AS carts,
        (SELECT count(*)::int FROM "emailDeliveryOutbox" WHERE email = 'unrelated@example.test') AS "emailOutbox"
       FROM users WHERE "userId" = $1`,
      [otherUserId],
    );
    expect(state.rows[0]).toEqual({
      userid: "unrelated-user",
      email: "unrelated@example.test",
      password: "unrelated-password",
      authIdentities: 1,
      wishes: 1,
      carts: 1,
      emailOutbox: 1,
    });
    expect(
      (await pool.query(`SELECT "anonymizedAt" FROM users WHERE "userId" = $1`, [fixture.userId])).rows[0],
    ).toEqual({ anonymizedAt: expect.any(Date) });
  });

  it("rolls back and retries later when email preparation owns the matching outbox lock", async () => {
    const fixture = ANONYMIZATION_FIXTURE;
    await seedAnonymizationFixture(pool);
    const emailTransaction = await pool.connect();
    await emailTransaction.query("BEGIN");
    await emailTransaction.query(`SELECT id FROM "emailDeliveryOutbox" WHERE email = $1 FOR UPDATE`, [fixture.email]);
    const firstRun = foAccountRepository.anonymizeDueBatch(1);
    let transactionOpen = true;

    try {
      const firstResult = await Promise.race([
        firstRun,
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
      ]);
      expect(firstResult).toEqual([]);
      await emailTransaction.query(`SELECT "userId" FROM users WHERE "userId" = $1 FOR KEY SHARE`, [fixture.userId]);
      const pending = await pool.query<{ anonymizedAt: Date | null; wishes: number }>(
        `SELECT "anonymizedAt", (SELECT count(*)::int FROM wishes WHERE "userId" = $1) AS wishes
         FROM users WHERE "userId" = $1`,
        [fixture.userId],
      );
      expect(pending.rows[0]).toEqual({ anonymizedAt: null, wishes: 1 });
      await emailTransaction.query("COMMIT");
      transactionOpen = false;
      await expect(foAccountRepository.anonymizeDueBatch(1)).resolves.toEqual([fixture.userId]);
    } finally {
      if (transactionOpen) await emailTransaction.query("ROLLBACK").catch(() => undefined);
      emailTransaction.release();
      await Promise.allSettled([firstRun]);
    }
  });

  it("orders a concurrent matching outbox insert before anonymization cleanup", async () => {
    const fixture = ANONYMIZATION_FIXTURE;
    await seedAnonymizationFixture(pool);
    await pool.query(
      `CREATE OR REPLACE FUNCTION block_anonymization_outbox_insert() RETURNS trigger AS $$
       BEGIN
         IF NEW.email = '${fixture.email}' THEN
           PERFORM pg_advisory_xact_lock(hashtextextended(NEW.email, 92));
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql;
       CREATE TRIGGER block_anonymization_outbox_insert_trigger
       BEFORE INSERT ON "emailDeliveryOutbox"
       FOR EACH ROW EXECUTE FUNCTION block_anonymization_outbox_insert()`,
    );
    const blocker = await startAdvisoryBlocker(pool, fixture.email, 92);
    const enqueue = emailRepository.enqueueDelivery({
      email: fixture.email,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      kind: "PASSWORD_RESET_LINK",
    });
    let blockerReleased = false;
    let firstRun: Promise<string[]> | undefined;

    try {
      await waitFor(async () => (await blockedBy(pool, blocker.pid)) === 1);
      firstRun = foAccountRepository.anonymizeDueBatch(1);
      const firstResult = await Promise.race([
        firstRun,
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
      ]);
      expect(firstResult).toEqual([]);
      await releaseBlocker(blocker.client);
      blockerReleased = true;
      await enqueue;
      await expect(foAccountRepository.anonymizeDueBatch(1)).resolves.toEqual([fixture.userId]);
      const matchingOutbox = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "emailDeliveryOutbox" WHERE email = $1`,
        [fixture.email],
      );
      expect(matchingOutbox.rows[0]?.count).toBe(0);
    } finally {
      if (!blockerReleased) await rollbackBlocker(blocker.client);
      await Promise.allSettled([enqueue, ...(firstRun ? [firstRun] : [])]);
      await pool.query(`DROP TRIGGER IF EXISTS block_anonymization_outbox_insert_trigger ON "emailDeliveryOutbox"`);
      await pool.query(`DROP FUNCTION IF EXISTS block_anonymization_outbox_insert()`);
    }
  });
});
