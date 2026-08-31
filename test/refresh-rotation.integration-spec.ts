import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { hashToken } from "src/common/security/token-hash";
import { FIXTURE } from "src/database/fixtures";
import { resetTestFixtures, testPool } from "./support/database";

const signinFo = (app: INestApplication, deviceId: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("x-device-id", deviceId)
    .send({
      query: `mutation SigninFo($input: SigninFoInput!) { signinFo(input: $input) { tokenPayload { refreshToken } } }`,
      variables: { input: { email: "integration@example.test", password: "IntegrationPassword123!" } },
    });

const refreshFo = (app: INestApplication, refreshToken: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("authorization", `Bearer ${refreshToken}`)
    .send({ query: `mutation Refresh { refresh { refreshToken } }` });

const logoutFo = (app: INestApplication, refreshToken: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("authorization", `Bearer ${refreshToken}`)
    .send({ query: `mutation Logout { logout }` });

describe("refresh rotation PostgreSQL integration", () => {
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

  it("rotates a refresh token exactly once under concurrent requests", async () => {
    const deviceId = "fo-refresh-device";
    const signedIn = await signinFo(app, deviceId);
    const refreshToken = signedIn.body.data.signinFo.tokenPayload.refreshToken as string;
    const refresh = () => refreshFo(app, refreshToken);

    const responses = await Promise.all([refresh(), refresh()]);
    const succeeded = responses.filter(({ body }) => body.errors === undefined);
    const rejected = responses.filter(({ body }) => body.errors !== undefined);

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.body.errors[0].extensions.code).toBe("CONFLICT");
    const currentRefreshToken = succeeded[0]?.body.data.refresh.refreshToken as string;
    expect(currentRefreshToken).not.toBe(refreshToken);
    const rotation = await pool.query<{
      coversBffEnvelope: boolean;
      currentRefreshToken: string;
      rotationKey: string;
      shortLived: boolean;
    }>(
      `SELECT
        marker."expiresAt" >= marker."createdAt" + interval '59 seconds' AS "coversBffEnvelope",
        marker."expiresAt" <= marker."createdAt" + interval '61 seconds' AS "shortLived",
        session."refreshToken" AS "currentRefreshToken",
        marker."rotationKey"
       FROM "refreshToken" session
       JOIN "refreshTokenRotationMarker" marker
         ON marker."userId" = session."userId" AND marker."deviceId" = session."deviceId"
       WHERE session."userId" = $1 AND session."deviceId" = $2`,
      [FIXTURE.userId, deviceId],
    );
    expect(rotation.rows[0]).toEqual({
      coversBffEnvelope: true,
      currentRefreshToken: hashToken(currentRefreshToken),
      rotationKey: hashToken(`${deviceId}\0${refreshToken}`),
      shortLived: true,
    });
    expect(rotation.rows[0]?.rotationKey).not.toContain(refreshToken);

    const staleLogout = await logoutFo(app, refreshToken);
    expect(staleLogout.body.errors[0].message).toBe("아이디 또는 비밀번호가 올바르지 않습니다.");
    const currentRefresh = await refreshFo(app, currentRefreshToken);
    expect(currentRefresh.body.errors).toBeUndefined();
  });

  it("classifies a predecessor older than the former ten-second window as transient", async () => {
    const deviceId = "fo-late-refresh-device";
    const signedIn = await signinFo(app, deviceId);
    const initialRefreshToken = signedIn.body.data.signinFo.tokenPayload.refreshToken as string;
    const rotated = await refreshFo(app, initialRefreshToken);
    expect(rotated.body.errors).toBeUndefined();
    await pool.query(
      `UPDATE "refreshTokenRotationMarker"
       SET "createdAt" = clock_timestamp() - interval '11 seconds',
           "expiresAt" = clock_timestamp() + interval '49 seconds'
       WHERE "userId" = $1 AND "deviceId" = $2 AND "rotationKey" = $3`,
      [FIXTURE.userId, deviceId, hashToken(`${deviceId}\0${initialRefreshToken}`)],
    );

    const lateReplay = await refreshFo(app, initialRefreshToken);

    expect(lateReplay.body.errors[0].extensions.code).toBe("CONFLICT");
  });

  it("rolls back the winning refresh CAS when predecessor insertion fails", async () => {
    const deviceId = "fo-atomic-refresh-device";
    const signedIn = await signinFo(app, deviceId);
    const refreshToken = signedIn.body.data.signinFo.tokenPayload.refreshToken as string;
    await pool.query(`
      CREATE FUNCTION reject_test_rotation_marker() RETURNS trigger AS $$
      BEGIN
        IF NEW."deviceId" = '${deviceId}' THEN
          RAISE EXCEPTION 'forced rotation marker failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_test_rotation_marker
      BEFORE INSERT ON "refreshTokenRotationMarker"
      FOR EACH ROW EXECUTE FUNCTION reject_test_rotation_marker();
    `);

    let failedRotation;
    try {
      failedRotation = await refreshFo(app, refreshToken);
    } finally {
      await pool.query(`
        DROP TRIGGER reject_test_rotation_marker ON "refreshTokenRotationMarker";
        DROP FUNCTION reject_test_rotation_marker();
      `);
    }

    expect(failedRotation.body.errors).toBeDefined();
    const session = await pool.query<{ refreshToken: string }>(
      `SELECT "refreshToken"
       FROM "refreshToken"
       WHERE "userId" = $1 AND "deviceId" = $2`,
      [FIXTURE.userId, deviceId],
    );
    expect(session.rows[0]?.refreshToken).toBe(hashToken(refreshToken));
    await expect(refreshFo(app, refreshToken)).resolves.toHaveProperty("body.data.refresh.refreshToken");
  });

  it("retains multiple predecessor generations without returning successor tokens", async () => {
    const deviceId = "fo-refresh-history-device";
    const signedIn = await signinFo(app, deviceId);
    const r0 = signedIn.body.data.signinFo.tokenPayload.refreshToken as string;
    const firstRotation = await refreshFo(app, r0);
    const r1 = firstRotation.body.data.refresh.refreshToken as string;
    const secondRotation = await refreshFo(app, r1);
    const r2 = secondRotation.body.data.refresh.refreshToken as string;

    const delayedR0 = await refreshFo(app, r0);

    expect(delayedR0.body.data).toBeNull();
    expect(delayedR0.body.errors[0].extensions.code).toBe("CONFLICT");
    const markers = await pool.query<{ rotationKey: string }>(
      `SELECT "rotationKey"
       FROM "refreshTokenRotationMarker"
       WHERE "userId" = $1 AND "deviceId" = $2
       ORDER BY "rotationKey"`,
      [FIXTURE.userId, deviceId],
    );
    expect(markers.rows.map(({ rotationKey }) => rotationKey).sort()).toEqual(
      [hashToken(`${deviceId}\0${r0}`), hashToken(`${deviceId}\0${r1}`)].sort(),
    );
    expect(markers.rows.every(({ rotationKey }) => !rotationKey.includes(r0) && !rotationKey.includes(r1))).toBe(true);
    expect(r2).not.toBe(r1);
  });

  it("clears predecessor history when the current session is revoked", async () => {
    const deviceId = "fo-revoked-refresh-device";
    const signedIn = await signinFo(app, deviceId);
    const r0 = signedIn.body.data.signinFo.tokenPayload.refreshToken as string;
    const firstRotation = await refreshFo(app, r0);
    const r1 = firstRotation.body.data.refresh.refreshToken as string;

    const logout = await logoutFo(app, r1);
    const revokedReplay = await refreshFo(app, r0);

    expect(logout.body).toEqual({ data: { logout: true } });
    expect(revokedReplay.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
    const markers = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM "refreshTokenRotationMarker"
       WHERE "userId" = $1 AND "deviceId" = $2`,
      [FIXTURE.userId, deviceId],
    );
    expect(markers.rows[0]?.count).toBe(0);
  });

  it("clears predecessor history when sign-in replaces the device session", async () => {
    const deviceId = "fo-replaced-refresh-device";
    const signedIn = await signinFo(app, deviceId);
    const r0 = signedIn.body.data.signinFo.tokenPayload.refreshToken as string;
    const firstRotation = await refreshFo(app, r0);
    expect(firstRotation.body.errors).toBeUndefined();
    await pool.query(
      `UPDATE "refreshToken"
       SET "updatedAt" = clock_timestamp() - interval '2 seconds'
       WHERE "userId" = $1 AND "deviceId" = $2`,
      [FIXTURE.userId, deviceId],
    );

    const replacement = await signinFo(app, deviceId);
    const replacedReplay = await refreshFo(app, r0);

    expect(replacement.body.errors).toBeUndefined();
    expect(replacedReplay.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");
    const markers = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM "refreshTokenRotationMarker"
       WHERE "userId" = $1 AND "deviceId" = $2`,
      [FIXTURE.userId, deviceId],
    );
    expect(markers.rows[0]?.count).toBe(0);
  });

  it("cleans expired predecessor history in batches of at most 100", async () => {
    const deviceId = "fo-refresh-cleanup-device";
    const signedIn = await signinFo(app, deviceId);
    const r0 = signedIn.body.data.signinFo.tokenPayload.refreshToken as string;
    await pool.query(
      `INSERT INTO "refreshTokenRotationMarker" ("userId", "deviceId", "rotationKey", "expiresAt")
       SELECT $1, $2, encode(sha256(('expired-' || value)::bytea), 'hex'), clock_timestamp() - interval '1 second'
       FROM generate_series(1, 101) AS value`,
      [FIXTURE.userId, deviceId],
    );

    const firstRotation = await refreshFo(app, r0);
    const r1 = firstRotation.body.data.refresh.refreshToken as string;
    const afterFirst = await pool.query<{ active: number; expired: number }>(
      `SELECT
         count(*) FILTER (WHERE "expiresAt" > clock_timestamp())::int AS active,
         count(*) FILTER (WHERE "expiresAt" <= clock_timestamp())::int AS expired
       FROM "refreshTokenRotationMarker"
       WHERE "userId" = $1 AND "deviceId" = $2`,
      [FIXTURE.userId, deviceId],
    );
    expect(afterFirst.rows[0]).toEqual({ active: 1, expired: 1 });

    await refreshFo(app, r1);
    const afterSecond = await pool.query<{ active: number; expired: number }>(
      `SELECT
         count(*) FILTER (WHERE "expiresAt" > clock_timestamp())::int AS active,
         count(*) FILTER (WHERE "expiresAt" <= clock_timestamp())::int AS expired
       FROM "refreshTokenRotationMarker"
       WHERE "userId" = $1 AND "deviceId" = $2`,
      [FIXTURE.userId, deviceId],
    );
    expect(afterSecond.rows[0]).toEqual({ active: 2, expired: 0 });
  });
});
