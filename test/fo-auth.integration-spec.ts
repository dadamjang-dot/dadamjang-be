import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { hashToken } from "src/common/security/token-hash";
import { FIXTURE } from "src/database/fixtures";
import { resetTestFixtures, testPool } from "./support/database";

const documentIds = {
  age: "a0000000-0000-4000-8000-000000000001",
  service: "a0000000-0000-4000-8000-000000000002",
  privacy: "a0000000-0000-4000-8000-000000000003",
  marketing: "a0000000-0000-4000-8000-000000000004",
} as const;

const failedSessionDeviceId = "forced-session-write-failure";

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForAdvisoryWaiters = async (pool: Pool, expected: number) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const waiting = await pool.query<{ count: string }>(
      `SELECT count(*)
       FROM pg_stat_activity
       WHERE pid <> pg_backend_pid()
         AND wait_event = 'advisory'`,
    );
    if (Number(waiting.rows[0]?.count) >= expected) return;
    await wait(10);
  }
  throw new Error(`Timed out waiting for ${expected} advisory lock waiters`);
};

const installRefreshSessionFailure = async (pool: Pool) => {
  await pool.query(`
    CREATE OR REPLACE FUNCTION reject_test_refresh_session() RETURNS trigger AS $$
    BEGIN
      IF NEW."deviceId" = '${failedSessionDeviceId}' THEN
        RAISE EXCEPTION 'forced refresh session failure';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER reject_test_refresh_session
    BEFORE INSERT OR UPDATE ON "refreshToken"
    FOR EACH ROW EXECUTE FUNCTION reject_test_refresh_session();
  `);
};

const removeRefreshSessionFailure = async (pool: Pool) => {
  await pool.query(`
    DROP TRIGGER IF EXISTS reject_test_refresh_session ON "refreshToken";
    DROP FUNCTION IF EXISTS reject_test_refresh_session();
  `);
};

const seedConsentDocuments = async (pool: Pool) => {
  await pool.query(
    `INSERT INTO "consentDocuments" ("documentId", "type", "title", "body", "version", "required", "activeFrom") VALUES
      ($1, 'AGE_OVER_14', '만 14세 이상', '테스트 승인 원문', '2026-01', true, now()),
      ($2, 'SERVICE_TERMS', '서비스 이용약관', '테스트 승인 원문', '2026-01', true, now()),
      ($3, 'PRIVACY_COLLECTION', '개인정보 수집·이용', '테스트 승인 원문', '2026-01', true, now()),
      ($4, 'MARKETING', '마케팅 정보 수신', '테스트 승인 원문', '2026-01', false, now())`,
    Object.values(documentIds),
  );
};

const seedSignupProofs = async (pool: Pool, deviceId: string) => {
  const verificationId = "b0000000-0000-4000-8000-000000000001";
  const sessionId = "c0000000-0000-4000-8000-000000000001";
  await pool.query(
    `INSERT INTO "emailVerification" ("id", "email", "purpose", "codeHash", "expiresAt", "verifiedAt")
     VALUES ($1, 'new@example.test', 'SIGNUP', 'hash', now() + interval '10 minutes', now())`,
    [verificationId],
  );
  await pool.query(
    `INSERT INTO "emailVerificationToken" ("tokenHash", "email", "purpose", "verificationId", "expiresAt")
     VALUES ($1, 'new@example.test', 'SIGNUP', $2, now() + interval '10 minutes')`,
    [hashToken("email-proof"), verificationId],
  );
  await pool.query(
    `INSERT INTO "identityVerificationSessions"
      ("sessionId", "purpose", "provider", "deviceIdHash", "merchantTransactionId", "status", "ciHash", "certificateProvider", "isFourteenOrOlder", "proofTokenHash", "expiresAt", "verifiedAt", "completedAt")
     VALUES ($1, 'SIGNUP', 'TOSS', $2, '12345678901234567890', 'VERIFIED', 'ci-new', 'TOSS', true, $3, now() + interval '10 minutes', now(), now())`,
    [sessionId, hashToken(deviceId), hashToken("identity-proof")],
  );
};

type KakaoSignupAttempt = {
  readonly deviceId: string;
  readonly signupToken: string;
  readonly identityToken: string;
  readonly emailToken: string;
  readonly email: string;
  readonly ciHash: string;
  readonly providerUserId: string;
  readonly verificationId: string;
  readonly sessionId: string;
  readonly merchantTransactionId: string;
};

