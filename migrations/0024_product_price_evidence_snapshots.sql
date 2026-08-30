CREATE TABLE "productPriceEvidenceSnapshots" (
  "productId" uuid PRIMARY KEY REFERENCES "products"("productId") ON DELETE CASCADE,
  "revision" uuid NOT NULL UNIQUE,
  "source" varchar(80) NOT NULL,
  "basePrice" integer NOT NULL CONSTRAINT "product_price_evidence_base_price_check" CHECK ("basePrice" >= 0),
  "finalPrice" integer NOT NULL CONSTRAINT "product_price_evidence_final_price_check" CHECK ("finalPrice" >= 0),
  "recordedAt" timestamp NOT NULL,
  "verifiedAt" timestamp NOT NULL,
  CONSTRAINT "product_price_evidence_price_order_check" CHECK ("basePrice" >= "finalPrice"),
  CONSTRAINT "product_price_evidence_verification_time_check" CHECK ("verifiedAt" >= "recordedAt")
);

CREATE FUNCTION refresh_product_price_evidence_snapshot(target_product_id uuid) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  active_sku_count integer;
  product_status varchar;
  snapshot_base_price integer;
  snapshot_final_price integer;
  snapshot_time timestamp;
BEGIN
  SELECT "status"
  INTO product_status
  FROM "products"
  WHERE "productId" = target_product_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF product_status <> 'PUBLISHED' THEN
    DELETE FROM "productPriceEvidenceSnapshots" WHERE "productId" = target_product_id;
    RETURN;
  END IF;

  SELECT
    count(*) FILTER (WHERE "isActive"),
    max("price") FILTER (WHERE "isActive"),
    min("price") FILTER (WHERE "isActive")
  INTO active_sku_count, snapshot_base_price, snapshot_final_price
  FROM "productSkus"
  WHERE "productId" = target_product_id;

  IF active_sku_count = 0 THEN
    DELETE FROM "productPriceEvidenceSnapshots" WHERE "productId" = target_product_id;
    RETURN;
  END IF;

  snapshot_time := clock_timestamp();

  INSERT INTO "productPriceEvidenceSnapshots" (
    "productId",
    "revision",
    "source",
    "basePrice",
    "finalPrice",
    "recordedAt",
    "verifiedAt"
  ) VALUES (
    target_product_id,
    gen_random_uuid(),
    'catalog_sku_price_snapshot',
    snapshot_base_price,
    snapshot_final_price,
    snapshot_time,
    snapshot_time
  )
  ON CONFLICT ("productId") DO UPDATE SET
    "revision" = EXCLUDED."revision",
    "source" = EXCLUDED."source",
    "basePrice" = EXCLUDED."basePrice",
    "finalPrice" = EXCLUDED."finalPrice",
    "recordedAt" = EXCLUDED."recordedAt",
    "verifiedAt" = EXCLUDED."verifiedAt"
  WHERE (
    "productPriceEvidenceSnapshots"."source",
    "productPriceEvidenceSnapshots"."basePrice",
    "productPriceEvidenceSnapshots"."finalPrice"
  ) IS DISTINCT FROM (
    EXCLUDED."source",
    EXCLUDED."basePrice",
    EXCLUDED."finalPrice"
  );
END;
$$;

CREATE FUNCTION refresh_product_price_evidence_snapshot_from_sku() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_product_price_evidence_snapshot(OLD."productId");
    RETURN OLD;
  END IF;

  PERFORM refresh_product_price_evidence_snapshot(NEW."productId");
  IF TG_OP = 'UPDATE' AND OLD."productId" <> NEW."productId" THEN
    PERFORM refresh_product_price_evidence_snapshot(OLD."productId");
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION refresh_product_price_evidence_snapshot_from_product() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM refresh_product_price_evidence_snapshot(NEW."productId");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "product_skus_price_evidence_snapshot_write_trigger"
AFTER INSERT OR DELETE ON "productSkus"
FOR EACH ROW EXECUTE FUNCTION refresh_product_price_evidence_snapshot_from_sku();

CREATE TRIGGER "product_skus_price_evidence_snapshot_update_trigger"
AFTER UPDATE OF "price", "isActive", "productId" ON "productSkus"
FOR EACH ROW EXECUTE FUNCTION refresh_product_price_evidence_snapshot_from_sku();

CREATE TRIGGER "products_price_evidence_snapshot_publish_trigger"
AFTER UPDATE OF "status" ON "products"
FOR EACH ROW
WHEN (OLD."status" IS DISTINCT FROM NEW."status")
EXECUTE FUNCTION refresh_product_price_evidence_snapshot_from_product();

SELECT refresh_product_price_evidence_snapshot("productId")
FROM "products"
WHERE "status" = 'PUBLISHED';
