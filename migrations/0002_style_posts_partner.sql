CREATE TABLE "stylePosts" (
  "stylePostId" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "authorId" uuid NOT NULL REFERENCES "users"("userId"),
  "title" varchar(200) NOT NULL,
  "content" text NOT NULL,
  "imageUrls" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "isPartner" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX "style_posts_author_created_idx" ON "stylePosts" ("authorId", "createdAt");
