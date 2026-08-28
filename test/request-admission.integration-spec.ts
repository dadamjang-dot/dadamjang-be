import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { AdmissionLimiter } from "src/modules/admission/admission-limiter";
import { resetTestFixtures, testPool } from "./support/database";

describe("Request admission PostgreSQL integration", () => {
  const originalTrustProxy = process.env.TRUST_PROXY;
  let app: INestApplication;
  let limiter: AdmissionLimiter;
  let pool: Pool;

  beforeAll(async () => {
    process.env.TRUST_PROXY = "true";
    pool = testPool();
    app = await createApp();
    await app.init();
    limiter = app.get(AdmissionLimiter);
  });

  beforeEach(async () => {
    await resetTestFixtures(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = originalTrustProxy;
  });

  it("uses the ALB-appended client hop instead of attacker-controlled X-Forwarded-For entries", async () => {
    const mutation = `mutation RequestPasswordResetCode($input: RequestEmailCodeInput!) {
      requestPasswordResetCode(input: $input) { ok }
    }`;
    const responses = [];

    for (let index = 0; index < 21; index += 1)
      responses.push(
        await request(app.getHttpServer())
          .post("/graphql")
          .set("X-Forwarded-For", `203.0.113.${index + 1}, 198.51.100.7`)
          .send({
            query: mutation,
            variables: { input: { email: `xff-${index}@example.test` } },
          }),
      );

    expect(responses.slice(0, 20).every((response) => response.body.data?.requestPasswordResetCode?.ok)).toBe(true);
    expect(responses[20]?.body.errors?.[0]?.extensions?.code).toBe("TOO_MANY_REQUESTS");
    const scopes = await pool.query<{ requestCount: number }>(
      `SELECT "requestCount"
       FROM "requestAdmission"
       WHERE "action" = 'EMAIL_DELIVERY' AND "scopeType" = 'delivery-ip'`,
    );
    expect(scopes.rows).toEqual([{ requestCount: 20 }]);
  }, 30_000);

  it("keeps direct requests bound to the socket address when no proxy header is present", async () => {
    const mutation = `mutation RequestPasswordResetCode($input: RequestEmailCodeInput!) {
      requestPasswordResetCode(input: $input) { ok }
    }`;
    const responses = [];

    for (let index = 0; index < 21; index += 1)
      responses.push(
        await request(app.getHttpServer())
          .post("/graphql")
          .send({
            query: mutation,
            variables: { input: { email: `direct-${index}@example.test` } },
          }),
      );

    expect(responses.slice(0, 20).every((response) => response.body.data?.requestPasswordResetCode?.ok)).toBe(true);
    expect(responses[20]?.body.errors?.[0]?.extensions?.code).toBe("TOO_MANY_REQUESTS");
  }, 30_000);

  it("rolls back every earlier mixed-rule increment when a concurrent request is rejected", async () => {
    const now = new Date("2026-08-29T00:00:00Z");
    await expect(
      limiter.consume(
        "MIXED_ATOMICITY_TEST",
        [{ scopeType: "z-shared", value: "shared-requester", limit: 1, windowMs: 60_000 }],
        now,
      ),
    ).resolves.toBe(true);
    const seeded = await pool.query<{ scopeType: string; requestCount: number; expiresAt: Date }>(
      `SELECT "scopeType", "requestCount", "expiresAt"
       FROM "requestAdmission"
       WHERE "action" = 'MIXED_ATOMICITY_TEST'`,
    );
    expect(seeded.rows).toEqual([
      { scopeType: "z-shared", requestCount: 1, expiresAt: new Date("2026-08-29T00:01:00Z") },
    ]);

    const decisions = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        limiter.consume(
          "MIXED_ATOMICITY_TEST",
          [
            { scopeType: "a-device", value: `device-${index}`, limit: 1, windowMs: 60_000 },
            { scopeType: "z-shared", value: "shared-requester", limit: 1, windowMs: 60_000 },
          ],
          now,
        ),
      ),
    );

    const rows = await pool.query<{ scopeType: string; requestCount: number }>(
      `SELECT "scopeType", "requestCount"
       FROM "requestAdmission"
       WHERE "action" = 'MIXED_ATOMICITY_TEST'
       ORDER BY "scopeType", "scopeHash"`,
    );
    expect(rows.rows).toEqual([{ scopeType: "z-shared", requestCount: 1 }]);
    expect(decisions).toEqual(Array.from({ length: 8 }, () => false));
    await expect(
      limiter.consume(
        "MIXED_ATOMICITY_TEST",
        [{ scopeType: "a-device", value: "device-0", limit: 1, windowMs: 60_000 }],
        now,
      ),
    ).resolves.toBe(true);
  });
});
