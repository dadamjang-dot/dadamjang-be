import { promises as fs } from "fs";
import path from "path";
import type { Pool } from "pg";
import { FIXTURE } from "src/database/fixtures";
import { testPool } from "./support/database";

describe("media object ledger migration", () => {
  let migration: string;
  let pool: Pool;

  beforeAll(async () => {
    pool = testPool();
    migration = await fs.readFile(path.join(process.cwd(), "migrations/0018_media_object_ledger.sql"), "utf8");
  });

  afterAll(async () => pool.end());

  it("backfills legacy product and style-post references without requiring object metadata", async () => {
    const productKey = `products/${FIXTURE.userId}/90000000-0000-4000-8000-000000000081.webp`;
    const stylePostId = "82000000-0000-4000-8000-000000000081";
    const styleKey = `style-posts/${FIXTURE.userId}/90000000-0000-4000-8000-000000000082.heic`;
    await pool.query("BEGIN");
    try {
      await pool.query(`DROP TABLE "mediaObjectReferences"`);
      await pool.query(`DROP TABLE "mediaObjectPromotions"`);
      await pool.query(`UPDATE "products" SET "imageKeys" = ARRAY[$2]::text[] WHERE "productId" = $1`, [
        FIXTURE.productId,
        productKey,
      ]);
      await pool.query(
        `INSERT INTO "stylePosts"
          ("stylePostId", "authorId", "title", "content", "category", "imageKeys", "imageUrls")
         VALUES ($1, $2, 'Legacy image', 'Legacy image', 'CLOTHING', $3::jsonb, '[]'::jsonb)`,
        [stylePostId, FIXTURE.userId, JSON.stringify([styleKey])],
      );

      await pool.query(migration);

      const promotions = await pool.query<{
        contentType: string;
        finalKey: string;
        kind: string;
        objectSize: number | null;
        sourceKey: string | null;
        status: string;
      }>(`
        SELECT "finalKey", "kind", "contentType", "objectSize", "sourceKey", "status"
        FROM "mediaObjectPromotions"
        ORDER BY "finalKey"
      `);
      expect(promotions.rows).toEqual([
        {
          contentType: "image/webp",
          finalKey: productKey,
          kind: "PRODUCT",
          objectSize: null,
          sourceKey: null,
          status: "READY",
        },
        {
          contentType: "image/heic",
          finalKey: styleKey,
          kind: "STYLE_POST",
          objectSize: null,
          sourceKey: null,
          status: "READY",
        },
      ]);
      const references = await pool.query<{ entityId: string; entityType: string; finalKey: string }>(`
        SELECT "entityType", "entityId", "finalKey"
        FROM "mediaObjectReferences"
        ORDER BY "entityType"
      `);
      expect(references.rows).toEqual([
        { entityId: FIXTURE.productId, entityType: "PRODUCT", finalKey: productKey },
        { entityId: stylePostId, entityType: "STYLE_POST", finalKey: styleKey },
      ]);
    } finally {
      await pool.query("ROLLBACK");
    }
  });
});
