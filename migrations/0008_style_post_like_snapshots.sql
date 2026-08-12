ALTER TABLE "stylePostLikes"
  ADD COLUMN IF NOT EXISTS "deletedAt" timestamp;

ALTER TABLE "stylePostLikes"
  DROP CONSTRAINT IF EXISTS "style_post_likes_post_user_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "style_post_likes_active_unique"
  ON "stylePostLikes" ("stylePostId", "userId")
  WHERE "deletedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "style_post_likes_snapshot_idx"
  ON "stylePostLikes" ("stylePostId", "createdAt", "deletedAt");
