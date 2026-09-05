import { CopyObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import sharp from "sharp";
import { createApp } from "src/app";
import { FIXTURE } from "src/database/fixtures";
import { migrateTestDatabase, resetTestFixtures, testPool } from "./support/database";

let jpegBytes: Buffer;

const styleImageObject = (bytes = jpegBytes) => {
  let destination: { key: string; metadata: Record<string, string> } | undefined;
  return async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const promoted = destination;
      if (promoted && promoted.key === command.input.Key)
        return {
          ContentType: "image/jpeg",
          ContentLength: bytes.byteLength,
          Metadata: promoted.metadata,
          ETag: '"copied-style-etag"',
        };
      if (/\/[0-9a-f]{64}\./.test(command.input.Key ?? ""))
        throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
      return {
        ContentType: "image/jpeg",
        ContentLength: bytes.byteLength,
        Metadata: {
          "owner-id": FIXTURE.userId,
          "declared-content-type": "image/jpeg",
          "declared-size": String(bytes.byteLength),
        },
        ETag: '"style-etag"',
      };
    }
    if (command instanceof GetObjectCommand)
      return {
        ContentType: "image/jpeg",
        ContentLength: bytes.byteLength,
        ETag: destination?.key === command.input.Key ? '"copied-style-etag"' : '"style-etag"',
        Body: { transformToByteArray: async () => bytes },
      };
    if (command instanceof CopyObjectCommand) {
      if (!command.input.Key) throw new Error("Copy destination is required");
      destination = { key: command.input.Key, metadata: command.input.Metadata ?? {} };
      return { CopyObjectResult: { ETag: '"copied-style-etag"' } };
    }
    throw new Error("Unexpected storage command");
  };
};

const signin = async (agent: ReturnType<typeof request.agent>) => {
  const response = await agent
    .post("/graphql")
    .set("x-device-id", "integration-device")
    .send({
      query: `mutation Signin($input: SigninAuthInput!) {
        signin(input: $input) { accessToken role }
      }`,
      variables: {
        input: { userid: FIXTURE.userid, password: FIXTURE.password, portal: "FO" },
      },
    });
  expect(response.body.errors).toBeUndefined();
  expect(response.status).toBe(200);
  return response.body.data.signin.accessToken;
};

const waitForAdvisoryWaiters = async (pool: Pool, expected: number) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event = 'advisory'`,
    );
    if ((result.rows[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} advisory lock waiters`);
};

const checkoutState = async (pool: Pool) => {
  const state = await pool.query<{ snapshot: Record<string, unknown> }>(
    `SELECT jsonb_build_object(
      'orders', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row."orderId"), '[]'::jsonb) FROM "orders" row),
      'orderItems', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row."orderItemId"), '[]'::jsonb) FROM "orderItems" row),
      'carts', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row."cartId"), '[]'::jsonb) FROM "carts" row),
      'cartItems', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row."cartItemId"), '[]'::jsonb) FROM "cartItems" row),
      'checkoutIdempotencyKeys', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row."checkoutIdempotencyKeyId"), '[]'::jsonb) FROM "checkoutIdempotencyKeys" row),
      'activityEvents', (SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row."eventId"), '[]'::jsonb) FROM "activityEvents" row)
    ) AS snapshot`,
  );
  return state.rows[0]?.snapshot;
};