const seedKakaoSignupAttempt = async (pool: Pool, attempt: KakaoSignupAttempt) => {
  await pool.query(
    `INSERT INTO "kakaoSignupToken"
      ("tokenHash", "providerUserId", "emailVerified", "deviceIdHash", "expiresAt")
     VALUES ($1, $2, false, $3, now() + interval '10 minutes')`,
    [hashToken(attempt.signupToken), attempt.providerUserId, hashToken(attempt.deviceId)],
  );
  await pool.query(
    `INSERT INTO "emailVerification" ("id", "email", "purpose", "codeHash", "expiresAt", "verifiedAt")
     VALUES ($1, $2, 'SIGNUP', 'hash', now() + interval '10 minutes', now())`,
    [attempt.verificationId, attempt.email],
  );
  await pool.query(
    `INSERT INTO "emailVerificationToken" ("tokenHash", "email", "purpose", "verificationId", "expiresAt")
     VALUES ($1, $2, 'SIGNUP', $3, now() + interval '10 minutes')`,
    [hashToken(attempt.emailToken), attempt.email, attempt.verificationId],
  );
  await pool.query(
    `INSERT INTO "identityVerificationSessions"
      ("sessionId", "purpose", "provider", "deviceIdHash", "merchantTransactionId", "status", "ciHash", "certificateProvider", "isFourteenOrOlder", "proofTokenHash", "expiresAt", "verifiedAt", "completedAt")
     VALUES ($1, 'SIGNUP', 'TOSS', $2, $3, 'VERIFIED', $4, 'TOSS', true, $5, now() + interval '10 minutes', now(), now())`,
    [
      attempt.sessionId,
      hashToken(attempt.deviceId),
      attempt.merchantTransactionId,
      attempt.ciHash,
      hashToken(attempt.identityToken),
    ],
  );
};

const completeKakaoSignup = (app: INestApplication, attempt: KakaoSignupAttempt) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("x-device-id", attempt.deviceId)
    .send({
      query: `mutation CompleteKakaoSignupFo($input: CompleteKakaoSignupFoInput!) {
        completeKakaoSignupFo(input: $input) { accessToken role }
      }`,
      variables: {
        input: {
          kakaoSignupToken: attempt.signupToken,
          email: attempt.email,
          emailVerificationToken: attempt.emailToken,
          identityVerificationToken: attempt.identityToken,
          consents: Object.values(documentIds).map((documentId) => ({
            documentId,
            agreed: documentId !== documentIds.marketing,
          })),
        },
      },
    });

