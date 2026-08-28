import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "src/app";
import { hashToken } from "src/common/security/token-hash";
import { ADMIN_FIXTURE, FIXTURE, seedAdminFixtures } from "src/database/fixtures";
import { EmailDeliveryWorker } from "src/modules/email/email.outbox";
import type { EmailSender } from "src/modules/email/email.sender";
import { resetTestFixtures, testPool } from "./support/database";

type Agent = ReturnType<typeof request.agent>;

const signin = async (agent: Agent, portal: "Fo" | "Bo", userid: string, password: string) => {
  const response = await agent
    .post("/graphql")
    .set("x-device-id", `admin-integration-${portal.toLowerCase()}-${userid}`)
    .send({
      query: `mutation Signin($input: SigninAuthInput!) { signin(input: $input) { accessToken role } }`,
      variables: { input: { userid, password, portal } },
    });
  expect(response.body.errors).toBeUndefined();
  return response.body.data.signin.accessToken as string;
};

const adminToken = (agent: Agent) => signin(agent, "Bo", ADMIN_FIXTURE.userid, ADMIN_FIXTURE.password);

const graphql = (app: INestApplication, token: string, query: string, variables?: Record<string, unknown>) =>
  request(app.getHttpServer()).post("/graphql").set("Authorization", `Bearer ${token}`).send({ query, variables });

