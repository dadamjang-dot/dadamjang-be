import type { INestApplication } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { hashToken } from "src/common/security/token-hash";
import { FIXTURE } from "src/database/fixtures";
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

jest.setTimeout(30_000);

describe("FO account lifecycle", () => {
  let app: INestApplication;
  let pool: Pool;
  let kakaoFlowRepository: KakaoFlowRepository;

  beforeAll(async () => {
    pool = testPool();
    app = await createApp();
    await app.listen(0, "127.0.0.1");
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
    expect(cookieValue(recovered, "access_token")).toBe(recovered.body.data.reactivateFoAccount.accessToken);
    expect(cookieValue(recovered, "refresh_token")).toBe(recovered.body.data.reactivateFoAccount.refreshToken);
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
      expect(cookieValue(winner, "access_token")).toBe(winner.body.data.reactivateFoAccount.accessToken);
      expect(cookieValue(winner, "refresh_token")).toBe(winner.body.data.reactivateFoAccount.refreshToken);
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
        refreshToken: hashToken(winner.body.data.reactivateFoAccount.refreshToken),
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
});
