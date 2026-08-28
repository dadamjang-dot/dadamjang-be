import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { EmailDeliveryWorker } from "src/modules/email/email.outbox";
import type { EmailSender } from "src/modules/email/email.sender";
import { resetTestFixtures, testPool } from "./support/database";

const requestEmail = (
  app: INestApplication,
  operation: "requestPasswordResetCode" | "requestSignupEmailCode",
  email: string,
  deviceId: string,
) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("x-device-id", deviceId)
    .send({
      query: `mutation Request($input: RequestEmailCodeInput!) { ${operation}(input: $input) { ok } }`,
      variables: { input: { email } },
    });

describe("durable email delivery outbox integration", () => {
  let app: INestApplication;
  let pool: Pool;
  let sender: EmailSender;
  let worker: EmailDeliveryWorker;

  beforeAll(async () => {
    pool = testPool();
    app = await createApp();
    await app.init();
    sender = app.get<EmailSender>("EmailSender");
    worker = app.get(EmailDeliveryWorker);
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestFixtures(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("keeps known and unknown recovery requests generic until the worker suppresses the unknown address", async () => {
    const sendCode = jest.spyOn(sender, "sendCode").mockResolvedValue(undefined);
    const known = await requestEmail(
      app,
      "requestPasswordResetCode",
      "integration@example.test",
      "known-recovery-device",
    );
    const unknown = await requestEmail(
      app,
      "requestPasswordResetCode",
      "unknown@example.test",
      "unknown-recovery-device",
    );

    expect(known.body).toEqual({ data: { requestPasswordResetCode: { ok: true } } });
    expect(unknown.body).toEqual({ data: { requestPasswordResetCode: { ok: true } } });
    expect(sendCode).not.toHaveBeenCalled();
    const before = await pool.query<{ outboxCount: number; proofCount: number }>(`
      SELECT
        (SELECT count(*)::int FROM "emailDeliveryOutbox") AS "outboxCount",
        (SELECT count(*)::int FROM "emailVerification") AS "proofCount"
    `);
    expect(before.rows[0]).toEqual({ outboxCount: 2, proofCount: 0 });

    const deliveryAt = new Date(Date.now() + 1_000);
    await worker.runOnce(deliveryAt);
    await worker.runOnce(deliveryAt);

    expect(sendCode).toHaveBeenCalledTimes(1);
    expect(sendCode).toHaveBeenCalledWith(
      "integration@example.test",
      expect.stringMatching(/^\d{6}$/),
      expect.stringMatching(/^email-delivery\/[0-9a-f-]+$/),
    );
    const after = await pool.query<{ email: string; status: string; proofCount: number }>(`
      SELECT o."email", o."status",
        (SELECT count(*)::int FROM "emailVerification" v WHERE v."email" = o."email") AS "proofCount"
      FROM "emailDeliveryOutbox" o
      ORDER BY o."email"
    `);
    expect(after.rows).toEqual([
      { email: "integration@example.test", status: "SENT", proofCount: 1 },
      { email: "unknown@example.test", status: "SUPPRESSED", proofCount: 0 },
    ]);
  });

  it("retries an ambiguous signup send with the same proof, payload, and provider idempotency key", async () => {
    const sendCode = jest
      .spyOn(sender, "sendCode")
      .mockRejectedValueOnce(new Error("ambiguous provider timeout"))
      .mockResolvedValueOnce(undefined);
    const queued = await requestEmail(
      app,
      "requestSignupEmailCode",
      "new-signup@example.test",
      "signup-timeout-device",
    );
    expect(queued.body).toEqual({ data: { requestSignupEmailCode: { ok: true } } });

    const firstAttemptAt = new Date(Date.now() + 1_000);
    await worker.runOnce(firstAttemptAt);
    const afterTimeout = await pool.query<{
      payloadCiphertext: string;
      proofId: string;
      status: string;
    }>(`
      SELECT "payloadCiphertext", "proofId", "status"
      FROM "emailDeliveryOutbox"
      WHERE "email" = 'new-signup@example.test'
    `);
    expect(afterTimeout.rows[0]).toEqual({
      payloadCiphertext: expect.any(String),
      proofId: expect.any(String),
      status: "PENDING",
    });
    await pool.query(`UPDATE "emailDeliveryOutbox" SET "availableAt" = '2000-01-01T00:00:00Z'`);

    await worker.runOnce(new Date(firstAttemptAt.getTime() + 1_000));

    expect(sendCode).toHaveBeenCalledTimes(2);
    expect(sendCode.mock.calls[1]).toEqual(sendCode.mock.calls[0]);
    const completed = await pool.query<{
      payloadCiphertext: string;
      proofCount: number;
      proofId: string;
      status: string;
    }>(`
      SELECT o."payloadCiphertext", o."proofId", o."status",
        (SELECT count(*)::int FROM "emailVerification" v WHERE v."email" = o."email") AS "proofCount"
      FROM "emailDeliveryOutbox" o
      WHERE o."email" = 'new-signup@example.test'
    `);
    expect(completed.rows[0]).toEqual({
      payloadCiphertext: afterTimeout.rows[0]?.payloadCiphertext,
      proofCount: 1,
      proofId: afterTimeout.rows[0]?.proofId,
      status: "SENT",
    });
  });

  it("preserves a potentially delivered signup proof when the SENT update fails to commit", async () => {
    const sendCode = jest.spyOn(sender, "sendCode").mockResolvedValue(undefined);
    await requestEmail(app, "requestSignupEmailCode", "commit-after-send@example.test", "signup-commit-device");
    await pool.query(`
      CREATE FUNCTION reject_email_sent_update() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'blocked email SENT update';
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE TRIGGER reject_email_sent_update
      BEFORE UPDATE ON "emailDeliveryOutbox"
      FOR EACH ROW
      WHEN (NEW."status" = 'SENT')
      EXECUTE FUNCTION reject_email_sent_update()
    `);

    const firstAttemptAt = new Date(Date.now() + 1_000);
    try {
      await worker.runOnce(firstAttemptAt);
    } finally {
      await pool.query(`DROP TRIGGER reject_email_sent_update ON "emailDeliveryOutbox"`);
      await pool.query(`DROP FUNCTION reject_email_sent_update()`);
    }
    const afterCommitFailure = await pool.query<{ proofCount: number; status: string }>(`
      SELECT o."status",
        (SELECT count(*)::int FROM "emailVerification" v WHERE v."email" = o."email") AS "proofCount"
      FROM "emailDeliveryOutbox" o
      WHERE o."email" = 'commit-after-send@example.test'
    `);
    expect(afterCommitFailure.rows[0]).toEqual({ proofCount: 1, status: "PENDING" });
    await pool.query(`UPDATE "emailDeliveryOutbox" SET "availableAt" = '2000-01-01T00:00:00Z'`);

    await worker.runOnce(new Date(firstAttemptAt.getTime() + 1_000));

    expect(sendCode).toHaveBeenCalledTimes(2);
    expect(sendCode.mock.calls[1]).toEqual(sendCode.mock.calls[0]);
    const completed = await pool.query<{ proofCount: number; status: string }>(`
      SELECT o."status",
        (SELECT count(*)::int FROM "emailVerification" v WHERE v."email" = o."email") AS "proofCount"
      FROM "emailDeliveryOutbox" o
      WHERE o."email" = 'commit-after-send@example.test'
    `);
    expect(completed.rows[0]).toEqual({ proofCount: 1, status: "SENT" });
  });

  it("claims one delivery only once across concurrent worker loops", async () => {
    const sendCode = jest.spyOn(sender, "sendCode").mockResolvedValue(undefined);
    await requestEmail(app, "requestSignupEmailCode", "concurrent@example.test", "concurrent-worker-device");
    const now = new Date(Date.now() + 1_000);

    const results = await Promise.all([worker.runOnce(now), worker.runOnce(now)]);

    expect(results.sort()).toEqual([false, true]);
    expect(sendCode).toHaveBeenCalledTimes(1);
    const state = await pool.query<{ attemptCount: number; status: string }>(`
      SELECT "attemptCount", "status"
      FROM "emailDeliveryOutbox"
      WHERE "email" = 'concurrent@example.test'
    `);
    expect(state.rows[0]).toEqual({ attemptCount: 1, status: "SENT" });
  });

  it("never sends signup mail when the outbox insert fails at transaction commit", async () => {
    const sendCode = jest.spyOn(sender, "sendCode").mockResolvedValue(undefined);
    await pool.query(`
      CREATE FUNCTION reject_signup_outbox_commit() RETURNS trigger AS $$
      BEGIN
        IF NEW."email" = 'signup-commit-failure@example.test' THEN
          RAISE EXCEPTION 'blocked signup outbox commit';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE CONSTRAINT TRIGGER reject_signup_outbox_commit
      AFTER INSERT ON "emailDeliveryOutbox"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION reject_signup_outbox_commit()
    `);

    let response;
    try {
      response = await requestEmail(
        app,
        "requestSignupEmailCode",
        "signup-commit-failure@example.test",
        "signup-commit-failure-device",
      );
    } finally {
      await pool.query(`DROP TRIGGER reject_signup_outbox_commit ON "emailDeliveryOutbox"`);
      await pool.query(`DROP FUNCTION reject_signup_outbox_commit()`);
    }

    expect(response.body.errors).toBeDefined();
    expect(sendCode).not.toHaveBeenCalled();
    const state = await pool.query<{ outboxCount: number; proofCount: number }>(`
      SELECT
        (SELECT count(*)::int FROM "emailDeliveryOutbox" WHERE "email" = 'signup-commit-failure@example.test') AS "outboxCount",
        (SELECT count(*)::int FROM "emailVerification" WHERE "email" = 'signup-commit-failure@example.test') AS "proofCount"
    `);
    expect(state.rows[0]).toEqual({ outboxCount: 0, proofCount: 0 });
  });
});
