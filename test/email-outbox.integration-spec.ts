import { Logger, type INestApplication } from "@nestjs/common";
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
    const after = await pool.query<{
      email: string;
      lastError: string | null;
      payloadCiphertext: string | null;
      proofId: string | null;
      requestIpHash: string | null;
      status: string;
    }>(`
      SELECT "email", "lastError", "payloadCiphertext", "proofId", "requestIpHash", "status"
      FROM "emailDeliveryOutbox" o
      ORDER BY o."status"
    `);
    expect(after.rows).toEqual([
      {
        email: "redacted@invalid",
        lastError: null,
        payloadCiphertext: null,
        proofId: null,
        requestIpHash: null,
        status: "SENT",
      },
      {
        email: "redacted@invalid",
        lastError: null,
        payloadCiphertext: null,
        proofId: null,
        requestIpHash: null,
        status: "SUPPRESSED",
      },
    ]);
    const proofs = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "emailVerification" WHERE "email" = 'integration@example.test'`,
    );
    expect(proofs.rows[0]?.count).toBe(1);
  });

  it("suppresses password reset codes for passwordless accounts without sending mail", async () => {
    const sendCode = jest.spyOn(sender, "sendCode").mockResolvedValue(undefined);
    await pool.query(`UPDATE "users" SET "password" = NULL WHERE "email" = 'integration@example.test'`);
    const requested = await requestEmail(
      app,
      "requestPasswordResetCode",
      "integration@example.test",
      "passwordless-reset-device",
    );

    expect(requested.body).toEqual({ data: { requestPasswordResetCode: { ok: true } } });
    await worker.runOnce(new Date(Date.now() + 1_000));

    expect(sendCode).not.toHaveBeenCalled();
    const rows = await pool.query<{ kind: string; status: string }>(
      `SELECT "kind", "status" FROM "emailDeliveryOutbox"`,
    );
    expect(rows.rows).toEqual([{ kind: "PASSWORD_RESET_CODE", status: "SUPPRESSED" }]);
  });

  it("delivers password reset codes when the stored password is empty but non-null", async () => {
    const sendCode = jest.spyOn(sender, "sendCode").mockResolvedValue(undefined);
    await pool.query(`UPDATE "users" SET "password" = '' WHERE "email" = 'integration@example.test'`);
    const requested = await requestEmail(
      app,
      "requestPasswordResetCode",
      "integration@example.test",
      "empty-password-reset-device",
    );

    expect(requested.body).toEqual({ data: { requestPasswordResetCode: { ok: true } } });
    await worker.runOnce(new Date(Date.now() + 1_000));

    expect(sendCode).toHaveBeenCalledTimes(1);
    const rows = await pool.query<{ status: string }>(`SELECT "status" FROM "emailDeliveryOutbox"`);
    expect(rows.rows).toEqual([{ status: "SENT" }]);
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
      id: string;
      payloadCiphertext: string;
      proofId: string;
      status: string;
    }>(`
      SELECT "id", "payloadCiphertext", "proofId", "status"
      FROM "emailDeliveryOutbox"
      WHERE "email" = 'new-signup@example.test'
    `);
    expect(afterTimeout.rows[0]).toEqual({
      id: expect.any(String),
      payloadCiphertext: expect.any(String),
      proofId: expect.any(String),
      status: "PENDING",
    });
    await pool.query(`UPDATE "emailDeliveryOutbox" SET "availableAt" = '2000-01-01T00:00:00Z'`);

    await worker.runOnce(new Date(firstAttemptAt.getTime() + 1_000));

    expect(sendCode).toHaveBeenCalledTimes(2);
    expect(sendCode.mock.calls[1]).toEqual(sendCode.mock.calls[0]);
    const completed = await pool.query<{
      email: string;
      payloadCiphertext: string | null;
      proofCount: number;
      proofId: string | null;
      status: string;
    }>(
      `
      SELECT o."email", o."payloadCiphertext", o."proofId", o."status",
        (SELECT count(*)::int FROM "emailVerification" v WHERE v."email" = 'new-signup@example.test') AS "proofCount"
      FROM "emailDeliveryOutbox" o
      WHERE o."id" = $1
    `,
      [afterTimeout.rows[0]?.id],
    );
    expect(completed.rows[0]).toEqual({
      email: "redacted@invalid",
      payloadCiphertext: null,
      proofCount: 1,
      proofId: null,
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
    const afterCommitFailure = await pool.query<{ id: string; proofCount: number; status: string }>(`
      SELECT o."id", o."status",
        (SELECT count(*)::int FROM "emailVerification" v WHERE v."email" = o."email") AS "proofCount"
      FROM "emailDeliveryOutbox" o
      WHERE o."email" = 'commit-after-send@example.test'
    `);
    expect(afterCommitFailure.rows[0]).toEqual({ id: expect.any(String), proofCount: 1, status: "PENDING" });
    await pool.query(`UPDATE "emailDeliveryOutbox" SET "availableAt" = '2000-01-01T00:00:00Z'`);

    await worker.runOnce(new Date(firstAttemptAt.getTime() + 1_000));

    expect(sendCode).toHaveBeenCalledTimes(2);
    expect(sendCode.mock.calls[1]).toEqual(sendCode.mock.calls[0]);
    const completed = await pool.query<{ proofCount: number; status: string }>(
      `
      SELECT o."status",
        (SELECT count(*)::int FROM "emailVerification" v
          WHERE v."email" = 'commit-after-send@example.test') AS "proofCount"
      FROM "emailDeliveryOutbox" o
      WHERE o."id" = $1
    `,
      [afterCommitFailure.rows[0]?.id],
    );
    expect(completed.rows[0]).toEqual({ proofCount: 1, status: "SENT" });
  });

  it("claims one delivery only once across concurrent worker loops", async () => {
    const sendCode = jest.spyOn(sender, "sendCode").mockResolvedValue(undefined);
    await requestEmail(app, "requestSignupEmailCode", "concurrent@example.test", "concurrent-worker-device");
    const queued = await pool.query<{ id: string }>(
      `SELECT "id" FROM "emailDeliveryOutbox" WHERE "email" = 'concurrent@example.test'`,
    );
    const now = new Date(Date.now() + 1_000);

    const results = await Promise.all([worker.runOnce(now), worker.runOnce(now)]);

    expect(results.sort()).toEqual([false, true]);
    expect(sendCode).toHaveBeenCalledTimes(1);
    const state = await pool.query<{ attemptCount: number; status: string }>(
      `
      SELECT "attemptCount", "status"
      FROM "emailDeliveryOutbox"
      WHERE "id" = $1
    `,
      [queued.rows[0]?.id],
    );
    expect(state.rows[0]).toEqual({ attemptCount: 1, status: "SENT" });
  });

  it("scrubs historical and rolling-overlap terminal rows without moving their retention clock", async () => {
    const now = new Date("2026-08-29T12:00:00.000Z");
    const retainedAt = new Date("2026-08-28T12:00:00.000Z");
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    await pool.query(
      `INSERT INTO "emailDeliveryOutbox"
        ("kind", "email", "requestIpHash", "payloadCiphertext", "proofId", "status", "availableAt", "expiresAt", "sentAt", "lastError", "updatedAt")
       VALUES
        ('SIGNUP_CODE', 'sent-history@example.test', repeat('a', 64), 'sent-ciphertext', 'sent-proof', 'SENT', $1, $1, $2, 'sent-error', $2),
        ('PASSWORD_RESET_CODE', 'suppressed-history@example.test', repeat('b', 64), 'suppressed-ciphertext', 'suppressed-proof', 'SUPPRESSED', $1, $1, NULL, 'suppressed-error', $2),
        ('PASSWORD_RESET_CODE', 'failed-history@example.test', repeat('c', 64), 'failed-ciphertext', 'failed-proof', 'FAILED', $1, $1, NULL, 'failed-error', $2),
        ('SIGNUP_CODE', 'pending-history@example.test', repeat('d', 64), 'pending-ciphertext', 'pending-proof', 'PENDING', $1, $1, NULL, 'pending-error', $2)`,
      [new Date("2026-08-30T12:00:00.000Z"), retainedAt],
    );
    await pool.query(
      `INSERT INTO "emailDeliveryOutbox"
        ("kind", "email", "requestIpHash", "payloadCiphertext", "proofId", "status", "claimedAt", "claimToken", "expiresAt", "lastError", "updatedAt")
       VALUES ('SIGNUP_CODE', 'processing-history@example.test', repeat('e', 64), 'processing-ciphertext',
         'processing-proof', 'PROCESSING', $1, '00000000-0000-4000-8000-000000000003',
         $1::timestamptz + interval '1 day', 'processing-error', $2)`,
      [now, retainedAt],
    );

    await expect(worker.runOnce(now)).resolves.toBe(false);

    const terminal = await pool.query<{
      email: string;
      lastError: string | null;
      payloadCiphertext: string | null;
      proofId: string | null;
      requestIpHash: string | null;
      status: string;
      updatedAt: Date;
    }>(
      `SELECT "email", "lastError", "payloadCiphertext", "proofId", "requestIpHash", "status", "updatedAt"
       FROM "emailDeliveryOutbox"
       WHERE "status" IN ('SENT', 'SUPPRESSED', 'FAILED')
       ORDER BY "status"`,
    );
    expect(terminal.rows).toEqual([
      {
        email: "redacted@invalid",
        lastError: null,
        payloadCiphertext: null,
        proofId: null,
        requestIpHash: null,
        status: "FAILED",
        updatedAt: retainedAt,
      },
      {
        email: "redacted@invalid",
        lastError: null,
        payloadCiphertext: null,
        proofId: null,
        requestIpHash: null,
        status: "SENT",
        updatedAt: retainedAt,
      },
      {
        email: "redacted@invalid",
        lastError: null,
        payloadCiphertext: null,
        proofId: null,
        requestIpHash: null,
        status: "SUPPRESSED",
        updatedAt: retainedAt,
      },
    ]);
    const active = await pool.query<{
      email: string;
      lastError: string;
      payloadCiphertext: string;
      proofId: string;
      requestIpHash: string;
      status: string;
      updatedAt: Date;
    }>(
      `SELECT "email", "lastError", "payloadCiphertext", "proofId", "requestIpHash", "status", "updatedAt"
       FROM "emailDeliveryOutbox"
       WHERE "status" IN ('PENDING', 'PROCESSING')
       ORDER BY "status"`,
    );
    expect(active.rows).toEqual([
      {
        email: "pending-history@example.test",
        lastError: "pending-error",
        payloadCiphertext: "pending-ciphertext",
        proofId: "pending-proof",
        requestIpHash: "d".repeat(64),
        status: "PENDING",
        updatedAt: retainedAt,
      },
      {
        email: "processing-history@example.test",
        lastError: "processing-error",
        payloadCiphertext: "processing-ciphertext",
        proofId: "processing-proof",
        requestIpHash: "e".repeat(64),
        status: "PROCESSING",
        updatedAt: retainedAt,
      },
    ]);
    expect(log).toHaveBeenCalledWith("Scrubbed 3 terminal email deliveries");

    const overlapInserted = await pool.query<{ id: string }>(
      `INSERT INTO "emailDeliveryOutbox"
        ("kind", "email", "requestIpHash", "payloadCiphertext", "proofId", "status", "expiresAt", "sentAt", "lastError", "updatedAt")
       VALUES ('SIGNUP_CODE', 'overlap-writer@example.test', repeat('f', 64), 'overlap-ciphertext',
         'overlap-proof', 'SENT', $1, $2, 'overlap-error', $2)
       RETURNING "id"`,
      [new Date("2026-08-30T12:00:00.000Z"), retainedAt],
    );
    await expect(worker.runOnce(now)).resolves.toBe(false);
    const overlap = await pool.query<{ email: string; updatedAt: Date }>(
      `SELECT "email", "updatedAt"
       FROM "emailDeliveryOutbox"
       WHERE "id" = $1`,
      [overlapInserted.rows[0]?.id],
    );
    expect(overlap.rows[0]).toEqual({ email: "redacted@invalid", updatedAt: retainedAt });
    expect(log).toHaveBeenCalledWith("Scrubbed 1 terminal email deliveries");
    log.mockClear();

    await expect(worker.runOnce(now)).resolves.toBe(false);

    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("Scrubbed"));
  });

  it("scrubs at most 100 terminal rows per worker pass", async () => {
    const now = new Date("2026-08-29T12:00:00.000Z");
    await pool.query(
      `INSERT INTO "emailDeliveryOutbox"
        ("kind", "email", "requestIpHash", "payloadCiphertext", "proofId", "status", "expiresAt", "lastError", "updatedAt")
       SELECT 'PASSWORD_RESET_CODE', 'scrub-batch-' || value || '@example.test', repeat('a', 64),
         'ciphertext', 'proof-' || value, 'FAILED', $1::timestamptz + interval '1 day', 'sensitive error',
         $1::timestamptz - interval '1 day'
       FROM generate_series(1, 101) AS value`,
      [now],
    );

    await expect(worker.runOnce(now)).resolves.toBe(false);
    const afterFirst = await pool.query<{ redacted: number; sensitive: number }>(`
      SELECT
        count(*) FILTER (WHERE "email" = 'redacted@invalid')::int AS redacted,
        count(*) FILTER (WHERE "email" <> 'redacted@invalid')::int AS sensitive
      FROM "emailDeliveryOutbox"
    `);
    expect(afterFirst.rows[0]).toEqual({ redacted: 100, sensitive: 1 });

    await expect(worker.runOnce(now)).resolves.toBe(false);
    const afterSecond = await pool.query<{ redacted: number; sensitive: number }>(`
      SELECT
        count(*) FILTER (WHERE "email" = 'redacted@invalid')::int AS redacted,
        count(*) FILTER (WHERE "email" <> 'redacted@invalid')::int AS sensitive
      FROM "emailDeliveryOutbox"
    `);
    expect(afterSecond.rows[0]).toEqual({ redacted: 101, sensitive: 0 });
  });

  it("lets concurrent workers scrub separate terminal batches safely", async () => {
    const now = new Date("2026-08-29T12:00:00.000Z");
    const retainedAt = new Date("2026-08-28T12:00:00.000Z");
    await pool.query(
      `INSERT INTO "emailDeliveryOutbox"
        ("kind", "email", "requestIpHash", "payloadCiphertext", "proofId", "status", "expiresAt", "lastError", "updatedAt")
       SELECT 'SIGNUP_CODE', 'concurrent-scrub-' || value || '@example.test', repeat('a', 64),
         'ciphertext', 'proof-' || value, 'SUPPRESSED', $1::timestamptz + interval '1 day', 'sensitive error', $2
       FROM generate_series(1, 150) AS value`,
      [now, retainedAt],
    );

    await expect(Promise.all([worker.runOnce(now), worker.runOnce(now)])).resolves.toEqual([false, false]);

    const state = await pool.query<{
      maximumUpdatedAt: Date;
      minimumUpdatedAt: Date;
      redacted: number;
      sensitive: number;
    }>(`
      SELECT
        max("updatedAt") AS "maximumUpdatedAt",
        min("updatedAt") AS "minimumUpdatedAt",
        count(*) FILTER (
          WHERE "email" = 'redacted@invalid'
            AND "requestIpHash" IS NULL
            AND "payloadCiphertext" IS NULL
            AND "proofId" IS NULL
            AND "lastError" IS NULL
        )::int AS redacted,
        count(*) FILTER (
          WHERE "email" <> 'redacted@invalid'
             OR "requestIpHash" IS NOT NULL
             OR "payloadCiphertext" IS NOT NULL
             OR "proofId" IS NOT NULL
             OR "lastError" IS NOT NULL
        )::int AS sensitive
      FROM "emailDeliveryOutbox"
    `);
    expect(state.rows[0]).toEqual({
      maximumUpdatedAt: retainedAt,
      minimumUpdatedAt: retainedAt,
      redacted: 150,
      sensitive: 0,
    });
  });

  it("deletes at most 100 retained terminal rows without touching active work", async () => {
    const now = new Date("2026-08-29T12:00:00.000Z");
    await pool.query(
      `INSERT INTO "emailDeliveryOutbox"
        ("kind", "email", "requestIpHash", "payloadCiphertext", "proofId", "status", "expiresAt", "lastError", "updatedAt")
       SELECT 'PASSWORD_RESET_CODE', 'retained-' || value || '@example.test', repeat('a', 64),
         'ciphertext', 'proof-' || value, 'FAILED', $1::timestamptz - interval '8 days', 'sensitive error',
         $1::timestamptz - interval '8 days'
       FROM generate_series(1, 101) AS value`,
      [now],
    );
    await pool.query(
      `INSERT INTO "emailDeliveryOutbox"
        ("kind", "email", "status", "availableAt", "expiresAt", "updatedAt")
       VALUES ('SIGNUP_CODE', 'pending@example.test', 'PENDING', $1::timestamptz + interval '1 hour',
         $1::timestamptz + interval '1 day', $1::timestamptz - interval '8 days')`,
      [now],
    );
    await pool.query(
      `INSERT INTO "emailDeliveryOutbox"
        ("kind", "email", "status", "claimedAt", "claimToken", "expiresAt", "updatedAt")
       VALUES ('SIGNUP_CODE', 'processing@example.test', 'PROCESSING', $1,
         '00000000-0000-4000-8000-000000000001', $1::timestamptz + interval '1 day',
         $1::timestamptz - interval '8 days')`,
      [now],
    );

    await expect(worker.runOnce(now)).resolves.toBe(false);

    const state = await pool.query<{ pending: number; processing: number; terminal: number }>(`
      SELECT
        count(*) FILTER (WHERE "status" = 'PENDING')::int AS pending,
        count(*) FILTER (WHERE "status" = 'PROCESSING')::int AS processing,
        count(*) FILTER (WHERE "status" IN ('SENT', 'SUPPRESSED', 'FAILED'))::int AS terminal
      FROM "emailDeliveryOutbox"
    `);
    expect(state.rows[0]).toEqual({ pending: 1, processing: 1, terminal: 1 });
  });

  it("lets concurrent worker maintenance consume separate terminal batches", async () => {
    const now = new Date("2026-08-29T12:00:00.000Z");
    await pool.query(
      `INSERT INTO "emailDeliveryOutbox" ("kind", "email", "status", "expiresAt", "updatedAt")
       SELECT 'SIGNUP_CODE', 'concurrent-retained-' || value || '@example.test', 'SUPPRESSED',
         $1::timestamptz - interval '8 days', $1::timestamptz - interval '8 days'
       FROM generate_series(1, 150) AS value`,
      [now],
    );
    await pool.query(
      `INSERT INTO "emailDeliveryOutbox"
        ("kind", "email", "status", "claimedAt", "claimToken", "expiresAt", "updatedAt")
       VALUES ('SIGNUP_CODE', 'current-claim@example.test', 'PROCESSING', $1,
         '00000000-0000-4000-8000-000000000002', $1::timestamptz + interval '1 day',
         $1::timestamptz - interval '8 days')`,
      [now],
    );

    await expect(Promise.all([worker.runOnce(now), worker.runOnce(now)])).resolves.toEqual([false, false]);

    const state = await pool.query<{ processing: number; terminal: number }>(`
      SELECT
        count(*) FILTER (WHERE "status" = 'PROCESSING')::int AS processing,
        count(*) FILTER (WHERE "status" IN ('SENT', 'SUPPRESSED', 'FAILED'))::int AS terminal
      FROM "emailDeliveryOutbox"
    `);
    expect(state.rows[0]).toEqual({ processing: 1, terminal: 0 });
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
