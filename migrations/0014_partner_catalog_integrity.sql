DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "products" product
    LEFT JOIN "partners" partner ON partner."partnerId" = product."partnerId"
    WHERE partner."brandId" IS NULL
       OR (product."brandId" IS NOT NULL AND product."brandId" <> partner."brandId")
  ) THEN
    RAISE EXCEPTION 'partner catalog brand backfill failed: missing or mismatched partner brand';
  END IF;
END $$;

UPDATE "products" product
SET "brandId" = partner."brandId"
FROM "partners" partner
WHERE product."partnerId" = partner."partnerId"
  AND product."brandId" IS NULL;

ALTER TABLE "productSkus" ADD COLUMN "position" integer;

WITH ordered AS (
  SELECT "skuId", row_number() OVER (PARTITION BY "productId" ORDER BY "createdAt", "skuId") - 1 AS position
  FROM "productSkus"
)
UPDATE "productSkus" sku
SET "position" = ordered.position
FROM ordered
WHERE ordered."skuId" = sku."skuId";

ALTER TABLE "productSkus" ALTER COLUMN "position" SET NOT NULL;
CREATE INDEX "product_skus_product_position_idx" ON "productSkus" ("productId", "position", "skuId");
