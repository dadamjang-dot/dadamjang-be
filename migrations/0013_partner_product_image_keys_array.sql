-- Product image keys are queried and returned as an ordered PostgreSQL text array.
-- 0012 initially introduced the column as jsonb; preserve its data while making
-- the database representation match the catalog contract.
ALTER TABLE "products" ADD COLUMN "imageKeysArray" text[] NOT NULL DEFAULT ARRAY[]::text[];

UPDATE "products" p
SET "imageKeysArray" = source.keys
FROM (
  SELECT "productId", coalesce(array_agg(value ORDER BY ordinal) FILTER (WHERE value IS NOT NULL), ARRAY[]::text[]) AS keys
  FROM "products"
  LEFT JOIN LATERAL jsonb_array_elements_text("imageKeys") WITH ORDINALITY AS images(value, ordinal) ON true
  GROUP BY "productId"
) source
WHERE source."productId" = p."productId";

ALTER TABLE "products" DROP COLUMN "imageKeys";
ALTER TABLE "products" RENAME COLUMN "imageKeysArray" TO "imageKeys";
