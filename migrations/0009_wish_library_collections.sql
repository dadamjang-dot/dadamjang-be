CREATE TABLE IF NOT EXISTS "brandFollows" (
  "brandFollowId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "brandId" uuid NOT NULL REFERENCES "brands"("brandId") ON DELETE CASCADE,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "brand_follows_user_brand_unique" UNIQUE ("userId", "brandId")
);
CREATE INDEX IF NOT EXISTS "brand_follows_user_created_idx"
  ON "brandFollows" ("userId", "createdAt");

CREATE TABLE IF NOT EXISTS "recentProductViews" (
  "recentProductViewId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "productId" uuid NOT NULL REFERENCES "products"("productId") ON DELETE CASCADE,
  "viewedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "recent_product_views_user_product_unique" UNIQUE ("userId", "productId")
);
CREATE INDEX IF NOT EXISTS "recent_product_views_user_viewed_idx"
  ON "recentProductViews" ("userId", "viewedAt");
