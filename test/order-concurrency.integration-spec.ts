import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { FIXTURE } from "src/database/fixtures";
import { resetTestFixtures, testPool } from "./support/database";

const WAIT_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 20_000;

jest.setTimeout(TEST_TIMEOUT_MS);

const waitFor = async (condition: () => Promise<boolean>) => {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for concurrent checkout requests");
};

const startBlockingTransaction = async (pool: Pool, lockQuery: string) => {
  const blocker = await pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '4s'");
    await blocker.query(lockQuery);
    return blocker;
  } catch (error) {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
    throw error;
  }
};

const signin = async (app: INestApplication) => {
  const response = await request(app.getHttpServer())
    .post("/graphql")
    .set("x-device-id", "order-concurrency-device")
    .send({
      query: `mutation Signin($input: SigninAuthInput!) {
        signin(input: $input) { accessToken }
      }`,
      variables: {
        input: { userid: FIXTURE.userid, password: FIXTURE.password, portal: "Fo" },
      },
    });
  expect(response.body.errors).toBeUndefined();
  return response.body.data.signin.accessToken as string;
};

const addCartItem = async (app: INestApplication, accessToken: string, skuId: string = FIXTURE.skuId, quantity = 1) => {
  const response = await request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({
      query: `mutation { upsertCartItem(input: { skuId: "${skuId}", quantity: ${quantity} }) { cartId } }`,
    });
  expect(response.body.errors).toBeUndefined();
};