describe("Admin GraphQL integration", () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    pool = testPool();
    app = await createApp();
    await app.init();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await resetTestFixtures(pool);
    await seedAdminFixtures(pool);
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("enforces ADMIN access and returns dashboard counters", async () => {
    const query = `{ adminDashboard { pendingPartnerCount pendingProductCount processingOrderCount activeInviteCount } }`;
    const unauthenticated = await request(app.getHttpServer()).post("/graphql").send({ query });
    expect(unauthenticated.body.errors[0].extensions.code).toBe("UNAUTHENTICATED");

    const userAgent = request.agent(app.getHttpServer());
    const userToken = await signin(userAgent, "Fo", FIXTURE.userid, FIXTURE.password);
    const forbidden = await graphql(app, userToken, query);
    expect(forbidden.body.errors[0].extensions.code).toBe("FORBIDDEN");

    const adminAgent = request.agent(app.getHttpServer());
    const token = await adminToken(adminAgent);
    const allowed = await graphql(app, token, query);
    expect(allowed.body.errors).toBeUndefined();
    expect(allowed.body.data.adminDashboard).toEqual({
      pendingPartnerCount: 1,
      pendingProductCount: 1,
      processingOrderCount: 1,
      activeInviteCount: 1,
    });
  });

  it("filters details and paginates stable admin connections", async () => {
    const token = await adminToken(request.agent(app.getHttpServer()));
    const partnersQuery = `query Partners($filter: AdminPartnerFilterInput) {
      adminPartners(filter: $filter) {
        nodes { partnerId ownerUserid ownerEmail status createdAt }
        nextCursor hasNextPage totalCount
      }
    }`;
    const filteredPartners = await graphql(app, token, partnersQuery, {
      filter: { query: ADMIN_FIXTURE.partnerOwnerEmail, createdFrom: "2026-08-13", createdTo: "2026-08-13" },
    });
    expect(filteredPartners.body.errors).toBeUndefined();
    expect(filteredPartners.body.data.adminPartners.nodes).toEqual([
      expect.objectContaining({ partnerId: ADMIN_FIXTURE.partnerId, ownerUserid: ADMIN_FIXTURE.partnerOwnerUserid }),
    ]);

    const firstPage = await graphql(app, token, partnersQuery, { filter: { first: 1 } });
    const secondPage = await graphql(app, token, partnersQuery, {
      filter: { first: 1, after: firstPage.body.data.adminPartners.nextCursor },
    });
    expect(firstPage.body.data.adminPartners).toMatchObject({ totalCount: 2, hasNextPage: true });
    expect(secondPage.body.data.adminPartners.nodes).toHaveLength(1);
    expect(secondPage.body.data.adminPartners.nodes[0].partnerId).not.toBe(
      firstPage.body.data.adminPartners.nodes[0].partnerId,
    );

    const products = await graphql(
      app,
      token,
      `query Products($filter: AdminProductFilterInput) {
        adminProducts(filter: $filter) { nodes { productId title approvalStatus } totalCount }
        adminProduct(productId: "${ADMIN_FIXTURE.productId}") { productId imageUrls skus { code stock } }
      }`,
      { filter: { approvalStatus: "PENDING", partnerId: ADMIN_FIXTURE.partnerId, categoryId: FIXTURE.categoryId } },
    );
    expect(products.body.data.adminProducts.nodes).toEqual([
      expect.objectContaining({ productId: ADMIN_FIXTURE.productId, approvalStatus: "PENDING" }),
    ]);
    expect(products.body.data.adminProduct.skus).toEqual([
      expect.objectContaining({ code: "ADMIN-PENDING-M", stock: 4 }),
    ]);

    const orders = await graphql(
      app,
      token,
      `query Orders($filter: AdminOrderFilterInput) {
        adminOrders(filter: $filter) { nodes { orderId buyerEmail itemCount allowedNextStatuses } totalCount }
        adminOrder(orderId: "${ADMIN_FIXTURE.orderId}") { orderId items { quantity } }
      }`,
      { filter: { query: "integration@example.test", status: "PAID" } },
    );
    expect(orders.body.data.adminOrders.nodes).toEqual([
      expect.objectContaining({
        orderId: ADMIN_FIXTURE.orderId,
        itemCount: 2,
        allowedNextStatuses: ["FULFILLING", "CANCELLED"],
      }),
    ]);
    expect(orders.body.data.adminOrder.items).toEqual([expect.objectContaining({ quantity: 2 })]);
  });

  it("reviews a partner once and records the state change atomically", async () => {
    const token = await adminToken(request.agent(app.getHttpServer()));
    const mutation = `mutation Review($input: ReviewPartnerInput!) {
      reviewPartner(input: $input) { partnerId status auditLogs { action metadataJson } }
    }`;
    const missingReason = await graphql(app, token, mutation, {
      input: { partnerId: ADMIN_FIXTURE.partnerId, approved: false, rejectionReason: "" },
    });
    expect(missingReason.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");

    const results = await Promise.all([
      graphql(app, token, mutation, { input: { partnerId: ADMIN_FIXTURE.partnerId, approved: true } }),
      graphql(app, token, mutation, { input: { partnerId: ADMIN_FIXTURE.partnerId, approved: true } }),
    ]);
    expect(results.filter((result) => result.body.data?.reviewPartner)).toHaveLength(1);
    expect(results.filter((result) => result.body.errors?.[0].extensions.code === "CONFLICT")).toHaveLength(1);

    const state = await pool.query<{ status: string; role: string; auditCount: number }>(
      `SELECT p."status", u."role",
        (SELECT count(*)::int FROM "auditLogs" a WHERE a."entityId" = p."partnerId"::text) AS "auditCount"
       FROM "partners" p JOIN "users" u ON u."userId" = p."ownerUserId"
       WHERE p."partnerId" = $1`,
      [ADMIN_FIXTURE.partnerId],
    );
    expect(state.rows[0]).toEqual({ status: "APPROVED", role: "PARTNER", auditCount: 1 });
  });

  it("reviews a product once and requires a bounded rejection reason", async () => {
    const token = await adminToken(request.agent(app.getHttpServer()));
    const mutation = `mutation Review($input: ReviewProductInput!) {
      reviewProduct(input: $input) { productId approvalStatus rejectionReason auditLogs { action } }
    }`;
    const rejected = await graphql(app, token, mutation, {
      input: { productId: ADMIN_FIXTURE.productId, approved: false, rejectionReason: "상품 정보 보완 필요" },
    });
    expect(rejected.body.errors).toBeUndefined();
    expect(rejected.body.data.reviewProduct).toMatchObject({
      approvalStatus: "REJECTED",
      rejectionReason: "상품 정보 보완 필요",
      auditLogs: [expect.objectContaining({ action: "PRODUCT_REJECTED" })],
    });
    const repeated = await graphql(app, token, mutation, {
      input: { productId: ADMIN_FIXTURE.productId, approved: true },
    });
    expect(repeated.body.errors[0].extensions.code).toBe("CONFLICT");
    const audit = await pool.query(`SELECT 1 FROM "auditLogs" WHERE "entityId" = $1`, [ADMIN_FIXTURE.productId]);
    expect(audit.rowCount).toBe(1);
  });

  it("allows only declared order transitions and resolves concurrent updates once", async () => {
    const token = await adminToken(request.agent(app.getHttpServer()));
    const mutation = `mutation Transition($input: TransitionOrderInput!) {
      transitionOrder(input: $input) { orderId status allowedNextStatuses auditLogs { action metadataJson } }
    }`;
    const invalid = await graphql(app, token, mutation, {
      input: { orderId: ADMIN_FIXTURE.orderId, nextStatus: "COMPLETED" },
    });
    expect(invalid.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");

    const results = await Promise.all([
      graphql(app, token, mutation, {
        input: { orderId: ADMIN_FIXTURE.orderId, nextStatus: "FULFILLING" },
      }),
      graphql(app, token, mutation, {
        input: { orderId: ADMIN_FIXTURE.orderId, nextStatus: "FULFILLING" },
      }),
    ]);
    const success = results.find((result) => result.body.data?.transitionOrder);
    expect(success?.body.data.transitionOrder).toMatchObject({
      status: "FULFILLING",
      allowedNextStatuses: ["COMPLETED", "CANCELLED"],
    });
    expect(results.filter((result) => result.body.errors?.[0].extensions.code === "CONFLICT")).toHaveLength(1);
    const audit = await pool.query(`SELECT 1 FROM "auditLogs" WHERE "entityId" = $1`, [ADMIN_FIXTURE.orderId]);
    expect(audit.rowCount).toBe(1);
  });

  it("does not let an admin mark a payment-pending order as paid", async () => {
    await pool.query(
      `UPDATE "orders" SET status = 'PAYMENT_PENDING', "paymentStatus" = 'PENDING' WHERE "orderId" = $1`,
      [ADMIN_FIXTURE.orderId],
    );
    const token = await adminToken(request.agent(app.getHttpServer()));
    const mutation = `mutation Transition($input: TransitionOrderInput!) {
      transitionOrder(input: $input) { orderId status paymentStatus }
    }`;
    const response = await graphql(app, token, mutation, {
      input: { orderId: ADMIN_FIXTURE.orderId, nextStatus: "PAID" },
    });
    expect(response.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    const unknown = await graphql(app, token, mutation, {
      input: { orderId: ADMIN_FIXTURE.orderId, nextStatus: "REFUNDED" },
    });
    expect(unknown.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    const order = await pool.query<{ paymentStatus: string; status: string }>(
      `SELECT status, "paymentStatus" FROM "orders" WHERE "orderId" = $1`,
      [ADMIN_FIXTURE.orderId],
    );
    expect(order.rows[0]).toEqual({ paymentStatus: "PENDING", status: "PAYMENT_PENDING" });
  });

  it.each([
    {
      nextStatus: "FAILED",
      paymentStatus: "FAILED",
      paymentFailureReason: "Payment marked failed by an administrator",
    },
    { nextStatus: "CANCELLED", paymentStatus: "CANCELLED", paymentFailureReason: null },
  ])(
    "atomically keeps a payment-pending order coherent when transitioning to $nextStatus",
    async ({ nextStatus, paymentStatus, paymentFailureReason }) => {
      await pool.query(
        `UPDATE "orders" SET status = 'PAYMENT_PENDING', "paymentStatus" = 'PENDING' WHERE "orderId" = $1`,
        [ADMIN_FIXTURE.orderId],
      );
      const token = await adminToken(request.agent(app.getHttpServer()));
      const mutation = `mutation Transition($input: TransitionOrderInput!) {
        transitionOrder(input: $input) {
          orderId status paymentStatus paymentFailureReason auditLogs { metadataJson }
        }
      }`;
      const response = await graphql(app, token, mutation, {
        input: { orderId: ADMIN_FIXTURE.orderId, nextStatus },
      });
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.transitionOrder).toMatchObject({
        status: nextStatus,
        paymentStatus,
        paymentFailureReason,
      });
      const metadata = JSON.parse(response.body.data.transitionOrder.auditLogs[0].metadataJson) as Record<
        string,
        unknown
      >;
      expect(metadata).toMatchObject({
        previousStatus: "PAYMENT_PENDING",
        nextStatus,
        previousPaymentStatus: "PENDING",
        nextPaymentStatus: paymentStatus,
        paymentFailureReason,
      });
      const order = await pool.query<{
        paymentFailureReason: string | null;
        paymentStatus: string;
        status: string;
      }>(`SELECT status, "paymentStatus", "paymentFailureReason" FROM "orders" WHERE "orderId" = $1`, [
        ADMIN_FIXTURE.orderId,
      ]);
      expect(order.rows[0]).toEqual({ status: nextStatus, paymentStatus, paymentFailureReason });
    },
  );

  it("validates category hierarchy, uniqueness, and deactivation constraints", async () => {
    const token = await adminToken(request.agent(app.getHttpServer()));
    const createMutation = `mutation Create($input: CreateCategoryInput!) {
      createCategory(input: $input) { categoryId name slug parentId sortOrder isActive }
    }`;
    const invalid = await graphql(app, token, createMutation, {
      input: { name: "Invalid", slug: "Invalid_Slug" },
    });
    expect(invalid.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");

    const parent = await graphql(app, token, createMutation, {
      input: { name: "Accessories", slug: "admin-accessories", sortOrder: 3 },
    });
    const parentId = parent.body.data.createCategory.categoryId as string;
    const child = await graphql(app, token, createMutation, {
      input: { name: "Bags", slug: "admin-bags", parentId, sortOrder: 1 },
    });
    const childId = child.body.data.createCategory.categoryId as string;
    const duplicate = await graphql(app, token, createMutation, {
      input: { name: "Duplicate", slug: "admin-accessories" },
    });
    expect(duplicate.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");

    const updateMutation = `mutation Update($input: UpdateCategoryInput!) {
      updateCategory(input: $input) { categoryId parentId isActive sortOrder }
    }`;
    const cycle = await graphql(app, token, updateMutation, { input: { categoryId: parentId, parentId: childId } });
    expect(cycle.body.errors[0].message).toBe("Category hierarchy cannot contain a cycle");
    const activeChild = await graphql(app, token, updateMutation, {
      input: { categoryId: parentId, isActive: false },
    });
    expect(activeChild.body.errors[0].message).toBe("Category has active child categories");
    const publicProduct = await graphql(app, token, updateMutation, {
      input: { categoryId: FIXTURE.categoryId, isActive: false },
    });
    expect(publicProduct.body.errors[0].message).toBe("Category has public products");
    const updated = await graphql(app, token, updateMutation, { input: { categoryId: childId, sortOrder: 7 } });
    expect(updated.body.data.updateCategory.sortOrder).toBe(7);
  });

  it("creates, revokes, expires, and consumes hash-only admin invites once", async () => {
    const token = await adminToken(request.agent(app.getHttpServer()));
    const createMutation = `mutation Invite($input: CreateAdminInviteInput!) {
      createAdminInvite(input: $input) { inviteId email status expiresAt }
    }`;
    const existing = await graphql(app, token, createMutation, { input: { email: "integration@example.test" } });
    expect(existing.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    const registered = await graphql(app, token, createMutation, { input: { email: ADMIN_FIXTURE.email } });
    expect(registered.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");
    const failedDelivery = await graphql(app, token, createMutation, {
      input: { email: "failed-delivery@example.test" },
    });
    expect(failedDelivery.body.errors).toBeUndefined();
    const queued = await pool.query<{ status: string }>(
      `SELECT o."status"
       FROM "adminInvites" i
       JOIN "emailDeliveryOutbox" o ON o."proofId" = i."inviteId"::text
       WHERE i."email" = 'failed-delivery@example.test'`,
    );
    expect(queued.rows).toEqual([{ status: "PENDING" }]);
    const created = await graphql(app, token, createMutation, { input: { email: "second-admin@example.test" } });
    expect(created.body.errors).toBeUndefined();
    expect(created.body.data.createAdminInvite).not.toHaveProperty("token");

    const stored = await pool.query<{ tokenHash: string }>(
      `SELECT "tokenHash" FROM "adminInvites" WHERE "email" = 'second-admin@example.test'`,
    );
    expect(stored.rows[0]?.tokenHash).toMatch(/^[a-f0-9]{64}$/);

    const acceptMutation = `mutation Accept($input: AcceptAdminInviteInput!) {
      acceptAdminInvite(input: $input) { inviteId email status acceptedAt }
    }`;
    const accepted = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: acceptMutation,
        variables: {
          input: { token: ADMIN_FIXTURE.inviteToken, userid: "accepted-admin", password: "AcceptedAdmin123!" },
        },
      });
    expect(accepted.body.errors).toBeUndefined();
    expect(accepted.body.data.acceptAdminInvite.status).toBe("ACCEPTED");
    const reused = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: acceptMutation,
        variables: {
          input: { token: ADMIN_FIXTURE.inviteToken, userid: "second-accept", password: "AcceptedAdmin123!" },
        },
      });
    expect(reused.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");

    const acceptedAgent = request.agent(app.getHttpServer());
    const acceptedToken = await signin(acceptedAgent, "Bo", "accepted-admin", "AcceptedAdmin123!");
    expect(acceptedToken).toEqual(expect.any(String));

    const revokedToken = "revoked-admin-token";
    const revokedId = "a1000000-0000-4000-8000-000000000002";
    await pool.query(
      `INSERT INTO "adminInvites" ("inviteId", "email", "tokenHash", "invitedByUserId", "expiresAt")
       VALUES ($1, 'revoked-admin@example.test', $2, $3, now() + interval '1 day')`,
      [revokedId, hashToken(revokedToken), ADMIN_FIXTURE.userId],
    );
    const revoked = await graphql(
      app,
      token,
      `mutation { revokeAdminInvite(input: { inviteId: "${revokedId}" }) { status revokedAt } }`,
    );
    expect(revoked.body.data.revokeAdminInvite.status).toBe("REVOKED");
    const revokedAccept = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: acceptMutation,
        variables: { input: { token: revokedToken, userid: "revoked-admin", password: "AcceptedAdmin123!" } },
      });
    expect(revokedAccept.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");

    await pool.query(
      `INSERT INTO "adminInvites" ("email", "tokenHash", "invitedByUserId", "expiresAt")
       VALUES ('expired-admin@example.test', $1, $2, now() - interval '1 second')`,
      [hashToken("expired-admin-token"), ADMIN_FIXTURE.userId],
    );
    const expired = await request(app.getHttpServer())
      .post("/graphql")
      .send({
        query: acceptMutation,
        variables: {
          input: { token: "expired-admin-token", userid: "expired-admin", password: "AcceptedAdmin123!" },
        },
      });
    expect(expired.body.errors[0].extensions.code).toBe("BAD_USER_INPUT");

    const schema = await request(app.getHttpServer()).post("/graphql").send({
      query: `{ __type(name: "AdminInviteType") { fields { name } } }`,
    });
    expect(schema.body.data.__type.fields.map(({ name }: { name: string }) => name)).not.toContain("token");
  });

  it("never sends an admin invite from a transaction that fails to commit", async () => {
    const token = await adminToken(request.agent(app.getHttpServer()));
    const sender = app.get<EmailSender>("EmailSender");
    const sendLink = jest.spyOn(sender, "sendLink").mockResolvedValue(undefined);
    await pool.query(`
      CREATE FUNCTION reject_admin_invite_commit() RETURNS trigger AS $$
      BEGIN
        IF NEW."email" = 'commit-failure@example.test' THEN
          RAISE EXCEPTION 'blocked admin invite commit';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await pool.query(`
      CREATE CONSTRAINT TRIGGER reject_admin_invite_commit
      AFTER INSERT ON "emailDeliveryOutbox"
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION reject_admin_invite_commit()
    `);

    let response;
    try {
      response = await graphql(
        app,
        token,
        `
          mutation Invite($input: CreateAdminInviteInput!) {
            createAdminInvite(input: $input) {
              inviteId
            }
          }
        `,
        { input: { email: "commit-failure@example.test" } },
      );
    } finally {
      await pool.query(`DROP TRIGGER reject_admin_invite_commit ON "emailDeliveryOutbox"`);
      await pool.query(`DROP FUNCTION reject_admin_invite_commit()`);
    }

    expect(response.body.errors).toBeDefined();
    expect(sendLink).not.toHaveBeenCalled();
    const rows = await pool.query(
      `SELECT 1 FROM "adminInvites" WHERE "email" = 'commit-failure@example.test'
       UNION ALL
       SELECT 1 FROM "emailDeliveryOutbox" WHERE "email" = 'commit-failure@example.test'`,
    );
    expect(rows.rowCount).toBe(0);
  });

  it("delivers an admin invite through the shared worker only after its transaction commits", async () => {
    const token = await adminToken(request.agent(app.getHttpServer()));
    const sender = app.get<EmailSender>("EmailSender");
    const sendLink = jest.spyOn(sender, "sendLink").mockResolvedValue(undefined);
    const created = await graphql(
      app,
      token,
      `
        mutation Invite($input: CreateAdminInviteInput!) {
          createAdminInvite(input: $input) {
            inviteId
            email
          }
        }
      `,
      { input: { email: "worker-admin@example.test" } },
    );

    expect(created.body.errors).toBeUndefined();
    expect(sendLink).not.toHaveBeenCalled();
    const before = await pool.query<{ status: string }>(`
      SELECT "status" FROM "emailDeliveryOutbox" WHERE "email" = 'worker-admin@example.test'
    `);
    expect(before.rows).toEqual([{ status: "PENDING" }]);

    await app.get(EmailDeliveryWorker).runOnce(new Date(Date.now() + 1_000));

    expect(sendLink).toHaveBeenCalledWith(
      "worker-admin@example.test",
      "다담장 관리자 초대",
      expect.stringMatching(/^http:\/\/localhost:3001\/invite\/accept#token=[A-Za-z0-9_-]+$/),
      expect.stringMatching(/^email-delivery\/[0-9a-f-]+$/),
    );
    const after = await pool.query<{ status: string }>(`
      SELECT "status" FROM "emailDeliveryOutbox" WHERE "email" = 'worker-admin@example.test'
    `);
    expect(after.rows).toEqual([{ status: "SENT" }]);
  });

  it("filters immutable audit logs by actor, action, entity, and date", async () => {
    const token = await adminToken(request.agent(app.getHttpServer()));
    await graphql(
      app,
      token,
      `mutation { reviewProduct(input: { productId: "${ADMIN_FIXTURE.productId}", approved: true }) { productId } }`,
    );
    const logs = await graphql(
      app,
      token,
      `
        query Logs($filter: AdminAuditLogFilterInput) {
          adminAuditLogs(filter: $filter) {
            nodes {
              actorUserId
              actorUserid
              action
              entityType
              entityId
              metadataJson
            }
            nextCursor
            hasNextPage
            totalCount
          }
        }
      `,
      {
        filter: {
          actorUserId: ADMIN_FIXTURE.userId,
          action: "PRODUCT_APPROVED",
          entityType: "PRODUCT",
          createdFrom: new Date(Date.now() - 60_000).toISOString(),
          createdTo: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    );
    expect(logs.body.errors).toBeUndefined();
    expect(logs.body.data.adminAuditLogs.nodes).toEqual([
      expect.objectContaining({
        actorUserId: ADMIN_FIXTURE.userId,
        actorUserid: ADMIN_FIXTURE.userid,
        action: "PRODUCT_APPROVED",
        entityType: "PRODUCT",
        entityId: ADMIN_FIXTURE.productId,
      }),
    ]);
    expect(JSON.parse(logs.body.data.adminAuditLogs.nodes[0].metadataJson)).toEqual(
      expect.objectContaining({ previousStatus: "PENDING", nextStatus: "APPROVED" }),
    );
  });
});
