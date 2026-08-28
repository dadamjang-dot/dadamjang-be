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

describe("FO auth GraphQL integration", () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    pool = testPool();
    app = await createApp();
    await app.init();
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

  it("rotates a refresh token exactly once under concurrent requests", async () => {
    const deviceId = "fo-refresh-device";
    const signedIn = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({
        query: `mutation SigninFo($input: SigninFoInput!) { signinFo(input: $input) { refreshToken } }`,
        variables: { input: { email: "integration@example.test", password: "IntegrationPassword123!" } },
      });
    const refreshToken = signedIn.body.data.signinFo.refreshToken as string;
    const refresh = () =>
      request(app.getHttpServer())
        .post("/graphql")
        .set("authorization", `Bearer ${refreshToken}`)
        .send({ query: `mutation Refresh { refresh { refreshToken } }` });

    const responses = await Promise.all([refresh(), refresh()]);
    const succeeded = responses.filter(({ body }) => body.errors === undefined);
    const rejected = responses.filter(({ body }) => body.errors !== undefined);

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const currentRefreshToken = succeeded[0]?.body.data.refresh.refreshToken as string;
    expect(currentRefreshToken).not.toBe(refreshToken);

    const staleLogout = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", `Bearer ${refreshToken}`)
      .send({ query: `mutation Logout { logout }` });
    expect(staleLogout.body.errors[0].message).toBe("아이디 또는 비밀번호가 올바르지 않습니다.");

    const currentRefresh = await request(app.getHttpServer())
      .post("/graphql")
      .set("authorization", `Bearer ${currentRefreshToken}`)
      .send({ query: `mutation Refresh { refresh { refreshToken } }` });
    expect(currentRefresh.body.errors).toBeUndefined();
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

  it("starts a Kakao login with an opaque flow and consumes an existing-user flow once", async () => {
    const deviceId = "kakao-existing-device";
    const flowId = "d0000000-0000-4000-8000-000000000001";
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
        ("flowId", "deviceIdHash", "providerUserId", "email", "emailVerified", "userId", "status", "expiresAt", "callbackAt")
       VALUES ($1, $2, 'kakao-existing', 'integration@example.test', true, $3, 'EXISTING_USER', now() + interval '10 minutes', now())`,
      [flowId, hashToken(deviceId), FIXTURE.userId],
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
        .send({ query: mutation, variables: { input: { flowId } } });
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

  it("binds a Kakao signup flow to its device and reports email fallback", async () => {
    const flowId = "d0000000-0000-4000-8000-000000000002";
    const deviceId = "kakao-signup-device";
    await pool.query(
      `INSERT INTO "kakaoLoginFlows"
        ("flowId", "deviceIdHash", "providerUserId", "status", "expiresAt", "callbackAt")
       VALUES ($1, $2, 'kakao-new', 'SIGNUP_REQUIRED', now() + interval '10 minutes', now())`,
      [flowId, hashToken(deviceId)],
    );
    const mutation = `mutation CompleteKakaoLogin($input: CompleteKakaoLoginInput!) {
      completeKakaoLogin(input: $input) {
        status
        kakaoSignupToken
        email
        emailVerificationRequired
      }
    }`;
    const wrongDevice = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", "another-device")
      .send({ query: mutation, variables: { input: { flowId } } });
    expect(wrongDevice.body.errors[0].message).toBe("카카오 로그인 흐름이 유효하지 않습니다.");

    const completed = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({ query: mutation, variables: { input: { flowId } } });
    expect(completed.body.errors).toBeUndefined();
    expect(completed.body.data.completeKakaoLogin).toEqual({
      status: "SIGNUP_REQUIRED",
      kakaoSignupToken: expect.any(String),
      email: null,
      emailVerificationRequired: true,
    });
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
