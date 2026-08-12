import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { FIXTURE } from "src/database/fixtures";
import { migrateTestDatabase, resetTestFixtures, testPool } from "./support/database";

const signin = async (agent: ReturnType<typeof request.agent>) => {
  const response = await agent
    .post("/graphql")
    .set("x-device-id", "integration-device")
    .send({
      query: `mutation Signin($input: SigninAuthInput!) {
        signin(input: $input) { accessToken role }
      }`,
      variables: {
        input: { userid: FIXTURE.userid, password: FIXTURE.password, portal: "Fo" },
      },
    });
  expect(response.body.errors).toBeUndefined();
  expect(response.status).toBe(200);
  return response.body.data.signin.accessToken;
};

describe("PostgreSQL GraphQL integration", () => {
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

  it("runs all migrations initially and idempotently", async () => {
    await migrateTestDatabase(pool);
    const result = await pool.query<{ count: string }>(`SELECT count(*) FROM "_migrations"`);
    expect(result.rows[0]?.count).toBe("7");
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

  it("updates cart and completes checkout idempotently", async () => {
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
      status: "PAID",
      paymentStatus: "APPROVED",
      totalAmount: 30000,
    });
    expect(repeated.body.data.checkoutCart.orderId).toBe(checkout.body.data.checkoutCart.orderId);
  });

  it("records checkout payment failure without consuming stock", async () => {
    const agent = request.agent(app.getHttpServer());
    const accessToken = await signin(agent);
    const auth = { Authorization: `Bearer ${accessToken}` };
    await agent
      .post("/graphql")
      .set(auth)
      .send({
        query: `mutation { upsertCartItem(input: { skuId: "${FIXTURE.secondSkuId}", quantity: 1 }) { cartId } }`,
      });
    const failed = await agent.post("/graphql").set(auth).send({
      query: `mutation { checkoutCart(input: { idempotencyKey: "integration-failure", forcePaymentFailure: true }) { status paymentStatus paymentFailureReason } }`,
    });
    expect(failed.body.data.checkoutCart).toMatchObject({
      status: "FAILED",
      paymentStatus: "FAILED",
      paymentFailureReason: "Mock payment rejected",
    });
    const stock = await pool.query<{ stock: number }>(`SELECT stock FROM "productSkus" WHERE "skuId" = $1`, [
      FIXTURE.secondSkuId,
    ]);
    expect(stock.rows[0]?.stock).toBe(1);
  });
});
