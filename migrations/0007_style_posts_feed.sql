ALTER TABLE "stylePosts"
  ADD COLUMN IF NOT EXISTS "category" varchar(20) NOT NULL DEFAULT 'CLOTHING',
  ADD COLUMN IF NOT EXISTS "hashtags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "brandTagIds" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "imageKeys" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "idempotencyKey" varchar(120);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'style_posts_category_check'
  ) THEN
    ALTER TABLE "stylePosts"
      ADD CONSTRAINT "style_posts_category_check"
      CHECK ("category" IN ('SNEAKERS', 'CLOTHING', 'ACCESSORIES'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "style_posts_author_idempotency_unique"
  ON "stylePosts" ("authorId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "style_posts_category_created_idx"
  ON "stylePosts" ("category", "createdAt");

CREATE TABLE IF NOT EXISTS "stylePostProducts" (
  "stylePostProductId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "stylePostId" uuid NOT NULL REFERENCES "stylePosts"("stylePostId") ON DELETE CASCADE,
  "productId" uuid NOT NULL REFERENCES "products"("productId"),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "style_post_products_post_product_unique" UNIQUE ("stylePostId", "productId")
);
CREATE INDEX IF NOT EXISTS "style_post_products_post_idx"
  ON "stylePostProducts" ("stylePostId", "createdAt");

CREATE TABLE IF NOT EXISTS "stylePostLikes" (
  "stylePostLikeId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "stylePostId" uuid NOT NULL REFERENCES "stylePosts"("stylePostId") ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "style_post_likes_post_user_unique" UNIQUE ("stylePostId", "userId")
);
CREATE INDEX IF NOT EXISTS "style_post_likes_post_created_idx"
  ON "stylePostLikes" ("stylePostId", "createdAt");
CREATE INDEX IF NOT EXISTS "style_post_likes_user_created_idx"
  ON "stylePostLikes" ("userId", "createdAt");
