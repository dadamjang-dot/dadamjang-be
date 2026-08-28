import type { INestApplication } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { hashToken } from "src/common/security/token-hash";
import { FIXTURE } from "src/database/fixtures";
import { resetTestFixtures, testPool } from "./support/database";

const resetPassword = (app: INestApplication, token: string, password: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .send({
      query: `mutation ResetPassword($input: ResetPasswordInput!) { resetPassword(input: $input) { ok } }`,
      variables: { input: { token, password } },
    });

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

  it("revokes every sibling password-recovery proof", async () => {
    const verificationId = "e0000000-0000-4000-8000-000000000001";
    const activeCodeId = "e0000000-0000-4000-8000-000000000002";
    const activeCodeHash = await bcrypt.hash(
      "integration@example.test:654321:PASSWORD_RESET:integration-email-pepper",
      4,
    );
    await pool.query(
      `INSERT INTO "passwordResetToken" ("tokenHash", "userId", "expiresAt")
       VALUES ($1, $3, now() + interval '10 minutes'), ($2, $3, now() + interval '10 minutes')`,
      [hashToken("primary-reset-proof"), hashToken("sibling-link-proof"), FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "emailVerification" ("id", "email", "purpose", "codeHash", "expiresAt", "verifiedAt", "createdAt")
       VALUES
         ($1, 'integration@example.test', 'PASSWORD_RESET', 'verified-hash', now() + interval '10 minutes', now(), now()),
         ($2, 'integration@example.test', 'PASSWORD_RESET', $3, now() + interval '10 minutes', null, now() + interval '1 second')`,
      [verificationId, activeCodeId, activeCodeHash],
    );
    await pool.query(
      `INSERT INTO "emailVerificationToken" ("tokenHash", "email", "purpose", "verificationId", "expiresAt")
       VALUES ($1, 'integration@example.test', 'PASSWORD_RESET', $2, now() + interval '10 minutes')`,
      [hashToken("sibling-code-proof"), verificationId],
    );
    await pool.query(
      `INSERT INTO "refreshToken" ("userId", "deviceId", "refreshToken", "refreshTokenExp")
       VALUES ($1, 'device-a', 'hash-a', now() + interval '1 day')`,
      [FIXTURE.userId],
    );

    const reset = await resetPassword(app, "primary-reset-proof", "PrimaryPassword123!");
    expect(reset.body.errors).toBeUndefined();
    const activeProofs = await pool.query<{
      linkProofs: number;
      emailProofs: number;
      codes: number;
      refreshTokens: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM "passwordResetToken" WHERE "userId" = $1 AND "usedAt" IS NULL AND "expiresAt" > now()) AS "linkProofs",
         (SELECT count(*)::int FROM "emailVerificationToken" WHERE "email" = 'integration@example.test' AND "purpose" = 'PASSWORD_RESET' AND "usedAt" IS NULL AND "expiresAt" > now()) AS "emailProofs",
         (SELECT count(*)::int FROM "emailVerification" WHERE "email" = 'integration@example.test' AND "purpose" = 'PASSWORD_RESET' AND "verifiedAt" IS NULL AND "expiresAt" > now()) AS "codes",
         (SELECT count(*)::int FROM "refreshToken" WHERE "userId" = $1) AS "refreshTokens"`,
      [FIXTURE.userId],
    );
    expect(activeProofs.rows[0]).toEqual({ linkProofs: 0, emailProofs: 0, codes: 0, refreshTokens: 0 });

    const siblingLink = await resetPassword(app, "sibling-link-proof", "SiblingLinkPassword123!");
    const siblingCode = await resetPassword(app, "sibling-code-proof", "SiblingCodePassword123!");
    const staleCode = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `mutation VerifyPasswordResetCode($input: VerifyEmailCodeInput!) { verifyPasswordResetCode(input: $input) { emailVerificationToken } }`,
        variables: { input: { email: "integration@example.test", code: "654321" } },
      });
    expect(siblingLink.body.errors[0].message).toBe("비밀번호 재설정 인증이 유효하지 않습니다.");
    expect(siblingCode.body.errors[0].message).toBe("비밀번호 재설정 인증이 유효하지 않습니다.");
    expect(staleCode.body.errors).toBeDefined();
    const password = await pool.query<{ password: string }>(`SELECT "password" FROM "users" WHERE "userId" = $1`, [
      FIXTURE.userId,
    ]);
    await expect(bcrypt.compare("PrimaryPassword123!", password.rows[0].password)).resolves.toBe(true);
  });

  it("rolls back proof consumption when the password change fails", async () => {
    await pool.query(
      `INSERT INTO "passwordResetToken" ("tokenHash", "userId", "expiresAt")
       VALUES ($1, $2, now() + interval '10 minutes')`,
      [hashToken("rollback-reset-proof"), FIXTURE.userId],
    );
    await pool.query(
      `CREATE FUNCTION reject_password_change() RETURNS trigger AS $$
       BEGIN
         RAISE EXCEPTION 'blocked password update';
       END;
       $$ LANGUAGE plpgsql`,
    );
    await pool.query(
      `CREATE TRIGGER reject_password_change BEFORE UPDATE OF "password" ON "users"
       FOR EACH ROW EXECUTE FUNCTION reject_password_change()`,
    );

    let failedReset;
    try {
      failedReset = await resetPassword(app, "rollback-reset-proof", "ChangedPassword123!");
    } finally {
      await pool.query(`DROP TRIGGER reject_password_change ON "users"`);
      await pool.query(`DROP FUNCTION reject_password_change()`);
    }

    expect(failedReset.body.errors).toBeDefined();
    const retriedReset = await resetPassword(app, "rollback-reset-proof", "ChangedPassword123!");
    expect(retriedReset.body.errors).toBeUndefined();
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
