import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { hashToken } from "src/common/security/token-hash";
import { FIXTURE } from "src/database/fixtures";
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

const consentDocumentIds = [
  "a0000000-0000-4000-8000-000000000011",
  "a0000000-0000-4000-8000-000000000012",
  "a0000000-0000-4000-8000-000000000013",
  "a0000000-0000-4000-8000-000000000014",
] as const;

describe("FO account lifecycle", () => {
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
    expect(cookies(recovered)).toEqual(
      expect.arrayContaining([expect.stringContaining("access_token="), expect.stringContaining("refresh_token=")]),
    );
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

  it("serializes checkout with deactivation so exactly one API operation commits", async () => {
    const deviceId = "checkout-deactivation-device";
    const signedIn = await signin(app, deviceId);
    const accessToken = signedIn.body.data.signin.accessToken as string;
    await addCartItem(app, accessToken);

    const [checkoutResponse, deactivationResponse] = await Promise.all([
      checkout(app, accessToken, "checkout-deactivation-race"),
      deactivate(app, accessToken, deviceId),
    ]);
    const successes = [
      checkoutResponse.body.data?.checkoutCart,
      deactivationResponse.body.data?.deactivateFoAccount,
    ].filter(Boolean);

    expect(successes).toHaveLength(1);
    if (checkoutResponse.body.data?.checkoutCart)
      expect(deactivationResponse.body.errors[0].extensions.code).toBe("CONFLICT");
    else expect(checkoutResponse.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
    const state = await pool.query<{ deactivated: boolean; orders: number; sessions: number }>(
      `SELECT "deactivatedAt" IS NOT NULL AS deactivated,
        (SELECT count(*)::int FROM "orders" WHERE "userId" = $1) AS orders,
        (SELECT count(*)::int FROM "refreshToken" WHERE "userId" = $1) AS sessions
       FROM "users" WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    expect(state.rows[0]?.deactivated === true || state.rows[0]?.orders === 1).toBe(true);
    expect(state.rows[0]?.deactivated && state.rows[0]?.orders === 1).toBe(false);
    if (state.rows[0]?.deactivated) expect(state.rows[0]?.sessions).toBe(0);
  });

  it("leaves no refresh session when generic, FO, Kakao, and refresh issuance race deactivation", async () => {
    const ownerDevice = "lifecycle-race-owner";
    const genericDevice = "lifecycle-race-generic";
    const foDevice = "lifecycle-race-fo";
    const kakaoDevice = "lifecycle-race-kakao";
    const flowId = "d0000000-0000-4000-8000-000000000031";
    const callbackToken = "lifecycle-race-callback";
    const signedIn = await signin(app, ownerDevice);
    await pool.query(
      `INSERT INTO "authIdentity" ("userId", "provider", "providerUserId") VALUES ($1, 'kakao', 'lifecycle-race')`,
      [FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "kakaoLoginFlows"
        ("flowId", "deviceIdHash", "providerUserId", "email", "emailVerified", "userId", "status", "callbackTokenHash", "expiresAt", "callbackAt")
       VALUES ($1, $2, 'lifecycle-race', 'integration@example.test', true, $3, 'EXISTING_USER', $4, now() + interval '10 minutes', now())`,
      [flowId, hashToken(kakaoDevice), FIXTURE.userId, hashToken(callbackToken)],
    );
    const kakao = request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", kakaoDevice)
      .send({
        query: `mutation Complete($input: CompleteKakaoLoginInput!) {
          completeKakaoLogin(input: $input) { status tokenPayload { refreshToken } reactivationToken }
        }`,
        variables: { input: { flowId, callbackToken } },
      });

    const responses = await Promise.all([
      signin(app, genericDevice),
      signinFo(app, foDevice),
      kakao,
      refresh(app, signedIn.body.data.signin.refreshToken),
      deactivate(app, signedIn.body.data.signin.accessToken, ownerDevice),
    ]);

    expect(responses[4]?.body.errors).toBeUndefined();
    const state = await pool.query<{ deactivated: boolean; sessions: number }>(
      `SELECT "deactivatedAt" IS NOT NULL AS deactivated,
        (SELECT count(*)::int FROM "refreshToken" WHERE "userId" = $1) AS sessions
       FROM "users" WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    expect(state.rows[0]).toEqual({ deactivated: true, sessions: 0 });
  });

  it("leaves no refresh session when linked Kakao signup completion races deactivation", async () => {
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
    const completeSignup = request(app.getHttpServer())
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
      });

    const [, deactivationResponse] = await Promise.all([
      completeSignup,
      deactivate(app, signedIn.body.data.signin.accessToken, ownerDevice),
    ]);

    expect(deactivationResponse.body.errors).toBeUndefined();
    const state = await pool.query<{ deactivated: boolean; sessions: number }>(
      `SELECT "deactivatedAt" IS NOT NULL AS deactivated,
        (SELECT count(*)::int FROM "refreshToken" WHERE "userId" = $1) AS sessions
       FROM "users" WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    expect(state.rows[0]).toEqual({ deactivated: true, sessions: 0 });
  });
});