const checkout = (app: INestApplication, accessToken: string, idempotencyKey: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({
      query: `mutation Checkout($input: CheckoutCartInput!) {
        checkoutCart(input: $input) { orderId status paymentStatus }
      }`,
      variables: { input: { idempotencyKey } },
    })
    .then((response) => response);

const upsertCartItem = (app: INestApplication, accessToken: string, skuId: string, quantity: number) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({
      query: `mutation Upsert($input: UpsertCartItemInput!) { upsertCartItem(input: $input) { cartId } }`,
      variables: { input: { skuId, quantity } },
    })
    .then((response) => response);

const removeCartItem = (app: INestApplication, accessToken: string, skuId: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({
      query: `mutation Remove($skuId: String!) { removeCartItem(skuId: $skuId) { cartId } }`,
      variables: { skuId },
    })
    .then((response) => response);

const hasWaitingQuery = async (pool: Pool, relationName: string) => {
  const waiting = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND wait_event_type = 'Lock'
       AND query LIKE $1`,
    [`%"${relationName}"%`],
  );
  return (waiting.rows[0]?.count ?? 0) >= 1;
};

describe("PostgreSQL checkout concurrency", () => {
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

  it("returns one order to concurrent requests with the same idempotency key", async () => {
    const accessToken = await signin(app);
    await addCartItem(app, accessToken);
    const blocker = await startBlockingTransaction(pool, `LOCK TABLE "checkoutIdempotencyKeys" IN SHARE MODE`);
    const requests: ReturnType<typeof checkout>[] = [];
    let released = false;
    let lockError: unknown;
    try {
      requests.push(checkout(app, accessToken, "concurrent-same-key"));
      requests.push(checkout(app, accessToken, "concurrent-same-key"));
      await waitFor(async () => {
        const waiting = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM pg_locks lock
           JOIN pg_class relation ON relation.oid = lock.relation
           WHERE relation.relname = 'checkoutIdempotencyKeys' AND NOT lock.granted`,
        );
        return (waiting.rows[0]?.count ?? 0) >= 2;
      });
      await blocker.query("COMMIT");
      released = true;
    } catch (error) {
      lockError = error;
    } finally {
      if (!released) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    if (lockError) {
      await Promise.allSettled(requests);
      throw lockError;
    }

    const responses = await Promise.all(requests);
    expect(responses.map(({ body }) => body.errors)).toEqual([undefined, undefined]);
    expect(new Set(responses.map(({ body }) => body.data.checkoutCart.orderId))).toHaveProperty("size", 1);
    const state = await pool.query<{ cart_items: number; idempotency_keys: number; orders: number; stock: number }>(
      `SELECT
        (SELECT count(*)::int FROM "cartItems") AS cart_items,
        (SELECT count(*)::int FROM "checkoutIdempotencyKeys") AS idempotency_keys,
        (SELECT count(*)::int FROM "orders") AS orders,
        (SELECT stock FROM "productSkus" WHERE "skuId" = $1) AS stock`,
      [FIXTURE.skuId],
    );
    expect(state.rows[0]).toEqual({ cart_items: 0, idempotency_keys: 1, orders: 1, stock: 5 });
  });

  it("allows only one checkout to consume a cart across different idempotency keys", async () => {
    const accessToken = await signin(app);
    await addCartItem(app, accessToken);
    const blocker = await startBlockingTransaction(pool, `LOCK TABLE "orders" IN SHARE MODE`);
    const requests: ReturnType<typeof checkout>[] = [];
    let released = false;
    let lockError: unknown;
    try {
      requests.push(checkout(app, accessToken, "concurrent-cart-a"));
      requests.push(checkout(app, accessToken, "concurrent-cart-b"));
      await waitFor(async () => {
        const waiting = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
             AND (query LIKE '%"orders"%' OR query LIKE '%"carts"%')`,
        );
        return (waiting.rows[0]?.count ?? 0) >= 2;
      });
      await blocker.query("COMMIT");
      released = true;
    } catch (error) {
      lockError = error;
    } finally {
      if (!released) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    if (lockError) {
      await Promise.allSettled(requests);
      throw lockError;
    }

    const responses = await Promise.all(requests);
    const successes = responses.filter(({ body }) => body.data?.checkoutCart);
    const failures = responses.filter(({ body }) => body.errors);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.body.errors[0]).toMatchObject({
      message: "Cart is empty",
      extensions: { code: "BAD_USER_INPUT" },
    });
    const state = await pool.query<{ cart_items: number; orders: number; stock: number }>(
      `SELECT
        (SELECT count(*)::int FROM "cartItems") AS cart_items,
        (SELECT count(*)::int FROM "orders") AS orders,
        (SELECT stock FROM "productSkus" WHERE "skuId" = $1) AS stock`,
      [FIXTURE.skuId],
    );
    expect(state.rows[0]).toEqual({ cart_items: 0, orders: 1, stock: 5 });
  });

  it("serializes checkout before a concurrent cart upsert", async () => {
    const accessToken = await signin(app);
    await addCartItem(app, accessToken);
    const blocker = await startBlockingTransaction(pool, `LOCK TABLE "orders" IN SHARE MODE`);
    const requests: ReturnType<typeof checkout>[] = [];
    let released = false;
    let lockError: unknown;
    try {
      requests.push(checkout(app, accessToken, "checkout-before-upsert"));
      await waitFor(() => hasWaitingQuery(pool, "orders"));
      requests.push(upsertCartItem(app, accessToken, FIXTURE.skuId, 2));
      await waitFor(() => hasWaitingQuery(pool, "carts"));
      await blocker.query("COMMIT");
      released = true;
    } catch (error) {
      lockError = error;
    } finally {
      if (!released) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    if (lockError) {
      await Promise.allSettled(requests);
      throw lockError;
    }

    const [checkoutResponse, upsertResponse] = await Promise.all(requests);
    expect(checkoutResponse.body.errors).toBeUndefined();
    expect(upsertResponse.body.errors).toBeUndefined();
    const state = await pool.query<{
      cart_quantity: number;
      order_quantity: number;
      orders: number;
      stock: number;
    }>(
      `SELECT
        (SELECT quantity FROM "cartItems" WHERE "skuId" = $1) AS cart_quantity,
        (SELECT quantity FROM "orderItems" WHERE "skuId" = $1) AS order_quantity,
        (SELECT count(*)::int FROM "orders") AS orders,
        (SELECT stock FROM "productSkus" WHERE "skuId" = $1) AS stock`,
      [FIXTURE.skuId],
    );
    expect(state.rows[0]).toEqual({ cart_quantity: 2, order_quantity: 1, orders: 1, stock: 5 });
  });

  it("serializes a cart removal before concurrent checkout", async () => {
    const accessToken = await signin(app);
    await addCartItem(app, accessToken);
    await addCartItem(app, accessToken, FIXTURE.secondSkuId);
    const blocker = await startBlockingTransaction(pool, `LOCK TABLE "activityEvents" IN SHARE MODE`);
    const requests: ReturnType<typeof checkout>[] = [];
    let released = false;
    let lockError: unknown;
    try {
      requests.push(removeCartItem(app, accessToken, FIXTURE.secondSkuId));
      await waitFor(() => hasWaitingQuery(pool, "activityEvents"));
      requests.push(checkout(app, accessToken, "remove-before-checkout"));
      await waitFor(() => hasWaitingQuery(pool, "carts"));
      await blocker.query("COMMIT");
      released = true;
    } catch (error) {
      lockError = error;
    } finally {
      if (!released) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    if (lockError) {
      await Promise.allSettled(requests);
      throw lockError;
    }

    const [removeResponse, checkoutResponse] = await Promise.all(requests);
    expect(removeResponse.body.errors).toBeUndefined();
    expect(checkoutResponse.body.errors).toBeUndefined();
    const state = await pool.query<{
      cart_items: number;
      order_items: number;
      removed_order_items: number;
      primary_stock: number;
      removed_stock: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM "cartItems") AS cart_items,
        (SELECT count(*)::int FROM "orderItems") AS order_items,
        (SELECT count(*)::int FROM "orderItems" WHERE "skuId" = $2) AS removed_order_items,
        (SELECT stock FROM "productSkus" WHERE "skuId" = $1) AS primary_stock,
        (SELECT stock FROM "productSkus" WHERE "skuId" = $2) AS removed_stock`,
      [FIXTURE.skuId, FIXTURE.secondSkuId],
    );
    expect(state.rows[0]).toEqual({
      cart_items: 0,
      order_items: 1,
      removed_order_items: 0,
      primary_stock: 5,
      removed_stock: 1,
    });
  });
});