describe("FO auth GraphQL integration", () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    pool = testPool();
    app = await createApp();
    await app.listen(0, "127.0.0.1");
  });

  beforeEach(async () => {
    await resetTestFixtures(pool);
    await seedConsentDocuments(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("does not expose legacy signup mutations that bypass FO proofs", async () => {
    const response = await request(app.getHttpServer()).post("/graphql").send({
      query: `query MutationFields { __schema { mutationType { fields { name } } } }`,
    });
    const fieldNames = response.body.data.__schema.mutationType.fields.map((field: { name: string }) => field.name);
    expect(fieldNames).not.toEqual(expect.arrayContaining(["signup", "completeKakaoSignup"]));
  });

  it("signs in a FO user with a normalized email and hides credential details", async () => {
    const success = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", "fo-signin-device")
      .send({
        query: `mutation SigninFo($input: SigninFoInput!) { signinFo(input: $input) { accessToken role } }`,
        variables: { input: { email: " INTEGRATION@EXAMPLE.TEST ", password: "IntegrationPassword123!" } },
      });
    expect(success.body.errors).toBeUndefined();
    expect(success.body.data.signinFo.role).toBe("USER");

    const rejected = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", "fo-signin-device")
      .send({
        query: `mutation SigninFo($input: SigninFoInput!) { signinFo(input: $input) { role } }`,
        variables: { input: { email: "missing@example.test", password: "wrong-password" } },
      });
    expect(rejected.body.errors[0].message).toBe("이메일 또는 비밀번호가 올바르지 않습니다.");
  });

  it("allows only one overlapping sign-in to claim the same device session", async () => {
    const signin = () =>
      request(app.getHttpServer())
        .post("/graphql")
        .set("x-device-id", "fo-concurrent-signin-device")
        .send({
          query: `mutation SigninFo($input: SigninFoInput!) { signinFo(input: $input) { refreshToken } }`,
          variables: { input: { email: "integration@example.test", password: "IntegrationPassword123!" } },
        });

    const responses = await Promise.all(Array.from({ length: 16 }, signin));
    const succeeded = responses.filter(({ body }) => body.errors === undefined);
    const rejected = responses.filter(({ body }) => body.errors !== undefined);

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(15);
    expect(new Set(rejected.map(({ body }) => body.errors[0].extensions.code))).toEqual(new Set(["CONFLICT"]));
  });

  it("returns active versioned signup consent documents", async () => {
    await pool.query(
      `INSERT INTO "consentDocuments" ("type", "title", "body", "version", "required", "activeFrom")
       VALUES ('SERVICE_TERMS', '이전 서비스 이용약관', '테스트 이전 원문', '2025-01', true, now() - interval '1 year')`,
    );
    const response = await request(app.getHttpServer()).post("/graphql").send({
      query: `query ActiveSignupConsentDocuments { activeSignupConsentDocuments { documentId type version required } }`,
    });
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.activeSignupConsentDocuments).toHaveLength(4);
    expect(
      response.body.data.activeSignupConsentDocuments.find(
        (document: { type: string }) => document.type === "SERVICE_TERMS",
      ).version,
    ).toBe("2026-01");
  });

  it("creates an email FO account after email, identity, and required consent proofs", async () => {
    const deviceId = "fo-signup-device";
    await seedSignupProofs(pool, deviceId);
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({
        query: `mutation SignupFo($input: SignupFoInput!) { signupFo(input: $input) { accessToken role } }`,
        variables: {
          input: {
            email: "NEW@example.test",
            password: "Password123!",
            emailVerificationToken: "email-proof",
            identityVerificationToken: "identity-proof",
            consents: Object.values(documentIds).map((documentId) => ({
              documentId,
              agreed: documentId !== documentIds.marketing,
            })),
          },
        },
      });
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.signupFo.role).toBe("USER");
    const created = await pool.query<{ userid: string; email: string }>(
      `SELECT "userid", "email" FROM "users" WHERE "email" = 'new@example.test'`,
    );
    expect(created.rows[0]?.userid).toMatch(/^member-[a-f0-9]{12}$/);
    expect(created.rows[0]?.email).toBe("new@example.test");
  });

  it("rolls back FO account proofs when refresh-session persistence fails", async () => {
    await seedSignupProofs(pool, failedSessionDeviceId);
    const signup = () =>
      request(app.getHttpServer())
        .post("/graphql")
        .set("x-device-id", failedSessionDeviceId)
        .send({
          query: `mutation SignupFo($input: SignupFoInput!) { signupFo(input: $input) { accessToken role } }`,
          variables: {
            input: {
              email: "new@example.test",
              password: "Password123!",
              emailVerificationToken: "email-proof",
              identityVerificationToken: "identity-proof",
              consents: Object.values(documentIds).map((documentId) => ({
                documentId,
                agreed: documentId !== documentIds.marketing,
              })),
            },
          },
        });

    await installRefreshSessionFailure(pool);
    try {
      const failed = await signup();
      expect(failed.body.errors).toHaveLength(1);
      const state = await pool.query<{ users: number; emailUsedAt: Date | null; identityConsumedAt: Date | null }>(
        `SELECT
          (SELECT count(*)::int FROM "users" WHERE "email" = 'new@example.test') AS "users",
          (SELECT "usedAt" FROM "emailVerificationToken" WHERE "tokenHash" = $1) AS "emailUsedAt",
          (SELECT "consumedAt" FROM "identityVerificationSessions" WHERE "proofTokenHash" = $2) AS "identityConsumedAt"`,
        [hashToken("email-proof"), hashToken("identity-proof")],
      );
      expect(state.rows[0]).toEqual({ users: 0, emailUsedAt: null, identityConsumedAt: null });
    } finally {
      await removeRefreshSessionFailure(pool);
    }

    const retried = await signup();
    expect(retried.body.errors).toBeUndefined();
    expect(retried.body.data.signupFo.role).toBe("USER");
  });

  it("starts a Kakao login with an opaque flow and consumes an existing-user flow once", async () => {
    const deviceId = "kakao-existing-device";
    const flowId = "d0000000-0000-4000-8000-000000000001";
    const callbackToken = "kakao-existing-callback";
    const started = await request(app.getHttpServer()).post("/graphql").set("x-device-id", deviceId).send({
      query: `mutation StartKakaoLogin { startKakaoLogin { flowId authUrl expiresAt } }`,
    });
    expect(started.body.errors).toBeUndefined();
    expect(started.body.data.startKakaoLogin.authUrl).toContain(
      `/api/auth/kakao?flowId=${started.body.data.startKakaoLogin.flowId}`,
    );
    expect(started.body.data.startKakaoLogin).not.toHaveProperty("accessToken");

    await pool.query(
      `INSERT INTO "authIdentity" ("userId", "provider", "providerUserId")
       VALUES ($1, 'kakao', 'kakao-existing')`,
      [FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "kakaoLoginFlows"
        ("flowId", "deviceIdHash", "providerUserId", "email", "emailVerified", "userId", "status", "callbackTokenHash", "expiresAt", "callbackAt")
       VALUES ($1, $2, 'kakao-existing', 'integration@example.test', true, $3, 'EXISTING_USER', $4, now() + interval '10 minutes', now())`,
      [flowId, hashToken(deviceId), FIXTURE.userId, hashToken(callbackToken)],
    );
    const mutation = `mutation CompleteKakaoLogin($input: CompleteKakaoLoginInput!) {
      completeKakaoLogin(input: $input) {
        status
        tokenPayload { accessToken refreshToken role }
        kakaoSignupToken
        emailVerificationRequired
      }
    }`;
    const complete = () =>
      request(app.getHttpServer())
        .post("/graphql")
        .set("x-device-id", deviceId)
        .send({ query: mutation, variables: { input: { flowId, callbackToken } } });
    const responses = await Promise.all([complete(), complete()]);
    const completed = responses.find(({ body }) => body.errors === undefined);
    const rejected = responses.find(({ body }) => body.errors !== undefined);

    expect(completed?.body.data.completeKakaoLogin).toMatchObject({
      status: "SIGNED_IN",
      kakaoSignupToken: null,
      emailVerificationRequired: false,
      tokenPayload: { role: "USER" },
    });
    expect(rejected?.body.errors[0].message).toBe("카카오 로그인 흐름이 유효하지 않습니다.");
  });

  it("converges repeated anonymous starts onto one current row per device and purpose", async () => {
    const kakaoStart = () =>
      request(app.getHttpServer()).post("/graphql").set("x-device-id", "bounded-kakao-device").send({
        query: `mutation { startKakaoLogin { flowId } }`,
      });
    const identityStart = () =>
      request(app.getHttpServer())
        .post("/graphql")
        .set("x-device-id", "bounded-identity-device")
        .send({
          query: `mutation Start($input: StartIdentityVerificationInput!) {
          startIdentityVerification(input: $input) { sessionId }
        }`,
          variables: { input: { purpose: "SIGNUP", provider: "KAKAO" } },
        });

    const [firstKakao, secondKakao, firstIdentity, secondIdentity] = await Promise.all([
      kakaoStart(),
      kakaoStart(),
      identityStart(),
      identityStart(),
    ]);

    expect(secondKakao.body.data.startKakaoLogin.flowId).toBe(firstKakao.body.data.startKakaoLogin.flowId);
    expect(secondIdentity.body.data.startIdentityVerification.sessionId).toBe(
      firstIdentity.body.data.startIdentityVerification.sessionId,
    );
    const rows = await pool.query<{ identity: number; kakao: number }>(
      `SELECT
        (SELECT count(*)::int FROM "kakaoLoginFlows" WHERE "deviceIdHash" = $1) AS kakao,
        (SELECT count(*)::int FROM "identityVerificationSessions" WHERE "deviceIdHash" = $2) AS identity`,
      [hashToken("bounded-kakao-device"), hashToken("bounded-identity-device")],
    );
    expect(rows.rows[0]).toEqual({ identity: 1, kakao: 1 });
  });

  it("deletes at most 100 expired or consumed anonymous start rows before insertion", async () => {
    await pool.query(
      `INSERT INTO "kakaoLoginFlows" ("deviceIdHash", "expiresAt", "consumedAt")
       SELECT 'retired-kakao-' || value,
         CASE WHEN value <= 51 THEN now() - interval '1 minute' ELSE now() + interval '10 minutes' END,
         CASE WHEN value > 51 THEN now() ELSE NULL END
       FROM generate_series(1, 102) AS value`,
    );
    await pool.query(
      `INSERT INTO "identityVerificationSessions"
        ("purpose", "provider", "deviceIdHash", "merchantTransactionId", "expiresAt", "consumedAt")
       SELECT 'SIGNUP', 'KAKAO', 'retired-identity-' || value, 'cleanup-' || lpad(value::text, 3, '0'),
         CASE WHEN value <= 51 THEN now() - interval '1 minute' ELSE now() + interval '10 minutes' END,
         CASE WHEN value > 51 THEN now() ELSE NULL END
       FROM generate_series(1, 102) AS value`,
    );

    const kakao = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", "cleanup-kakao-device")
      .send({ query: `mutation { startKakaoLogin { flowId } }` });
    const identity = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", "cleanup-identity-device")
      .send({
        query: `mutation Start($input: StartIdentityVerificationInput!) {
          startIdentityVerification(input: $input) { sessionId }
        }`,
        variables: { input: { purpose: "SIGNUP", provider: "KAKAO" } },
      });

    expect(kakao.body.errors).toBeUndefined();
    expect(identity.body.errors).toBeUndefined();
    const rows = await pool.query<{ identity: number; kakao: number }>(
      `SELECT
        (SELECT count(*)::int FROM "kakaoLoginFlows"
          WHERE "expiresAt" <= now() OR "consumedAt" IS NOT NULL) AS kakao,
        (SELECT count(*)::int FROM "identityVerificationSessions"
          WHERE "expiresAt" <= now() OR "consumedAt" IS NOT NULL) AS identity`,
    );
    expect(rows.rows[0]).toEqual({ identity: 2, kakao: 2 });
  });

  it.each([
    {
      name: "Kakao",
      table: "kakaoLoginFlows",
      trigger: "delay_test_kakao_cleanup",
      function: "delay_test_kakao_cleanup",
      lockKey: 91003,
      seed: `INSERT INTO "kakaoLoginFlows" ("deviceIdHash", "expiresAt")
        SELECT CASE WHEN value = 1 THEN 'cleanup-blocker' ELSE 'concurrent-kakao-' || value END,
          now() - interval '1 day' + value * interval '1 second'
        FROM generate_series(1, 201) AS value`,
      start: (app: INestApplication, deviceId: string) =>
        request(app.getHttpServer())
          .post("/graphql")
          .set("x-device-id", deviceId)
          .send({ query: `mutation { startKakaoLogin { flowId } }` })
          .then((response) => response),
    },
    {
      name: "identity",
      table: "identityVerificationSessions",
      trigger: "delay_test_identity_cleanup",
      function: "delay_test_identity_cleanup",
      lockKey: 91004,
      seed: `INSERT INTO "identityVerificationSessions"
          ("purpose", "provider", "deviceIdHash", "merchantTransactionId", "expiresAt")
        SELECT 'SIGNUP', 'KAKAO',
          CASE WHEN value = 1 THEN 'cleanup-blocker' ELSE 'concurrent-identity-' || value END,
          'cc' || lpad(value::text, 18, '0'),
          now() - interval '1 day' + value * interval '1 second'
        FROM generate_series(1, 201) AS value`,
      start: (app: INestApplication, deviceId: string) =>
        request(app.getHttpServer())
          .post("/graphql")
          .set("x-device-id", deviceId)
          .send({
            query: `mutation Start($input: StartIdentityVerificationInput!) {
              startIdentityVerification(input: $input) { sessionId }
            }`,
            variables: { input: { purpose: "SIGNUP", provider: "KAKAO" } },
          })
          .then((response) => response),
    },
  ])("lets a concurrent $name cleaner skip a locked 100-row batch", async (cleanup) => {
    await pool.query(cleanup.seed);
    const blocker = await pool.connect();
    const requests: Promise<request.Response>[] = [];
    let released = false;
    try {
      await pool.query(`
        CREATE FUNCTION ${cleanup.function}() RETURNS trigger AS $$
        BEGIN
          IF OLD."deviceIdHash" = 'cleanup-blocker' THEN
            PERFORM pg_advisory_xact_lock(${cleanup.lockKey}, 1);
          END IF;
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER ${cleanup.trigger}
        BEFORE DELETE ON "${cleanup.table}"
        FOR EACH ROW EXECUTE FUNCTION ${cleanup.function}();
      `);
      await blocker.query(`SELECT pg_advisory_lock(${cleanup.lockKey}, 1)`);
      const first = cleanup.start(app, `${cleanup.name}-cleaner-first`);
      requests.push(first);
      await waitForAdvisoryWaiters(pool, 1);
      const second = cleanup.start(app, `${cleanup.name}-cleaner-second`);
      requests.push(second);
      const secondOutcome = await Promise.race([
        second.then(() => "completed" as const),
        wait(1_000).then(() => "blocked" as const),
      ]);
      expect(secondOutcome).toBe("completed");
      await blocker.query(`SELECT pg_advisory_unlock(${cleanup.lockKey}, 1)`);
      released = true;
      const responses = await Promise.all(requests);
      expect(responses.every((response) => response.body.errors === undefined)).toBe(true);
      const retired = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM "${cleanup.table}"
         WHERE "expiresAt" <= now() OR "consumedAt" IS NOT NULL`,
      );
      expect(retired.rows[0]?.count).toBe(1);
    } finally {
      if (!released) await blocker.query(`SELECT pg_advisory_unlock(${cleanup.lockKey}, 1)`).catch(() => undefined);
      await Promise.allSettled(requests);
      blocker.release();
      await pool.query(`
        DROP TRIGGER IF EXISTS ${cleanup.trigger} ON "${cleanup.table}";
        DROP FUNCTION IF EXISTS ${cleanup.function}();
      `);
    }
  });

  it("allows only one active Kakao flow per device session", async () => {
    const deviceId = "kakao-concurrent-flow-device";
    const flowIds = ["d0000000-0000-4000-8000-000000000003", "d0000000-0000-4000-8000-000000000004"];
    await pool.query(
      `INSERT INTO "authIdentity" ("userId", "provider", "providerUserId")
       VALUES ($1, 'kakao', 'kakao-concurrent')`,
      [FIXTURE.userId],
    );
    for (const flowId of flowIds) {
      const callbackToken = `${flowId}-callback`;
      await pool.query(
        `INSERT INTO "kakaoLoginFlows"
          ("flowId", "deviceIdHash", "providerUserId", "email", "emailVerified", "userId", "status", "callbackTokenHash", "expiresAt", "callbackAt")
         VALUES ($1, $2, 'kakao-concurrent', 'integration@example.test', true, $3, 'EXISTING_USER', $4, now() + interval '10 minutes', now())`,
        [flowId, hashToken(deviceId), FIXTURE.userId, hashToken(callbackToken)],
      );
    }
    const complete = (flowId: string) =>
      request(app.getHttpServer())
        .post("/graphql")
        .set("x-device-id", deviceId)
        .send({
          query: `mutation CompleteKakaoLogin($input: CompleteKakaoLoginInput!) {
            completeKakaoLogin(input: $input) { status tokenPayload { refreshToken } }
          }`,
          variables: { input: { flowId, callbackToken: `${flowId}-callback` } },
        });

    const responses = await Promise.all(flowIds.map(complete));
    const completed = responses.filter(({ body }) => body.errors === undefined);
    const rejected = responses.filter(({ body }) => body.errors !== undefined);
    expect(completed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const refreshToken = completed[0]?.body.data.completeKakaoLogin.tokenPayload.refreshToken as string;
    const refreshed = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", `Bearer ${refreshToken}`)
      .send({ query: `mutation Refresh { refresh { refreshToken } }` });
    expect(refreshed.body.errors).toBeUndefined();
  });

  it("rolls back Kakao flow consumption when refresh-session persistence fails", async () => {
    const flowId = "d0000000-0000-4000-8000-000000000005";
    const callbackToken = "kakao-session-failure-callback";
    await pool.query(
      `INSERT INTO "authIdentity" ("userId", "provider", "providerUserId")
       VALUES ($1, 'kakao', 'kakao-session-failure')`,
      [FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "kakaoLoginFlows"
        ("flowId", "deviceIdHash", "providerUserId", "email", "emailVerified", "userId", "status", "callbackTokenHash", "expiresAt", "callbackAt")
       VALUES ($1, $2, 'kakao-session-failure', 'integration@example.test', true, $3, 'EXISTING_USER', $4, now() + interval '10 minutes', now())`,
      [flowId, hashToken(failedSessionDeviceId), FIXTURE.userId, hashToken(callbackToken)],
    );
    const complete = () =>
      request(app.getHttpServer())
        .post("/graphql")
        .set("x-device-id", failedSessionDeviceId)
        .send({
          query: `mutation CompleteKakaoLogin($input: CompleteKakaoLoginInput!) {
            completeKakaoLogin(input: $input) { status tokenPayload { accessToken } }
          }`,
          variables: { input: { flowId, callbackToken } },
        });

    await installRefreshSessionFailure(pool);
    try {
      const failed = await complete();
      expect(failed.body.errors).toHaveLength(1);
      const flow = await pool.query<{ consumedAt: Date | null }>(
        `SELECT "consumedAt" FROM "kakaoLoginFlows" WHERE "flowId" = $1`,
        [flowId],
      );
      expect(flow.rows[0]?.consumedAt).toBeNull();
    } finally {
      await removeRefreshSessionFailure(pool);
    }

    const retried = await complete();
    expect(retried.body.errors).toBeUndefined();
    expect(retried.body.data.completeKakaoLogin.status).toBe("SIGNED_IN");
  });

  it("atomically binds a Kakao signup callback to token, device, status, expiry, and one-time use", async () => {
    const flowId = "d0000000-0000-4000-8000-000000000002";
    const deviceId = "kakao-signup-device";
    const callbackToken = "kakao-signup-callback";
    await pool.query(
      `INSERT INTO "kakaoLoginFlows"
        ("flowId", "deviceIdHash", "providerUserId", "status", "callbackTokenHash", "expiresAt", "callbackAt")
       VALUES ($1, $2, 'kakao-new', 'SIGNUP_REQUIRED', $3, now() + interval '10 minutes', now())`,
      [flowId, hashToken(deviceId), hashToken(callbackToken)],
    );
    const mutation = `mutation CompleteKakaoLogin($input: CompleteKakaoLoginInput!) {
      completeKakaoLogin(input: $input) {
        status
        kakaoSignupToken
        email
        emailVerificationRequired
      }
    }`;
    const wrongToken = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({ query: mutation, variables: { input: { flowId, callbackToken: "wrong-callback" } } });
    expect(wrongToken.body.errors[0].message).toBe("카카오 로그인 흐름이 유효하지 않습니다.");

    const wrongDevice = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", "another-device")
      .send({ query: mutation, variables: { input: { flowId, callbackToken } } });
    expect(wrongDevice.body.errors[0].message).toBe("카카오 로그인 흐름이 유효하지 않습니다.");

    await pool.query(`UPDATE "kakaoLoginFlows" SET "expiresAt" = now() - interval '1 second' WHERE "flowId" = $1`, [
      flowId,
    ]);
    const expired = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({ query: mutation, variables: { input: { flowId, callbackToken } } });
    expect(expired.body.errors[0].message).toBe("카카오 로그인 흐름이 유효하지 않습니다.");

    await pool.query(
      `UPDATE "kakaoLoginFlows" SET "expiresAt" = now() + interval '10 minutes', "status" = 'PENDING' WHERE "flowId" = $1`,
      [flowId],
    );
    const pending = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({ query: mutation, variables: { input: { flowId, callbackToken } } });
    expect(pending.body.errors[0].message).toBe("카카오 로그인 흐름이 유효하지 않습니다.");

    await pool.query(
      `UPDATE "kakaoLoginFlows" SET "status" = 'SIGNUP_REQUIRED', "consumedAt" = now() WHERE "flowId" = $1`,
      [flowId],
    );
    const consumed = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({ query: mutation, variables: { input: { flowId, callbackToken } } });
    expect(consumed.body.errors[0].message).toBe("카카오 로그인 흐름이 유효하지 않습니다.");
    await pool.query(`UPDATE "kakaoLoginFlows" SET "consumedAt" = NULL WHERE "flowId" = $1`, [flowId]);

    const completed = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({ query: mutation, variables: { input: { flowId, callbackToken } } });
    expect(completed.body.errors).toBeUndefined();
    expect(completed.body.data.completeKakaoLogin).toEqual({
      status: "SIGNUP_REQUIRED",
      kakaoSignupToken: expect.any(String),
      email: null,
      emailVerificationRequired: true,
    });
    const replayed = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({ query: mutation, variables: { input: { flowId, callbackToken } } });
    expect(replayed.body.errors[0].message).toBe("카카오 로그인 흐름이 유효하지 않습니다.");
  });

  it("links a new Kakao identity to the existing FO account with the same CI", async () => {
    const deviceId = "kakao-ci-link-device";
    const identitySessionId = "c0000000-0000-4000-8000-000000000009";
    await pool.query(
      `INSERT INTO "verifiedIdentities" ("userId", "ciHash", "certificateProvider", "verifiedAt")
       VALUES ($1, 'existing-ci', 'KAKAO', now())`,
      [FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "identityVerificationSessions"
        ("sessionId", "purpose", "provider", "deviceIdHash", "merchantTransactionId", "status", "ciHash", "certificateProvider", "isFourteenOrOlder", "proofTokenHash", "expiresAt", "verifiedAt", "completedAt")
       VALUES ($1, 'SIGNUP', 'KAKAO', $2, '92345678901234567890', 'VERIFIED', 'existing-ci', 'KAKAO', true, $3, now() + interval '10 minutes', now(), now())`,
      [identitySessionId, hashToken(deviceId), hashToken("kakao-identity-proof")],
    );
    await pool.query(
      `INSERT INTO "kakaoSignupToken"
        ("tokenHash", "providerUserId", "email", "emailVerified", "deviceIdHash", "expiresAt")
       VALUES ($1, 'kakao-ci-link', 'integration@example.test', true, $2, now() + interval '10 minutes')`,
      [hashToken("kakao-signup-proof"), hashToken(deviceId)],
    );

    const complete = () =>
      request(app.getHttpServer())
        .post("/graphql")
        .set("x-device-id", deviceId)
        .send({
          query: `mutation CompleteKakaoSignupFo($input: CompleteKakaoSignupFoInput!) {
          completeKakaoSignupFo(input: $input) { accessToken role }
        }`,
          variables: {
            input: {
              kakaoSignupToken: "kakao-signup-proof",
              identityVerificationToken: "kakao-identity-proof",
              consents: Object.values(documentIds).map((documentId) => ({
                documentId,
                agreed: documentId !== documentIds.marketing,
              })),
            },
          },
        });
    const responses = await Promise.all([complete(), complete()]);
    const completed = responses.find(({ body }) => body.errors === undefined);
    const rejected = responses.find(({ body }) => body.errors !== undefined);

    expect(completed?.body.data.completeKakaoSignupFo.role).toBe("USER");
    expect(rejected?.body.errors[0].message).toBe("카카오 가입 인증이 유효하지 않습니다.");
    const linked = await pool.query<{ userId: string }>(
      `SELECT "userId" FROM "authIdentity" WHERE "provider" = 'kakao' AND "providerUserId" = 'kakao-ci-link'`,
    );
    expect(linked.rows[0]?.userId).toBe(FIXTURE.userId);
    const users = await pool.query(`SELECT 1 FROM "users"`);
    expect(users.rowCount).toBe(1);
  });

  it("allows only one account to claim a Kakao identity across devices", async () => {
    const attempts = [
      {
        deviceId: "kakao-provider-race-a",
        signupToken: "kakao-provider-token-a",
        identityToken: "kakao-provider-identity-a",
        emailToken: "kakao-provider-email-a",
        email: "kakao-provider-a@example.test",
        ciHash: "kakao-provider-ci-a",
        providerUserId: "kakao-shared-provider",
        verificationId: "b2000000-0000-4000-8000-000000000001",
        sessionId: "c2000000-0000-4000-8000-000000000001",
        merchantTransactionId: "77654321098765432101",
      },
      {
        deviceId: "kakao-provider-race-b",
        signupToken: "kakao-provider-token-b",
        identityToken: "kakao-provider-identity-b",
        emailToken: "kakao-provider-email-b",
        email: "kakao-provider-b@example.test",
        ciHash: "kakao-provider-ci-b",
        providerUserId: "kakao-shared-provider",
        verificationId: "b2000000-0000-4000-8000-000000000002",
        sessionId: "c2000000-0000-4000-8000-000000000002",
        merchantTransactionId: "77654321098765432102",
      },
    ] as const;
    await Promise.all(attempts.map((attempt) => seedKakaoSignupAttempt(pool, attempt)));

    const responses = await Promise.all(attempts.map((attempt) => completeKakaoSignup(app, attempt)));
    expect(responses.filter(({ body }) => body.errors === undefined)).toHaveLength(1);
    expect(responses.filter(({ body }) => body.errors !== undefined)).toHaveLength(1);
    const state = await pool.query<{ users: number; identities: number; links: number; sessions: number }>(
      `SELECT
        (SELECT count(*)::int FROM "users" WHERE "email" LIKE 'kakao-provider-%@example.test') AS users,
        (SELECT count(*)::int FROM "verifiedIdentities" WHERE "ciHash" LIKE 'kakao-provider-ci-%') AS identities,
        (SELECT count(*)::int FROM "authIdentity" WHERE "providerUserId" = 'kakao-shared-provider') AS links,
        (SELECT count(*)::int FROM "refreshToken" WHERE "deviceId" LIKE 'kakao-provider-race-%') AS sessions`,
    );
    expect(state.rows[0]).toEqual({ users: 1, identities: 1, links: 1, sessions: 1 });
  });

  it("converges concurrent Kakao signups with the same CI on one account", async () => {
    const attempts = [
      {
        deviceId: "kakao-ci-race-a",
        signupToken: "kakao-ci-token-a",
        identityToken: "kakao-ci-identity-a",
        emailToken: "kakao-ci-email-a",
        email: "kakao-ci-a@example.test",
        ciHash: "kakao-shared-ci",
        providerUserId: "kakao-ci-provider-a",
        verificationId: "b3000000-0000-4000-8000-000000000001",
        sessionId: "c3000000-0000-4000-8000-000000000001",
        merchantTransactionId: "88654321098765432101",
      },
      {
        deviceId: "kakao-ci-race-b",
        signupToken: "kakao-ci-token-b",
        identityToken: "kakao-ci-identity-b",
        emailToken: "kakao-ci-email-b",
        email: "kakao-ci-b@example.test",
        ciHash: "kakao-shared-ci",
        providerUserId: "kakao-ci-provider-b",
        verificationId: "b3000000-0000-4000-8000-000000000002",
        sessionId: "c3000000-0000-4000-8000-000000000002",
        merchantTransactionId: "88654321098765432102",
      },
    ] as const;
    await Promise.all(attempts.map((attempt) => seedKakaoSignupAttempt(pool, attempt)));

    const responses = await Promise.all(attempts.map((attempt) => completeKakaoSignup(app, attempt)));

    expect(responses.filter(({ body }) => body.errors === undefined)).toHaveLength(2);
    const state = await pool.query<{ users: number; identities: number; links: number; sessions: number }>(
      `SELECT
        (SELECT count(*)::int FROM "users" WHERE "email" LIKE 'kakao-ci-%@example.test') AS users,
        (SELECT count(*)::int FROM "verifiedIdentities" WHERE "ciHash" = 'kakao-shared-ci') AS identities,
        (SELECT count(*)::int FROM "authIdentity" WHERE "providerUserId" LIKE 'kakao-ci-provider-%') AS links,
        (SELECT count(*)::int FROM "refreshToken" WHERE "deviceId" LIKE 'kakao-ci-race-%') AS sessions`,
    );
    expect(state.rows[0]).toEqual({ users: 1, identities: 1, links: 2, sessions: 2 });
  });

  it("rejects signup when the verified identity is under fourteen", async () => {
    const deviceId = "under-fourteen-device";
    await seedSignupProofs(pool, deviceId);
    await pool.query(
      `UPDATE "identityVerificationSessions" SET "isFourteenOrOlder" = false
       WHERE "deviceIdHash" = $1`,
      [hashToken(deviceId)],
    );
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({
        query: `mutation SignupFo($input: SignupFoInput!) { signupFo(input: $input) { role } }`,
        variables: {
          input: {
            email: "new@example.test",
            password: "Password123!",
            emailVerificationToken: "email-proof",
            identityVerificationToken: "identity-proof",
            consents: Object.values(documentIds).map((documentId) => ({ documentId, agreed: true })),
          },
        },
      });
    expect(response.body.errors[0].message).toBe("가입 인증이 유효하지 않습니다.");
  });
});
