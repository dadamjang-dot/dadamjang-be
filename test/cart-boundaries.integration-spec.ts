import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { FIXTURE } from "src/database/fixtures";
import { resetTestFixtures, testPool } from "./support/database";

const MAX_SIGNED_INT = 2_147_483_647;

const signin = async (app: INestApplication) => {
  const response = await request(app.getHttpServer())
    .post("/graphql")
    .set("x-device-id", "cart-boundary-device")
    .send({
      query: `mutation Signin($input: SigninAuthInput!) {
        signin(input: $input) { accessToken }
      }`,
      variables: { input: { userid: FIXTURE.userid, password: FIXTURE.password, portal: "FO" } },
    });
  expect(response.body.errors).toBeUndefined();
  return response.body.data.signin.accessToken as string;
};

const upsertCartItem = (app: INestApplication, accessToken: string, skuId: string, quantity: number) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({
      query: `mutation Upsert($input: UpsertCartItemInput!) {
        upsertCartItem(input: $input) { totalAmount items { sku { skuId } quantity } }
      }`,
      variables: { input: { skuId, quantity } },
    })
    .then((response) => response);

const getCart = (app: INestApplication, accessToken: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({ query: `{ cart { totalAmount items { sku { skuId } quantity } } }` })
    .then((response) => response);

const checkout = (app: INestApplication, accessToken: string, idempotencyKey: string) =>
  request(app.getHttpServer())
    .post("/graphql")
    .set("Authorization", `Bearer ${accessToken}`)
    .send({
      query: `mutation Checkout($input: CheckoutCartInput!) {
        checkoutCart(input: $input) { orderId totalAmount }
      }`,
      variables: { input: { idempotencyKey } },
    })
    .then((response) => response);

const createCart = async (pool: Pool) => {
  const result = await pool.query<{ cartId: string }>(
    `INSERT INTO "carts" ("userId") VALUES ($1)
     ON CONFLICT ("userId") DO UPDATE SET "updatedAt" = "carts"."updatedAt"
     RETURNING "cartId"`,
    [FIXTURE.userId],
  );
  const cartId = result.rows[0]?.cartId;
  if (!cartId) throw new Error("Cart fixture was not created");
  return cartId;
};

const seedGeneratedSkus = (pool: Pool, count: number) =>
  pool.query(
    `INSERT INTO "productSkus"
      ("skuId", "productId", "code", "optionName", "price", "stock", "position")
     SELECT
       ('82000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
       $1,
       'CART-BOUNDARY-' || series,
       'Boundary ' || series,
       1,
       1,
       series
     FROM generate_series(1, $2::int) AS series`,
    [FIXTURE.productId, count],
  );

const insertGeneratedCartItems = (pool: Pool, cartId: string, count: number) =>
  pool.query(
    `INSERT INTO "cartItems" ("cartId", "skuId", "quantity")
     SELECT
       $1,
       ('82000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
       1
     FROM generate_series(1, $2::int) AS series`,
    [cartId, count],
  );

describe("PostgreSQL cart boundaries", () => {
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

  it("accepts the signed INT maximum and rejects a line overflow without persisting it", async () => {
    const accessToken = await signin(app);
    await pool.query(`UPDATE "productSkus" SET price = $1, stock = 2 WHERE "skuId" = $2`, [
      MAX_SIGNED_INT,
      FIXTURE.skuId,
    ]);

    const exact = await upsertCartItem(app, accessToken, FIXTURE.skuId, 1);
    expect(exact.body.errors).toBeUndefined();
    expect(exact.body.data.upsertCartItem).toMatchObject({ totalAmount: MAX_SIGNED_INT, items: [{ quantity: 1 }] });

    const overflow = await upsertCartItem(app, accessToken, FIXTURE.skuId, 2);
    expect(overflow.body.errors?.[0]).toMatchObject({
      message: "Cart total exceeds supported amount",
      extensions: { code: "BAD_USER_INPUT" },
    });
    const unchanged = await getCart(app, accessToken);
    expect(unchanged.body.errors).toBeUndefined();
    expect(unchanged.body.data.cart).toMatchObject({ totalAmount: MAX_SIGNED_INT, items: [{ quantity: 1 }] });
    const state = await pool.query<{ event_count: number; quantity: number }>(
      `SELECT
        (SELECT count(*)::int FROM "activityEvents" WHERE "eventType" = 'CART_ITEM_UPSERTED') AS event_count,
        (SELECT quantity FROM "cartItems" WHERE "skuId" = $1) AS quantity`,
      [FIXTURE.skuId],
    );
    expect(state.rows[0]).toEqual({ event_count: 1, quantity: 1 });
  });

  it("accepts an aggregate at the signed INT maximum through checkout", async () => {
    const accessToken = await signin(app);
    await pool.query(
      `UPDATE "productSkus"
       SET price = CASE WHEN "skuId" = $1 THEN 1500000000 ELSE 647483647 END, stock = 1
       WHERE "skuId" IN ($1, $2)`,
      [FIXTURE.skuId, FIXTURE.secondSkuId],
    );

    await upsertCartItem(app, accessToken, FIXTURE.skuId, 1);
    const exact = await upsertCartItem(app, accessToken, FIXTURE.secondSkuId, 1);
    expect(exact.body.errors).toBeUndefined();
    expect(exact.body.data.upsertCartItem.totalAmount).toBe(MAX_SIGNED_INT);
    const order = await checkout(app, accessToken, "maximum-cart-total");
    expect(order.body.errors).toBeUndefined();
    expect(order.body.data.checkoutCart.totalAmount).toBe(MAX_SIGNED_INT);
  });

  it("rejects aggregate overflow before cart persistence and checkout persistence", async () => {
    const accessToken = await signin(app);
    await pool.query(
      `UPDATE "productSkus"
       SET price = CASE WHEN "skuId" = $1 THEN 1500000000 ELSE 647483648 END, stock = 1
       WHERE "skuId" IN ($1, $2)`,
      [FIXTURE.skuId, FIXTURE.secondSkuId],
    );

    await upsertCartItem(app, accessToken, FIXTURE.skuId, 1);
    const overflow = await upsertCartItem(app, accessToken, FIXTURE.secondSkuId, 1);
    expect(overflow.body.errors?.[0]).toMatchObject({
      message: "Cart total exceeds supported amount",
      extensions: { code: "BAD_USER_INPUT" },
    });
    const cart = await pool.query<{ cartId: string }>(`SELECT "cartId" FROM "carts" WHERE "userId" = $1`, [
      FIXTURE.userId,
    ]);
    const cartId = cart.rows[0]?.cartId;
    if (!cartId) throw new Error("Cart fixture was not created");
    await pool.query(`INSERT INTO "cartItems" ("cartId", "skuId", quantity) VALUES ($1, $2, 1)`, [
      cartId,
      FIXTURE.secondSkuId,
    ]);

    const rejectedCheckout = await checkout(app, accessToken, "overflowing-cart-total");
    expect(rejectedCheckout.body.errors?.[0]).toMatchObject({
      message: "Cart total exceeds supported amount",
      extensions: { code: "BAD_USER_INPUT" },
    });
    const state = await pool.query<{ cart_items: number; idempotency_keys: number; orders: number }>(
      `SELECT
        (SELECT count(*)::int FROM "cartItems") AS cart_items,
        (SELECT count(*)::int FROM "checkoutIdempotencyKeys") AS idempotency_keys,
        (SELECT count(*)::int FROM "orders") AS orders`,
    );
    expect(state.rows[0]).toEqual({ cart_items: 2, idempotency_keys: 0, orders: 0 });
  });

  it("allows the 100th cart item and rejects the 101st under the cart lock", async () => {
    const accessToken = await signin(app);
    await seedGeneratedSkus(pool, 99);
    const cartId = await createCart(pool);
    await insertGeneratedCartItems(pool, cartId, 99);

    const hundredth = await upsertCartItem(app, accessToken, FIXTURE.skuId, 1);
    expect(hundredth.body.errors).toBeUndefined();
    expect(hundredth.body.data.upsertCartItem.items).toHaveLength(100);
    const hundredFirst = await upsertCartItem(app, accessToken, FIXTURE.secondSkuId, 1);
    expect(hundredFirst.body.errors?.[0]).toMatchObject({
      message: "Cart cannot contain more than 100 items",
      extensions: { code: "BAD_USER_INPUT" },
    });
    const state = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "cartItems" WHERE "cartId" = $1`,
      [cartId],
    );
    expect(state.rows[0]?.count).toBe(100);
  });

  it("rejects oversized legacy carts from reads and checkout", async () => {
    const accessToken = await signin(app);
    await seedGeneratedSkus(pool, 101);
    const cartId = await createCart(pool);
    await insertGeneratedCartItems(pool, cartId, 101);

    const cart = await getCart(app, accessToken);
    expect(cart.body.errors?.[0]).toMatchObject({
      message: "Cart cannot contain more than 100 items",
      extensions: { code: "BAD_USER_INPUT" },
    });
    const order = await checkout(app, accessToken, "oversized-legacy-cart");
    expect(order.body.errors?.[0]).toMatchObject({
      message: "Cart cannot contain more than 100 items",
      extensions: { code: "BAD_USER_INPUT" },
    });
    const state = await pool.query<{ cart_items: number; idempotency_keys: number; orders: number }>(
      `SELECT
        (SELECT count(*)::int FROM "cartItems" WHERE "cartId" = $1) AS cart_items,
        (SELECT count(*)::int FROM "checkoutIdempotencyKeys") AS idempotency_keys,
        (SELECT count(*)::int FROM "orders") AS orders`,
      [cartId],
    );
    expect(state.rows[0]).toEqual({ cart_items: 101, idempotency_keys: 0, orders: 0 });
  });
});
