CREATE TABLE "brands" (
  "brandId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(100) NOT NULL,
  "slug" varchar(120) NOT NULL UNIQUE,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "brands_active_name_idx" ON "brands" ("isActive", "name");

CREATE TABLE "colors" (
  "colorId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(80) NOT NULL,
  "slug" varchar(100) NOT NULL UNIQUE,
  "hexCode" varchar(7),
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "colors_active_name_idx" ON "colors" ("isActive", "name");

CREATE TABLE "sizes" (
  "sizeId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" varchar(80) NOT NULL,
  "slug" varchar(100) NOT NULL UNIQUE,
  "sortOrder" integer NOT NULL DEFAULT 0,
  "isActive" boolean NOT NULL DEFAULT true,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "sizes_active_sort_idx" ON "sizes" ("isActive", "sortOrder", "name");

ALTER TABLE "products"
  ADD COLUMN "brandId" uuid REFERENCES "brands"("brandId"),
  ADD COLUMN "isOnSale" boolean NOT NULL DEFAULT false,
  ADD COLUMN "isExpressDelivery" boolean NOT NULL DEFAULT false;
CREATE INDEX "products_brand_idx" ON "products" ("brandId", "status");
CREATE INDEX "products_catalog_flags_idx" ON "products" ("status", "isOnSale", "isExpressDelivery");

ALTER TABLE "productSkus"
  ADD COLUMN "colorId" uuid REFERENCES "colors"("colorId"),
  ADD COLUMN "sizeId" uuid REFERENCES "sizes"("sizeId");
CREATE INDEX "product_skus_color_idx" ON "productSkus" ("colorId", "productId");
CREATE INDEX "product_skus_size_idx" ON "productSkus" ("sizeId", "productId");

INSERT INTO "categories" ("name", "slug", "sortOrder") VALUES
  ('럭셔리', 'luxury', 1),
  ('상의', 'tops', 2),
  ('아우터', 'outerwear', 3),
  ('하의', 'bottoms', 4),
  ('신발', 'shoes', 5),
  ('가방', 'bags', 6),
  ('지갑', 'wallets', 7),
  ('시계', 'watches', 8)
ON CONFLICT ("slug") DO NOTHING;
