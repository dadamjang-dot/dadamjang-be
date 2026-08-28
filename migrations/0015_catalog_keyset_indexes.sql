DROP INDEX "products_catalog_idx";

CREATE INDEX "products_catalog_default_keyset_idx"
ON "products" ("status", "createdAt" DESC, "productId" DESC);

CREATE INDEX "products_catalog_category_keyset_idx"
ON "products" ("status", "categoryId", "createdAt" DESC, "productId" DESC);
