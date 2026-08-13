import type { INestApplication } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { hashToken } from "src/common/security/token-hash";
import { FIXTURE } from "src/database/fixtures";
import { resetTestFixtures, testPool } from "./support/database";

describe("FO account recovery GraphQL integration", () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    pool = testPool();
    app = await createApp();
    await app.init();
  });

  beforeEach(async () => {
    await resetTestFixtures(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("finds only a masked email with a device-bound identity proof", async () => {
    await pool.query(
      `INSERT INTO "verifiedIdentities" ("userId", "ciHash", "certificateProvider", "verifiedAt")
       VALUES ($1, 'fixture-ci', 'TOSS', now())`,
      [FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "identityVerificationSessions"
        ("purpose", "provider", "deviceIdHash", "merchantTransactionId", "status", "ciHash", "certificateProvider", "isFourteenOrOlder", "proofTokenHash", "expiresAt", "verifiedAt", "completedAt")
       VALUES ('FIND_EMAIL', 'TOSS', $1, '22345678901234567890', 'VERIFIED', 'fixture-ci', 'TOSS', true, $2, now() + interval '10 minutes', now(), now())`,
      [hashToken("recovery-device"), hashToken("find-email-proof")],
    );
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", "recovery-device")
      .send({
        query: `mutation FindFoEmail($identityVerificationToken: String!) { findFoEmail(identityVerificationToken: $identityVerificationToken) { found maskedEmail } }`,
        variables: { identityVerificationToken: "find-email-proof" },
      });
    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.findFoEmail).toEqual({ found: true, maskedEmail: "in***@example.test" });
  });

  it("resets a password from a six-digit code and revokes every refresh token", async () => {
    const codeHash = await bcrypt.hash("integration@example.test:123456:PASSWORD_RESET:integration-email-pepper", 4);
    await pool.query(
      `INSERT INTO "emailVerification" ("email", "purpose", "codeHash", "expiresAt")
       VALUES ('integration@example.test', 'PASSWORD_RESET', $1, now() + interval '10 minutes')`,
      [codeHash],
    );
    const verified = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `mutation VerifyPasswordResetCode($input: VerifyEmailCodeInput!) { verifyPasswordResetCode(input: $input) { emailVerificationToken } }`,
        variables: { input: { email: "integration@example.test", code: "123456" } },
      });
    expect(verified.body.errors).toBeUndefined();

    await pool.query(
      `INSERT INTO "refreshToken" ("userId", "deviceId", "refreshToken", "refreshTokenExp")
       VALUES ($1, 'device-a', 'hash-a', now() + interval '1 day'), ($1, 'device-b', 'hash-b', now() + interval '1 day')`,
      [FIXTURE.userId],
    );
    const reset = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `mutation ResetPassword($input: ResetPasswordInput!) { resetPassword(input: $input) { ok } }`,
        variables: {
          input: {
            token: verified.body.data.verifyPasswordResetCode.emailVerificationToken,
            password: "ChangedPassword123!",
          },
        },
      });
    expect(reset.body.errors).toBeUndefined();
    const tokens = await pool.query(`SELECT 1 FROM "refreshToken" WHERE "userId" = $1`, [FIXTURE.userId]);
    expect(tokens.rowCount).toBe(0);
  });

  it("returns the same password reset request shape for known and unknown emails", async () => {
    const mutation = `mutation RequestPasswordResetCode($input: RequestEmailCodeInput!) { requestPasswordResetCode(input: $input) { ok } }`;
    const known = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: mutation, variables: { input: { email: "integration@example.test" } } });
    const unknown = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: mutation, variables: { input: { email: "unknown@example.test" } } });
    expect(known.body.data).toEqual({ requestPasswordResetCode: { ok: true } });
    expect(unknown.body.data).toEqual({ requestPasswordResetCode: { ok: true } });
  });

  it("binds identity completion to the starting device and permits completion once", async () => {
    const deviceId = "identity-device";
    const started = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({
        query: `mutation StartIdentityVerification($input: StartIdentityVerificationInput!) {
          startIdentityVerification(input: $input) { sessionId launchUrl expiresAt }
        }`,
        variables: { input: { purpose: "FIND_EMAIL", provider: "KAKAO" } },
      });
    expect(started.body.errors).toBeUndefined();
    const sessionId = started.body.data.startIdentityVerification.sessionId as string;

    const launched = await request(app.getHttpServer()).get(`/api/auth/identity/inicis/start/${sessionId}`);
    expect(launched.status).toBe(302);
    expect(launched.headers.location).toContain("status=verified");

    const statusQuery = `query IdentityVerificationStatus($sessionId: ID!) {
      identityVerificationStatus(sessionId: $sessionId) { sessionId status expiresAt }
    }`;
    const wrongDevice = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", "wrong-device")
      .send({ query: statusQuery, variables: { sessionId } });
    expect(wrongDevice.body.errors[0].message).toBe("본인인증 세션이 유효하지 않습니다.");

    const completed = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({
        query: `mutation CompleteIdentityVerification($sessionId: ID!) {
          completeIdentityVerification(sessionId: $sessionId) { identityVerificationToken }
        }`,
        variables: { sessionId },
      });
    expect(completed.body.errors).toBeUndefined();
    expect(completed.body.data.completeIdentityVerification.identityVerificationToken).toEqual(expect.any(String));

    const reused = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", deviceId)
      .send({
        query: `mutation CompleteIdentityVerification($sessionId: ID!) {
          completeIdentityVerification(sessionId: $sessionId) { identityVerificationToken }
        }`,
        variables: { sessionId },
      });
    expect(reused.body.errors[0].message).toBe("본인인증 완료 상태가 유효하지 않습니다.");
  });
});
