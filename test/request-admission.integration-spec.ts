import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { createApp } from "src/app";
import { AdmissionLimiter } from "src/modules/admission/admission-limiter";
import { resetTestFixtures, testPool } from "./support/database";

describe("Request admission PostgreSQL integration", () => {
  let app: INestApplication;
  let limiter: AdmissionLimiter;
  let pool: Pool;

  beforeAll(async () => {
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
  });

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
