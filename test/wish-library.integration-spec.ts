import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";

import { createApp } from "src/app";
import { FIXTURE } from "src/database/fixtures";
import { migrateTestDatabase, resetTestFixtures, testPool } from "./support/database";

const signin = async (app: INestApplication) => {
  const response = await request(app.getHttpServer())
    .post("/graphql")
    .set("x-device-id", "wish-library-device")
    .send({
      query: `mutation Signin($input: SigninAuthInput!) {
        signin(input: $input) { accessToken }
      }`,
      variables: {
        input: { userid: FIXTURE.userid, password: FIXTURE.password, portal: "FO" },
      },
    });

  expect(response.body.errors).toBeUndefined();
  return response.body.data.signin.accessToken;
};

describe("WISH library GraphQL integration", () => {
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

  it("requires authentication and isolates followed brands", async () => {
    const unauthenticated = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: "{ followedBrands { brandId } }" });
    expect(unauthenticated.body.errors).toHaveLength(1);

    const otherUserId = "10000000-0000-4000-8000-000000000010";
    const otherBrandId = "40000000-0000-4000-8000-000000000010";
    await pool.query(
      `INSERT INTO "users" ("userId", "userid", "email", "password") VALUES ($1, 'other-wish-user', 'other-wish-user@example.test', 'x')`,
      [otherUserId],
    );
    await pool.query(`INSERT INTO "brands" ("brandId", "name", "slug") VALUES ($1, 'Other Brand', 'other-brand')`, [
      otherBrandId,
    ]);
    await pool.query(`INSERT INTO "brandFollows" ("userId", "brandId") VALUES ($1, $2)`, [otherUserId, otherBrandId]);

    const token = await signin(app);
    const auth = { Authorization: `Bearer ${token}` };
    const follow = `mutation { followBrand(brandId: "${FIXTURE.brandId}") { brandId name } }`;
    const first = await request(app.getHttpServer()).post("/graphql").set(auth).send({ query: follow });
    const duplicate = await request(app.getHttpServer()).post("/graphql").set(auth).send({ query: follow });
    expect(first.body.data.followBrand.brandId).toBe(FIXTURE.brandId);
    expect(duplicate.body.data.followBrand.brandId).toBe(FIXTURE.brandId);

    const followed = await request(app.getHttpServer())
      .post("/graphql")
      .set(auth)
      .send({ query: "{ followedBrands { brandId name } }" });
    expect(followed.body.data.followedBrands).toEqual([{ brandId: FIXTURE.brandId, name: "Integration Brand" }]);

    const unfollowed = await request(app.getHttpServer())
      .post("/graphql")
      .set(auth)
      .send({ query: `mutation { unfollowBrand(brandId: "${FIXTURE.brandId}") }` });
    expect(unfollowed.body.data.unfollowBrand).toBe(true);
  });

  it("lists liked styles and keeps recently viewed products within retention limits", async () => {
    const stylePostIds = ["82000000-0000-4000-8000-000000000010", "82000000-0000-4000-8000-000000000011"];
    await pool.query(
      `INSERT INTO "stylePosts" ("stylePostId", "authorId", "title", "content", "createdAt", "updatedAt") VALUES
        ($1, $3, 'Saved style', 'Saved style content', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
        ($2, $3, 'Older saved style', 'Older saved style content', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [...stylePostIds, FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "stylePostLikes" ("stylePostId", "userId", "createdAt") VALUES
        ($1, $3, '2026-01-03T00:00:00Z'),
        ($2, $3, '2026-01-02T00:00:00Z')`,
      [...stylePostIds, FIXTURE.userId],
    );

    const token = await signin(app);
    const auth = { Authorization: `Bearer ${token}` };
    const liked = await request(app.getHttpServer())
      .post("/graphql")
      .set(auth)
      .send({ query: "{ likedStylePosts(first: 1) { nodes { stylePostId isLiked } nextCursor hasNextPage } }" });
    expect(liked.body.data.likedStylePosts.nodes).toEqual([{ stylePostId: stylePostIds[0], isLiked: true }]);
    expect(liked.body.data.likedStylePosts.hasNextPage).toBe(true);
    const likedNext = await request(app.getHttpServer())
      .post("/graphql")
      .set(auth)
      .send({
        query:
          "query LikedStyles($after: String) { likedStylePosts(first: 1, after: $after) { nodes { stylePostId isLiked } hasNextPage } }",
        variables: { after: liked.body.data.likedStylePosts.nextCursor },
      });
    expect(likedNext.body.data.likedStylePosts.nodes).toEqual([{ stylePostId: stylePostIds[1], isLiked: true }]);
    expect(likedNext.body.data.likedStylePosts.hasNextPage).toBe(false);

    await request(app.getHttpServer())
      .post("/graphql")
      .set(auth)
      .send({ query: `mutation { recordRecentProductView(productId: "${FIXTURE.secondProductId}") }` });
    await pool.query(`UPDATE "recentProductViews" SET "viewedAt" = now() - interval '31 days' WHERE "userId" = $1`, [
      FIXTURE.userId,
    ]);
    await request(app.getHttpServer())
      .post("/graphql")
      .set(auth)
      .send({ query: `mutation { recordRecentProductView(productId: "${FIXTURE.productId}") }` });
    const expiredViews = await pool.query<{ count: string }>(
      `SELECT count(*) FROM "recentProductViews" WHERE "userId" = $1 AND "productId" = $2`,
      [FIXTURE.userId, FIXTURE.secondProductId],
    );
    expect(Number(expiredViews.rows[0]?.count)).toBe(0);

    await pool.query(
      `WITH insertedProducts AS (
        INSERT INTO "products" ("productId", "partnerId", "brandId", "categoryId", "title", "description", "status", "approvalStatus", "publishedAt")
        SELECT gen_random_uuid(), $1, $2, $3, concat('Recent product ', value), 'Recent product', 'PUBLISHED', 'APPROVED', now()
        FROM generate_series(1, 51) AS value
        RETURNING "productId"
      )
      INSERT INTO "recentProductViews" ("userId", "productId", "viewedAt")
      SELECT $4, "productId", now() - interval '1 hour'
      FROM insertedProducts`,
      [FIXTURE.partnerId, FIXTURE.brandId, FIXTURE.categoryId, FIXTURE.userId],
    );
    await request(app.getHttpServer())
      .post("/graphql")
      .set(auth)
      .send({ query: `mutation { recordRecentProductView(productId: "${FIXTURE.productId}") }` });

    const recent = await request(app.getHttpServer())
      .post("/graphql")
      .set(auth)
      .send({ query: "{ recentlyViewedProducts { productId product { productId } } }" });
    expect(recent.body.data.recentlyViewedProducts).toHaveLength(50);
    expect(recent.body.data.recentlyViewedProducts[0]).toEqual({
      productId: FIXTURE.productId,
      product: { productId: FIXTURE.productId },
    });
    const viewRows = await pool.query<{ count: string }>(
      `SELECT count(*) FROM "recentProductViews" WHERE "userId" = $1`,
      [FIXTURE.userId],
    );
    const duplicateViews = await pool.query<{ count: string }>(
      `SELECT count(*) FROM "recentProductViews" WHERE "userId" = $1 AND "productId" = $2`,
      [FIXTURE.userId, FIXTURE.productId],
    );
    expect(Number(viewRows.rows[0]?.count)).toBe(50);
    expect(Number(duplicateViews.rows[0]?.count)).toBe(1);
  });

  it("runs the WISH library migration idempotently", async () => {
    await migrateTestDatabase(pool);
    await migrateTestDatabase(pool);
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('brandFollows', 'recentProductViews')`,
    );
    expect(tables.rows.map((row) => row.tablename).sort()).toEqual(["brandFollows", "recentProductViews"]);
  });
});
