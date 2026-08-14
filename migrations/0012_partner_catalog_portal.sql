ALTER TABLE "partners" ADD COLUMN "brandId" uuid REFERENCES "brands"("brandId");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "products"
    GROUP BY "partnerId"
    HAVING count(DISTINCT "brandId") FILTER (WHERE "brandId" IS NOT NULL) > 1
  ) THEN
    RAISE EXCEPTION 'partner catalog backfill failed: partner uses multiple brands';
  END IF;
END $$;

UPDATE "partners" p
SET "brandId" = source."brandId"
FROM (
  SELECT "partnerId", min("brandId"::text)::uuid AS "brandId"
  FROM "products"
  WHERE "brandId" IS NOT NULL
  GROUP BY "partnerId"
) source
WHERE source."partnerId" = p."partnerId";

INSERT INTO "brands" ("name", "slug", "isActive")
SELECT p."tradeName", 'partner-' || p."partnerId", true
FROM "partners" p
WHERE p."brandId" IS NULL
ON CONFLICT ("slug") DO NOTHING;

UPDATE "partners" p
SET "brandId" = b."brandId"
FROM "brands" b
WHERE p."brandId" IS NULL AND b."slug" = 'partner-' || p."partnerId";

ALTER TABLE "partners" ADD CONSTRAINT "partners_brand_unique" UNIQUE ("brandId");
ALTER TABLE "products" ADD COLUMN "imageKeys" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "products" ALTER COLUMN "approvalStatus" SET DEFAULT 'DRAFT';
CREATE INDEX "products_partner_portal_idx" ON "products" ("partnerId", "approvalStatus", "updatedAt" DESC, "productId" DESC);