describe("PostgreSQL GraphQL integration", () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    jpegBytes = await sharp({
      create: { width: 4, height: 3, channels: 4, background: "#ff00ffff" },
    })
      .jpeg()
      .toBuffer();
    pool = testPool();
    app = await createApp();
    await app.init();
  });

  beforeEach(async () => {
    await resetTestFixtures(pool);
    jest.spyOn(S3Client.prototype, "send").mockImplementation(styleImageObject() as never);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("bounds style list thumbnails while preserving detail images", async () => {
    const stylePostId = "82000000-0000-4000-8000-000000000010";
    const imageKey = `style-posts/${FIXTURE.userId}/00000000-0000-4000-8000-000000000010.webp`;
    const fullSizeUrl = `http://localhost/images/format=auto,fit=scale-down/http://localhost/r2/${imageKey}`;
    await pool.query(
      `INSERT INTO "stylePosts"
        ("stylePostId", "authorId", "title", "content", "category", "imageKeys", "imageUrls")
       VALUES ($1, $2, 'Bounded thumbnail', 'Bounded thumbnail', 'CLOTHING', $3::jsonb, $4::jsonb)`,
      [stylePostId, FIXTURE.userId, JSON.stringify([imageKey]), JSON.stringify([fullSizeUrl])],
    );

    const summary = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `{ stylePosts(filter: { sort: LATEST }) { nodes { stylePostId thumbnailUrl } } }` })
      .expect(200);
    const detail = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `{ stylePost(stylePostId: "${stylePostId}") { imageUrls } }` })
      .expect(200);

    expect(summary.body.errors).toBeUndefined();
    expect(summary.body.data.stylePosts.nodes[0]).toEqual({
      stylePostId,
      thumbnailUrl: `https://images.example.test/cdn-cgi/image/format=auto,width=640/http://localhost/r2/${imageKey}`,
    });
    expect(detail.body.data.stylePost.imageUrls).toEqual([fullSizeUrl]);
  });

  it("runs all migrations initially and idempotently", async () => {
    const before = await pool.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM "_migrations" ORDER BY name`,
    );
    await migrateTestDatabase(pool);
    await migrateTestDatabase(pool);
    const after = await pool.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM "_migrations" ORDER BY name`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("exposes uppercase auth portal enum names used by clients", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `{ __type(name: "AuthPortal") { enumValues { name } } }` })
      .expect(200);

    expect(response.body.data.__type.enumValues.map(({ name }: { name: string }) => name).sort()).toEqual([
      "BO",
      "FO",
      "PARTNER",
    ]);
  });

  it("signs in, resolves me, refreshes, and logs out", async () => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const me = await agent
      .post("/graphql")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ query: `{ me { userId userid role } }` })
      .expect(200);
    expect(me.body.data.me).toEqual({ userId: FIXTURE.userId, userid: FIXTURE.userid, role: "USER" });
    const refresh = await agent
      .post("/graphql")
      .send({ query: `mutation { refresh { accessToken role } }` })
      .expect(200);
    expect(refresh.body.errors).toBeUndefined();
    const logout = await agent.post("/graphql").send({ query: `mutation { logout }` }).expect(200);
    expect(logout.body.data.logout).toBe(true);
    const rejected = await agent.post("/graphql").send({ query: `mutation { refresh { accessToken } }` }).expect(200);
    expect(rejected.body.errors).toHaveLength(1);
  });

  it("rejects GraphQL documents that exceed the request budget", async () => {
    const aliases = Array.from({ length: 21 }, (_, index) => `field${index}: __typename`).join("\n");
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `query Oversized { ${aliases} }` })
      .expect(400);

    expect(response.body.errors[0]).toMatchObject({
      message: "GraphQL operation exceeds the request budget",
      extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
    });
  });

  it("keeps intentional portfolio roots and omits legacy password-reset links", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `query ApiFields {
        __schema {
          queryType { fields { name } }
          mutationType { fields { name } }
        }
      }`,
      });
    const queryFields = response.body.data.__schema.queryType.fields.map((field: { name: string }) => field.name);
    const mutationFields = response.body.data.__schema.mutationType.fields.map((field: { name: string }) => field.name);

    expect(queryFields).toEqual(expect.arrayContaining(["comparison", "comparisonPriceSummaries", "myActivity"]));
    expect(mutationFields).toEqual(
      expect.arrayContaining(["addComparisonItem", "removeComparisonItem", "applyPartner", "updateMarketingConsent"]),
    );
    expect(mutationFields).not.toContain("requestPasswordReset");
    expect(mutationFields).not.toContain("recordActivity");
  });

  it("does not expose duplicate media or push-device roots", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `query ApiFields {
      __schema {
        queryType { fields { name } }
        mutationType { fields { name } }
      }
    }`,
      });
    const queryFields = response.body.data.__schema.queryType.fields.map((field: { name: string }) => field.name);
    const mutationFields = response.body.data.__schema.mutationType.fields.map((field: { name: string }) => field.name);

    expect(queryFields).not.toContain("productImageUrl");
    expect(mutationFields).not.toContain("unregisterFoPushDevice");
  });

  it("classifies malformed database identifiers as client input errors", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `query InvalidProduct { product(productId: "not-a-uuid") { productId } }` })
      .expect(200);

    expect(response.body.errors[0]).toMatchObject({
      message: "Invalid identifier",
      extensions: { code: "BAD_USER_INPUT" },
    });
  });

  it("filters and paginates catalog products with stable cursors", async () => {
    const first = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `query Products($filter: ProductFilterInput) {
          products(filter: $filter) { nodes { productId title isOnSale skus { skuId price stock } } nextCursor hasNextPage totalCount }
        }`,
        variables: { filter: { saleOnly: true, first: 1 } },
      })
      .expect(200);
    expect(first.body.data.products.nodes).toHaveLength(1);
    expect(first.body.data.products.nodes[0].productId).toBe(FIXTURE.productId);
    const page = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `query Products($filter: ProductFilterInput) {
          products(filter: $filter) { nodes { productId } nextCursor hasNextPage totalCount }
        }`,
        variables: { filter: { first: 1 } },
      })
      .expect(200);
    const next = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `query Products($filter: ProductFilterInput) { products(filter: $filter) { nodes { productId } } }`,
        variables: { filter: { first: 1, after: page.body.data.products.nextCursor } },
      })
      .expect(200);
    expect(page.body.data.products).toMatchObject({ hasNextPage: true, totalCount: 2 });
    expect(next.body.data.products.nodes[0].productId).toBe(FIXTURE.secondProductId);
    const product = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `{ product(productId: "${FIXTURE.productId}") { productId title skus { code } } }` })
      .expect(200);
    expect(product.body.data.product.productId).toBe(FIXTURE.productId);
  });

  it("validates purchased style products, persists posts idempotently, and toggles likes", async () => {
    const publicFeed = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `query { stylePosts(filter: { sort: LATEST }) { nodes { stylePostId } } }` })
      .expect(200);
    expect(publicFeed.body.data.stylePosts.nodes).toEqual([]);

    const unauthenticatedCreate = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `mutation Create($input: CreateStylePostInput!) { createStylePost(input: $input) { stylePostId } }`,
        variables: {
          input: {
            category: "CLOTHING",
            productIds: [FIXTURE.productId],
            imageKeys: [`style-posts/${FIXTURE.userId}/00000000-0000-4000-8000-000000000001.jpg`],
            content: "로그인 필요",
            idempotencyKey: "unauthenticated-style",
          },
        },
      });
    expect(unauthenticatedCreate.body.errors).toHaveLength(1);

    await pool.query(
      `INSERT INTO "orders" ("orderId", "orderNumber", "userId", "status", "paymentStatus", "totalAmount") VALUES ($1, $2, $3, 'PAID', 'APPROVED', 15000)`,
      ["90000000-0000-4000-8000-000000000001", "DJ-STYLE-001", FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "orderItems" ("orderItemId", "orderId", "productId", "skuId", "productTitle", "skuOptionName", "unitPrice", "quantity") VALUES ($1, $2, $3, $4, $5, 'Black / M', 15000, 1)`,
      [
        "91000000-0000-4000-8000-000000000001",
        "90000000-0000-4000-8000-000000000001",
        FIXTURE.productId,
        FIXTURE.skuId,
        "Integration Sale Tee",
      ],
    );

    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const auth = { Authorization: `Bearer ${accessToken}` };
    const purchased = await agent
      .post("/graphql")
      .set(auth)
      .send({ query: `{ purchasedStyleProducts { productId brandId brandName lastPurchasedAt } }` })
      .expect(200);
    expect(purchased.body.data.purchasedStyleProducts).toHaveLength(1);
    expect(purchased.body.data.purchasedStyleProducts[0].productId).toBe(FIXTURE.productId);

    const createMutation = `mutation Create($input: CreateStylePostInput!) {
      createStylePost(input: $input) { stylePostId category content hashtags brandTags { brandId name } products { productId } likeCount isLiked }
    }`;
    const invalidPurchase = await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: createMutation,
        variables: {
          input: {
            category: "CLOTHING",
            productIds: [FIXTURE.secondProductId],
            imageKeys: [`style-posts/${FIXTURE.userId}/00000000-0000-4000-8000-000000000002.jpg`],
            content: "구매하지 않은 상품",
            idempotencyKey: "invalid-style",
          },
        },
      });
    expect(invalidPurchase.body.errors).toHaveLength(1);

    const invalidImage = await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: createMutation,
        variables: {
          input: {
            category: "CLOTHING",
            productIds: [FIXTURE.productId],
            imageKeys: [`style-posts/${FIXTURE.userId}/look.webp`],
            content: "잘못된 이미지 키",
            idempotencyKey: "invalid-style-image",
          },
        },
      });
    expect(invalidImage.body.errors[0].message).toBe("Style post image key is invalid");
    const feedAfterInvalidImage = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `{ stylePosts(filter: { sort: LATEST }) { nodes { stylePostId } } }` })
      .expect(200);
    expect(feedAfterInvalidImage.body.data.stylePosts.nodes).toEqual([]);

    jest
      .mocked(S3Client.prototype.send)
      .mockImplementation(
        styleImageObject(
          Buffer.from([...Buffer.from("%PDF", "ascii"), ...Array.from({ length: 60 }, () => 0)]),
        ) as never,
      );
    const invalidMagic = await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: createMutation,
        variables: {
          input: {
            category: "CLOTHING",
            productIds: [FIXTURE.productId],
            imageKeys: [`style-posts/${FIXTURE.userId}/00000000-0000-4000-8000-000000000003.jpg`],
            content: "이미지가 아닌 바이트",
            idempotencyKey: "invalid-style-magic",
          },
        },
      });
    expect(invalidMagic.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    jest.mocked(S3Client.prototype.send).mockImplementation(styleImageObject() as never);

    const input = {
      category: "CLOTHING",
      productIds: [FIXTURE.productId],
      imageKeys: [`pending/style-posts/${FIXTURE.userId}/00000000-0000-4000-8000-000000000001.jpg`],
      content: "오늘의 스타일",
      hashtags: ["daily_look"],
      brandTagIds: [FIXTURE.brandId],
      idempotencyKey: "style-create-1",
    };
    const first = await agent.post("/graphql").set(auth).send({ query: createMutation, variables: { input } });
    const repeated = await agent.post("/graphql").set(auth).send({ query: createMutation, variables: { input } });
    expect(first.body.errors).toBeUndefined();
    expect(repeated.body.data.createStylePost.stylePostId).toBe(first.body.data.createStylePost.stylePostId);
    expect(first.body.data.createStylePost).toMatchObject({
      category: "CLOTHING",
      content: "오늘의 스타일",
      hashtags: ["daily_look"],
      likeCount: 0,
      isLiked: false,
    });
    const storedImages = await pool.query<{ imageKeys: string[] }>(
      `SELECT "imageKeys" FROM "stylePosts" WHERE "stylePostId" = $1`,
      [first.body.data.createStylePost.stylePostId],
    );
    expect(storedImages.rows[0]?.imageKeys).toEqual([
      expect.stringMatching(/^style-posts\/10000000-0000-4000-8000-000000000001\/[0-9a-f]{64}\.jpg$/),
    ]);
    const references = await pool.query<{ finalKey: string; status: string }>(
      `SELECT r."finalKey", p."status"
       FROM "mediaObjectReferences" r
       JOIN "mediaObjectPromotions" p ON p."finalKey" = r."finalKey"
       WHERE r."entityType" = 'STYLE_POST' AND r."entityId" = $1`,
      [first.body.data.createStylePost.stylePostId],
    );
    expect(references.rows).toEqual([{ finalKey: storedImages.rows[0]?.imageKeys[0], status: "READY" }]);

    const invalidCursor = Buffer.from(
      JSON.stringify({
        category: null,
        sort: "LATEST",
        sortValue: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        stylePostId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      }),
    ).toString("base64url");
    const rejectedCursor = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: `query StylePosts($filter: StylePostFilterInput, $first: Int, $after: String) {
          stylePosts(filter: $filter, first: $first, after: $after) { nodes { stylePostId } }
        }`,
        variables: { filter: { sort: "LATEST" }, first: 1, after: invalidCursor },
      })
      .expect(200);
    expect(rejectedCursor.body.errors[0].message).toBe("Invalid style post cursor");

    const stylePostId = first.body.data.createStylePost.stylePostId;
    const viewerPost = await agent
      .post("/graphql")
      .set(auth)
      .send({ query: `{ stylePost(stylePostId: "${stylePostId}") { isLiked likeCount } }` })
      .expect(200);
    expect(viewerPost.body.data.stylePost).toEqual({ isLiked: false, likeCount: 0 });
    const likeMutation = `mutation { likeStylePost(stylePostId: "${stylePostId}") { likeCount isLiked } }`;
    const liked = await agent.post("/graphql").set(auth).send({ query: likeMutation });
    const repeatedLike = await agent.post("/graphql").set(auth).send({ query: likeMutation });
    expect(liked.body.data.likeStylePost).toEqual({ likeCount: 1, isLiked: true });
    expect(repeatedLike.body.data.likeStylePost).toEqual({ likeCount: 1, isLiked: true });
    const likedViewerPost = await agent
      .post("/graphql")
      .set(auth)
      .send({ query: `{ stylePost(stylePostId: "${stylePostId}") { isLiked likeCount } }` })
      .expect(200);
    expect(likedViewerPost.body.data.stylePost).toEqual({ isLiked: true, likeCount: 1 });

    const unlikeMutation = `mutation { unlikeStylePost(stylePostId: "${stylePostId}") { likeCount isLiked } }`;
    const unliked = await agent.post("/graphql").set(auth).send({ query: unlikeMutation });
    const repeatedUnlike = await agent.post("/graphql").set(auth).send({ query: unlikeMutation });
    expect(unliked.body.data.unlikeStylePost).toEqual({ likeCount: 0, isLiked: false });
    expect(repeatedUnlike.body.data.unlikeStylePost).toEqual({ likeCount: 0, isLiked: false });
    const reliked = await agent.post("/graphql").set(auth).send({ query: likeMutation });
    expect(reliked.body.data.likeStylePost).toEqual({ likeCount: 1, isLiked: true });
  });

  it("preserves a later unlike when an earlier like is delayed", async () => {
    const stylePostId = "82000000-0000-4000-8000-000000000099";
    await pool.query(
      `INSERT INTO "stylePosts" ("stylePostId", "authorId", title, content, category)
       VALUES ($1, $2, 'Concurrent like', 'Concurrent like', 'CLOTHING')`,
      [stylePostId, FIXTURE.userId],
    );
    const accessToken = await signin(request.agent(app.getHttpServer()));
    const blocker = await pool.connect();
    const requests: Promise<request.Response>[] = [];
    let released = false;
    try {
      await pool.query(`
        CREATE FUNCTION delay_test_style_like_insert() RETURNS trigger AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(91001, 1);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
        CREATE TRIGGER delay_test_style_like_insert
        BEFORE INSERT ON "stylePostLikes"
        FOR EACH ROW EXECUTE FUNCTION delay_test_style_like_insert();
      `);
      await blocker.query(`SELECT pg_advisory_lock(91001, 1)`);
      const likeRequest = request(app.getHttpServer())
        .post("/graphql")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ query: `mutation { likeStylePost(stylePostId: "${stylePostId}") { isLiked } }` })
        .then((response) => response);
      requests.push(likeRequest);
      await waitForAdvisoryWaiters(pool, 1);
      const unlikeRequest = request(app.getHttpServer())
        .post("/graphql")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ query: `mutation { unlikeStylePost(stylePostId: "${stylePostId}") { isLiked } }` })
        .then((response) => response);
      requests.push(unlikeRequest);
      await Promise.race([unlikeRequest, waitForAdvisoryWaiters(pool, 2)]);
      await blocker.query(`SELECT pg_advisory_unlock(91001, 1)`);
      released = true;
      const [liked, unliked] = await Promise.all(requests);
      expect(liked?.body.errors).toBeUndefined();
      expect(unliked?.body.errors).toBeUndefined();
      const state = await pool.query<{ active_likes: number }>(
        `SELECT count(*)::int AS active_likes
         FROM "stylePostLikes"
         WHERE "stylePostId" = $1 AND "userId" = $2 AND "deletedAt" IS NULL`,
        [stylePostId, FIXTURE.userId],
      );
      expect(state.rows[0]?.active_likes).toBe(0);
    } finally {
      if (!released) await blocker.query(`SELECT pg_advisory_unlock(91001, 1)`).catch(() => undefined);
      await Promise.allSettled(requests);
      blocker.release();
      await pool.query(`
        DROP TRIGGER IF EXISTS delay_test_style_like_insert ON "stylePostLikes";
        DROP FUNCTION IF EXISTS delay_test_style_like_insert();
      `);
    }
  });

  it("notifies only a new non-self style like and lifetime-dedupes re-likes", async () => {
    const authorUserId = "10000000-0000-4000-8000-000000000099";
    const stylePostId = "82000000-0000-4000-8000-000000000091";
    const selfStylePostId = "82000000-0000-4000-8000-000000000092";
    await pool.query(
      `INSERT INTO "users" ("userId", userid, email, password)
       VALUES ($1, 'style-author', 'style-author@example.test', 'x')`,
      [authorUserId],
    );
    await pool.query(
      `INSERT INTO "stylePosts" ("stylePostId", "authorId", title, content, category)
       VALUES
         ($1, $3, 'Other style', 'Other style', 'CLOTHING'),
         ($2, $4, 'Self style', 'Self style', 'CLOTHING')`,
      [stylePostId, selfStylePostId, authorUserId, FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "pushDevices" ("userId", "installationId", "expoPushToken", platform)
       VALUES ($1, 'style-author-device', 'ExponentPushToken[style-author-device]', 'IOS')`,
      [authorUserId],
    );
    const accessToken = await signin(request.agent(app.getHttpServer()));
    const auth = { Authorization: `Bearer ${accessToken}` };
    const like = (postId: string) =>
      request(app.getHttpServer())
        .post("/graphql")
        .set(auth)
        .send({ query: `mutation { likeStylePost(stylePostId: "${postId}") { isLiked } }` });
    const unlike = (postId: string) =>
      request(app.getHttpServer())
        .post("/graphql")
        .set(auth)
        .send({ query: `mutation { unlikeStylePost(stylePostId: "${postId}") { isLiked } }` });
    const notificationCount = async (userId: string, dedupeKey: string) => {
      const result = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM "notifications" WHERE "userId" = $1 AND "dedupeKey" = $2`,
        [userId, dedupeKey],
      );
      return result.rows[0]?.count;
    };
    const dedupeKey = `style-like:${stylePostId}:${FIXTURE.userId}`;

    expect((await like(stylePostId)).body.errors).toBeUndefined();
    expect(await notificationCount(authorUserId, dedupeKey)).toBe(1);
    expect((await like(stylePostId)).body.errors).toBeUndefined();
    expect(await notificationCount(authorUserId, dedupeKey)).toBe(1);
    expect((await unlike(stylePostId)).body.errors).toBeUndefined();
    expect(await notificationCount(authorUserId, dedupeKey)).toBe(1);
    expect((await like(stylePostId)).body.errors).toBeUndefined();
    expect(await notificationCount(authorUserId, dedupeKey)).toBe(1);
    expect((await like(selfStylePostId)).body.errors).toBeUndefined();
    expect(await notificationCount(FIXTURE.userId, `style-like:${selfStylePostId}:${FIXTURE.userId}`)).toBe(0);

    const delivered = await pool.query<{
      body: string;
      outboxCount: number;
      route: string;
      title: string;
      type: string;
    }>(
      `SELECT n.type, n.title, n.body, n.route, count(o."pushOutboxId")::int AS "outboxCount"
       FROM "notifications" n
       LEFT JOIN "pushOutbox" o ON o."notificationId" = n."notificationId"
       WHERE n."userId" = $1 AND n."dedupeKey" = $2
       GROUP BY n."notificationId"`,
      [authorUserId, dedupeKey],
    );
    expect(delivered.rows).toEqual([
      {
        type: "STYLE_LIKE",
        title: "스타일에 좋아요가 달렸어요",
        body: "내 스타일 게시물을 확인해 보세요.",
        route: `/style/${stylePostId}`,
        outboxCount: 1,
      },
    ]);
  });

  it("paginates style posts with category and sort-aware cursors", async () => {
    const postIds = [
      "82000000-0000-4000-8000-000000000001",
      "82000000-0000-4000-8000-000000000002",
      "82000000-0000-4000-8000-000000000003",
    ];
    await pool.query(
      `INSERT INTO "stylePosts" ("stylePostId", "authorId", "title", "content", "category", "createdAt", "updatedAt") VALUES
        ($1, $4, 'Older', 'Older style', 'CLOTHING', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ($2, $4, 'Middle', 'Middle style', 'CLOTHING', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
        ($3, $4, 'Newest', 'Newest style', 'CLOTHING', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z')`,
      [...postIds, FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "users" ("userId", "userid", "email", "password") VALUES
        ('10000000-0000-4000-8000-000000000002', 'style-liker-2', 'style-liker-2@example.test', 'x'),
        ('10000000-0000-4000-8000-000000000003', 'style-liker-3', 'style-liker-3@example.test', 'x')`,
    );
    await pool.query(
      `INSERT INTO "stylePostLikes" ("stylePostId", "userId") VALUES
        ($1, $2), ($1, '10000000-0000-4000-8000-000000000002'), ($3, '10000000-0000-4000-8000-000000000003')`,
      [postIds[0], FIXTURE.userId, postIds[1]],
    );

    const feedQuery = `query StylePosts($filter: StylePostFilterInput, $first: Int, $after: String) {
      stylePosts(filter: $filter, first: $first, after: $after) { nodes { stylePostId category likeCount } nextCursor hasNextPage }
    }`;
    const latestFirst = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: feedQuery, variables: { filter: { sort: "LATEST" }, first: 2 } })
      .expect(200);
    expect(latestFirst.body.errors).toBeUndefined();
    expect(
      latestFirst.body.data.stylePosts.nodes.map(({ stylePostId }: { stylePostId: string }) => stylePostId),
    ).toEqual([postIds[2], postIds[1]]);
    expect(latestFirst.body.data.stylePosts.hasNextPage).toBe(true);

    const latestSecond = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: feedQuery,
        variables: {
          filter: { sort: "LATEST" },
          first: 2,
          after: latestFirst.body.data.stylePosts.nextCursor,
        },
      })
      .expect(200);
    expect(
      latestSecond.body.data.stylePosts.nodes.map(({ stylePostId }: { stylePostId: string }) => stylePostId),
    ).toEqual([postIds[0]]);
    expect(latestSecond.body.data.stylePosts.hasNextPage).toBe(false);

    const popular = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: feedQuery, variables: { filter: { sort: "POPULAR" }, first: 2 } })
      .expect(200);
    expect(popular.body.data.stylePosts.nodes.map(({ stylePostId }: { stylePostId: string }) => stylePostId)).toEqual([
      postIds[0],
      postIds[1],
    ]);

    const [cursorPayload, cursorSignature] = popular.body.data.stylePosts.nextCursor.split(".");
    const cursor = JSON.parse(Buffer.from(cursorPayload, "base64url").toString("utf8")) as { sortValue: number };
    const tamperedCursor = `${Buffer.from(JSON.stringify({ ...cursor, sortValue: cursor.sortValue + 99 })).toString("base64url")}.${cursorSignature}`;
    const rejectedTamperedCursor = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: feedQuery,
        variables: { filter: { sort: "POPULAR" }, first: 2, after: tamperedCursor },
      })
      .expect(200);
    expect(rejectedTamperedCursor.body.errors[0].message).toBe("Invalid style post cursor");

    const accessToken = await signin(request.agent(app.getHttpServer()));
    const likedCursor = await request(app.getHttpServer())
      .post("/graphql")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ query: `mutation { likeStylePost(stylePostId: "${postIds[1]}") { likeCount } }` })
      .expect(200);
    expect(likedCursor.body.data.likeStylePost.likeCount).toBe(2);
    const popularNext = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: feedQuery,
        variables: { filter: { sort: "POPULAR" }, first: 2, after: popular.body.data.stylePosts.nextCursor },
      })
      .expect(200);
    expect(popularNext.body.errors).toBeUndefined();
    expect(
      popularNext.body.data.stylePosts.nodes.map(({ stylePostId }: { stylePostId: string }) => stylePostId),
    ).toEqual([postIds[2]]);

    const popularBeforeUnlike = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: feedQuery, variables: { filter: { sort: "POPULAR" }, first: 1 } })
      .expect(200);
    expect(popularBeforeUnlike.body.data.stylePosts.nodes[0].stylePostId).toBe(postIds[1]);
    const unlikedCursor = await request(app.getHttpServer())
      .post("/graphql")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ query: `mutation { unlikeStylePost(stylePostId: "${postIds[1]}") { likeCount } }` })
      .expect(200);
    expect(unlikedCursor.body.data.unlikeStylePost.likeCount).toBe(1);
    const popularAfterUnlike = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: feedQuery,
        variables: {
          filter: { sort: "POPULAR" },
          first: 2,
          after: popularBeforeUnlike.body.data.stylePosts.nextCursor,
        },
      })
      .expect(200);
    expect(popularAfterUnlike.body.errors).toBeUndefined();
    expect(
      popularAfterUnlike.body.data.stylePosts.nodes.map(({ stylePostId }: { stylePostId: string }) => stylePostId),
    ).toEqual([postIds[0], postIds[2]]);

    const recommendedBeforeUnlike = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: feedQuery, variables: { filter: { sort: "RECOMMENDED" }, first: 1 } })
      .expect(200);
    expect(recommendedBeforeUnlike.body.data.stylePosts.nodes[0].stylePostId).toBe(postIds[0]);
    const unlikedRecommendedCursor = await request(app.getHttpServer())
      .post("/graphql")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ query: `mutation { unlikeStylePost(stylePostId: "${postIds[0]}") { likeCount } }` })
      .expect(200);
    expect(unlikedRecommendedCursor.body.data.unlikeStylePost.likeCount).toBe(1);
    const recommendedAfterUnlike = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: feedQuery,
        variables: {
          filter: { sort: "RECOMMENDED" },
          first: 2,
          after: recommendedBeforeUnlike.body.data.stylePosts.nextCursor,
        },
      })
      .expect(200);
    expect(recommendedAfterUnlike.body.errors).toBeUndefined();
    expect(
      recommendedAfterUnlike.body.data.stylePosts.nodes.map(({ stylePostId }: { stylePostId: string }) => stylePostId),
    ).toEqual([postIds[1], postIds[2]]);

    const clothing = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: feedQuery, variables: { filter: { category: "CLOTHING", sort: "RECOMMENDED" }, first: 5 } })
      .expect(200);
    expect(clothing.body.data.stylePosts.nodes).toHaveLength(3);
    expect(
      clothing.body.data.stylePosts.nodes.every(({ category }: { category: string }) => category === "CLOTHING"),
    ).toBe(true);
  });

  it("rejects invalid style post IDs without exposing internals", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .send({ query: `{ stylePost(stylePostId: "not-a-uuid") { stylePostId } }` })
      .expect(200);
    expect(response.body.data).toBeNull();
    expect(response.body.errors[0].message).toBe("Invalid style post ID");
    const output = JSON.stringify(response.body);
    expect(output).not.toContain("stacktrace");
    expect(output).not.toContain("Failed query");
    expect(output).not.toContain("/Volumes/");

    const accessToken = await signin(request.agent(app.getHttpServer()));
    const mutation = await request(app.getHttpServer())
      .post("/graphql")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ query: `mutation { likeStylePost(stylePostId: "not-a-uuid") { stylePostId } }` })
      .expect(200);
    expect(mutation.body.errors[0].message).toBe("Invalid style post ID");
    expect(JSON.stringify(mutation.body)).not.toContain("stacktrace");
  });

  it("adds and removes an authenticated wish idempotently", async () => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const mutation = `mutation { addWish(productId: "${FIXTURE.productId}") { productId } }`;
    const first = await agent.post("/graphql").set("Authorization", `Bearer ${accessToken}`).send({ query: mutation });
    const duplicate = await agent
      .post("/graphql")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ query: mutation });
    expect(first.body.data.addWish.productId).toBe(FIXTURE.productId);
    expect(duplicate.body.data.addWish.productId).toBe(FIXTURE.productId);
    const removed = await agent
      .post("/graphql")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ query: `mutation { removeWish(productId: "${FIXTURE.productId}") }` });
    expect(removed.body.data.removeWish).toBe(true);
  });

  it("returns NOT_OBSERVED for missing, processing, and another user's checkout attempt without writes", async () => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const auth = { Authorization: `Bearer ${accessToken}` };
    const otherUserId = "10000000-0000-4000-8000-000000000099";
    const otherOrderId = "90000000-0000-4000-8000-000000000099";
    await pool.query(
      `INSERT INTO "users" ("userId", userid, email, role)
       VALUES ($1, 'checkout-attempt-other', 'checkout-attempt-other@example.test', 'USER')`,
      [otherUserId],
    );
    await pool.query(
      `INSERT INTO "orders" ("orderId", "orderNumber", "userId", "totalAmount")
       VALUES ($1, 'DJ-CHECKOUT-OTHER', $2, 15000)`,
      [otherOrderId, otherUserId],
    );
    await pool.query(
      `INSERT INTO "checkoutIdempotencyKeys" ("userId", "idempotencyKey", "orderId", status)
       VALUES ($1, 'processing-attempt', NULL, 'PROCESSING'), ($2, 'foreign-attempt', $3, 'COMPLETED')`,
      [FIXTURE.userId, otherUserId, otherOrderId],
    );
    const before = await checkoutState(pool);
    const query = `query CheckoutAttempt($idempotencyKey: String!) {
      checkoutAttempt(idempotencyKey: $idempotencyKey) { status orderId }
    }`;

    const responses = await Promise.all(
      ["missing-attempt", "processing-attempt", "foreign-attempt"].map((idempotencyKey) =>
        agent.post("/graphql").set(auth).send({ query, variables: { idempotencyKey } }),
      ),
    );

    expect(responses.map(({ body }) => body.errors)).toEqual([undefined, undefined, undefined]);
    expect(responses.map(({ body }) => body.data.checkoutAttempt)).toEqual([
      { status: "NOT_OBSERVED", orderId: null },
      { status: "NOT_OBSERVED", orderId: null },
      { status: "NOT_OBSERVED", orderId: null },
    ]);
    await expect(checkoutState(pool)).resolves.toEqual(before);
  });

  it("returns the owned committed checkout attempt after trimming its key", async () => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const orderId = "90000000-0000-4000-8000-000000000098";
    await pool.query(
      `INSERT INTO "orders" ("orderId", "orderNumber", "userId", "totalAmount")
       VALUES ($1, 'DJ-CHECKOUT-OWNED', $2, 15000)`,
      [orderId, FIXTURE.userId],
    );
    await pool.query(
      `INSERT INTO "checkoutIdempotencyKeys" ("userId", "idempotencyKey", "orderId", status)
       VALUES ($1, 'owned-attempt', $2, 'COMPLETED')`,
      [FIXTURE.userId, orderId],
    );
    const before = await checkoutState(pool);

    const response = await agent.post("/graphql").set("Authorization", `Bearer ${accessToken}`).send({
      query: `query { checkoutAttempt(idempotencyKey: "  owned-attempt  ") { status orderId } }`,
    });

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.checkoutAttempt).toEqual({ status: "CONFIRMED", orderId });
    await expect(checkoutState(pool)).resolves.toEqual(before);
  });

  it("reports malformed completed checkout attempt data as an internal error", async () => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    await pool.query(
      `INSERT INTO "checkoutIdempotencyKeys" ("userId", "idempotencyKey", "orderId", status)
       VALUES ($1, 'malformed-attempt', NULL, 'COMPLETED')`,
      [FIXTURE.userId],
    );

    const response = await agent
      .post("/graphql")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ query: `query { checkoutAttempt(idempotencyKey: "malformed-attempt") { status orderId } }` });

    expect(response.body.data).toBeNull();
    expect(response.body.errors[0]).toMatchObject({
      message: "Internal server error",
      extensions: { code: "INTERNAL_SERVER_ERROR" },
    });
  });

  it.each(["   ", "x".repeat(121)])("rejects invalid checkout attempt key %j", async (idempotencyKey) => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const response = await agent
      .post("/graphql")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        query: `query CheckoutAttempt($idempotencyKey: String!) {
          checkoutAttempt(idempotencyKey: $idempotencyKey) { status orderId }
        }`,
        variables: { idempotencyKey },
      });

    expect(response.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
  });

  it("creates a payment-pending order idempotently without claiming approval", async () => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const auth = { Authorization: `Bearer ${accessToken}` };
    const cart = await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: `mutation { upsertCartItem(input: { skuId: "${FIXTURE.skuId}", quantity: 2 }) { totalAmount items { quantity } } }`,
      });
    expect(cart.body.data.upsertCartItem).toMatchObject({ totalAmount: 30000, items: [{ quantity: 2 }] });
    const checkoutMutation = `mutation { checkoutCart(input: { idempotencyKey: "integration-success" }) { orderId status paymentStatus totalAmount } }`;
    const checkout = await agent.post("/graphql").set(auth).send({ query: checkoutMutation });
    const repeated = await agent.post("/graphql").set(auth).send({ query: checkoutMutation });
    expect(checkout.body.data.checkoutCart).toMatchObject({
      status: "PAYMENT_PENDING",
      paymentStatus: "PENDING",
      totalAmount: 30000,
    });
    expect(repeated.body.data.checkoutCart.orderId).toBe(checkout.body.data.checkoutCart.orderId);
    const stock = await pool.query<{ stock: number }>(`SELECT stock FROM "productSkus" WHERE "skuId" = $1`, [
      FIXTURE.skuId,
    ]);
    expect(stock.rows[0]?.stock).toBe(5);
    const events = await pool.query<{ eventType: string }>(
      `SELECT "eventType" FROM "activityEvents" WHERE "subjectId" = $1 ORDER BY "createdAt"`,
      [checkout.body.data.checkoutCart.orderId],
    );
    expect(events.rows).toEqual([{ eventType: "ORDER_PAYMENT_PENDING" }, { eventType: "CHECKOUT_IDEMPOTENCY_REUSED" }]);
    const notifications = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "notifications" WHERE "userId" = $1 AND "entityId" = $2`,
      [FIXTURE.userId, checkout.body.data.checkoutCart.orderId],
    );
    expect(notifications.rows[0]?.count).toBe(0);
  });

  it("uses stock as a non-reserving checkout availability snapshot", async () => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const auth = { Authorization: `Bearer ${accessToken}` };
    await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: `mutation { upsertCartItem(input: { skuId: "${FIXTURE.secondSkuId}", quantity: 1 }) { cartId } }`,
      });
    await pool.query(`UPDATE "productSkus" SET stock = 0 WHERE "skuId" = $1`, [FIXTURE.secondSkuId]);
    const checkout = await agent.post("/graphql").set(auth).send({
      query: `mutation { checkoutCart(input: { idempotencyKey: "unavailable-snapshot" }) { orderId } }`,
    });
    expect(checkout.body.errors[0]).toMatchObject({
      message: "Insufficient stock for INTEGRATION-SHOES-M",
      extensions: { code: "BAD_USER_INPUT" },
    });
    const state = await pool.query<{ cart_items: number; idempotency_keys: number; orders: number; stock: number }>(
      `SELECT
        (SELECT count(*)::int FROM "cartItems") AS cart_items,
        (SELECT count(*)::int FROM "checkoutIdempotencyKeys") AS idempotency_keys,
        (SELECT count(*)::int FROM "orders") AS orders,
        (SELECT stock FROM "productSkus" WHERE "skuId" = $1) AS stock`,
      [FIXTURE.secondSkuId],
    );
    expect(state.rows[0]).toEqual({ cart_items: 1, idempotency_keys: 0, orders: 0, stock: 0 });
  });

  it("rejects checkout test controls in the public GraphQL input", async () => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const auth = { Authorization: `Bearer ${accessToken}` };
    await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: `mutation { upsertCartItem(input: { skuId: "${FIXTURE.secondSkuId}", quantity: 1 }) { cartId } }`,
      });
    const rejected = await agent.post("/graphql").set(auth).send({
      query: `mutation { checkoutCart(input: { idempotencyKey: "integration-failure", forcePaymentFailure: true }) { status paymentStatus paymentFailureReason } }`,
    });
    const schema = await agent
      .post("/graphql")
      .send({ query: `{ __type(name: "CheckoutCartInput") { inputFields { name } } }` });
    expect(rejected.status).toBe(400);
    expect(rejected.body.data).toBeUndefined();
    expect(schema.body.data.__type.inputFields).toEqual([{ name: "idempotencyKey" }, { name: "expectedCart" }]);
    const state = await pool.query<{ cart_items: number; orders: number; stock: number }>(
      `SELECT
        (SELECT count(*)::int FROM "cartItems") AS cart_items,
        (SELECT count(*)::int FROM "orders") AS orders,
        (SELECT stock FROM "productSkus" WHERE "skuId" = $1) AS stock`,
      [FIXTURE.secondSkuId],
    );
    expect(state.rows[0]).toEqual({ cart_items: 1, orders: 0, stock: 1 });
  });

  it("replays a completed checkout before reading a changed cart snapshot", async () => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const auth = { Authorization: `Bearer ${accessToken}` };
    const cart = await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: `mutation { upsertCartItem(input: { skuId: "${FIXTURE.skuId}", quantity: 2 }) {
          items { cartItemId quantity sku { skuId price } }
        } }`,
      });
    const item = cart.body.data.upsertCartItem.items[0];
    const expectedCart = [
      {
        cartItemId: item.cartItemId,
        skuId: item.sku.skuId,
        quantity: item.quantity,
        unitPrice: item.sku.price,
      },
    ];
    const mutation = `mutation Checkout($input: CheckoutCartInput!) {
      checkoutCart(input: $input) { orderId status paymentStatus totalAmount }
    }`;
    const input = { idempotencyKey: "replay-before-snapshot", expectedCart };
    const first = await agent.post("/graphql").set(auth).send({ query: mutation, variables: { input } });
    await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: `mutation { upsertCartItem(input: { skuId: "${FIXTURE.secondSkuId}", quantity: 1 }) { cartId } }`,
      });

    const replay = await agent.post("/graphql").set(auth).send({ query: mutation, variables: { input } });
    const currentCart = await agent
      .post("/graphql")
      .set(auth)
      .send({ query: `{ cart { items { sku { skuId } quantity } } }` });
    const orders = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM "orders"`);

    expect(first.body.errors).toBeUndefined();
    expect(first.body.data.checkoutCart).toMatchObject({
      status: "PAYMENT_PENDING",
      paymentStatus: "PENDING",
      totalAmount: 30000,
    });
    expect(replay.body.errors).toBeUndefined();
    expect(replay.body.data.checkoutCart.orderId).toBe(first.body.data.checkoutCart.orderId);
    expect(currentCart.body.data.cart.items).toEqual([{ sku: { skuId: FIXTURE.secondSkuId }, quantity: 1 }]);
    expect(orders.rows[0]?.count).toBe(1);
  });

  it.each(["cartItemId", "skuId", "quantity", "unitPrice"])(
    "rejects a %s cart snapshot mismatch and rolls back checkout",
    async (changedField) => {
      const agent = request.agent(app.getHttpServer());
      const accessToken = await signin(agent);
      const auth = { Authorization: `Bearer ${accessToken}` };
      const cart = await agent
        .post("/graphql")
        .set(auth)
        .send({
          query: `mutation { upsertCartItem(input: { skuId: "${FIXTURE.skuId}", quantity: 1 }) {
            items { cartItemId quantity sku { skuId price } }
          } }`,
        });
      expect(cart.body.errors).toBeUndefined();
      const item = cart.body.data.upsertCartItem.items[0];
      const expectedItem = {
        cartItemId: item.cartItemId,
        skuId: item.sku.skuId,
        quantity: item.quantity,
        unitPrice: item.sku.price,
      };
      const expectedCart = [expectedItem];
      if (changedField === "cartItemId") expectedItem.cartItemId = "00000000-0000-4000-8000-000000000099";
      if (changedField === "skuId") expectedItem.skuId = FIXTURE.secondSkuId;
      if (changedField === "quantity")
        await agent
          .post("/graphql")
          .set(auth)
          .send({
            query: `mutation { upsertCartItem(input: { skuId: "${FIXTURE.skuId}", quantity: 2 }) { cartId } }`,
          });
      if (changedField === "unitPrice")
        await pool.query(`UPDATE "productSkus" SET price = 16000 WHERE "skuId" = $1`, [FIXTURE.skuId]);
      const before = await checkoutState(pool);

      const response = await agent
        .post("/graphql")
        .set(auth)
        .send({
          query: `mutation Checkout($input: CheckoutCartInput!) {
            checkoutCart(input: $input) { orderId }
          }`,
          variables: { input: { idempotencyKey: `snapshot-${changedField}`, expectedCart } },
        });

      expect(response.body.data).toBeNull();
      expect(response.body.errors[0]).toMatchObject({
        message: "Cart snapshot changed",
        extensions: { code: "CART_SNAPSHOT_CHANGED" },
      });
      await expect(checkoutState(pool)).resolves.toEqual(before);
    },
  );

  it("normalizes a matching cart snapshot and keeps server prices", async () => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const auth = { Authorization: `Bearer ${accessToken}` };
    await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: `mutation { upsertCartItem(input: { skuId: "${FIXTURE.skuId}", quantity: 1 }) { cartId } }`,
      });
    const cart = await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: `mutation { upsertCartItem(input: { skuId: "${FIXTURE.secondSkuId}", quantity: 1 }) {
          items { cartItemId quantity sku { skuId price } }
        } }`,
      });
    const expectedCart = cart.body.data.upsertCartItem.items
      .map((item: { cartItemId: string; quantity: number; sku: { skuId: string; price: number } }) => ({
        cartItemId: item.cartItemId.toUpperCase(),
        skuId: item.sku.skuId.toUpperCase(),
        quantity: item.quantity,
        unitPrice: item.sku.price,
      }))
      .reverse();

    const response = await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: `mutation Checkout($input: CheckoutCartInput!) {
          checkoutCart(input: $input) { status paymentStatus totalAmount items { skuId unitPrice quantity } }
        }`,
        variables: { input: { idempotencyKey: "normalized-snapshot", expectedCart } },
      });

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.checkoutCart).toMatchObject({
      status: "PAYMENT_PENDING",
      paymentStatus: "PENDING",
      totalAmount: 45000,
    });
    expect(response.body.data.checkoutCart.items).toEqual(
      expect.arrayContaining([
        { skuId: FIXTURE.skuId, unitPrice: 15000, quantity: 1 },
        { skuId: FIXTURE.secondSkuId, unitPrice: 30000, quantity: 1 },
      ]),
    );
  });
});
