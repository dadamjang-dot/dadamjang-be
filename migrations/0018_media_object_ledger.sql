CREATE TABLE "mediaObjectPromotions" (
  "finalKey" text PRIMARY KEY,
  "ownerUserId" uuid NOT NULL,
  "kind" varchar(20) NOT NULL,
  "contentType" varchar(80) NOT NULL,
  "objectSize" integer,
  "finalEtag" text,
  "sourceBucket" varchar(255),
  "sourceKey" text,
  "sourceEtag" text,
  "status" varchar(20) NOT NULL,
  "unreferencedAt" timestamptz,
  "readyAt" timestamptz,
  "gcClaimedAt" timestamptz,
  "gcClaimToken" uuid,
  "gcPreviousStatus" varchar(20),
  "deletedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "media_object_promotions_kind_check" CHECK ("kind" IN ('PRODUCT', 'STYLE_POST')),
  CONSTRAINT "media_object_promotions_status_check" CHECK (
    "status" IN ('PREPARING', 'READY', 'DELETING', 'DELETED')
  ),
  CONSTRAINT "media_object_promotions_size_check" CHECK ("objectSize" IS NULL OR "objectSize" > 0),
  CONSTRAINT "media_object_promotions_source_check" CHECK (
    ("sourceBucket" IS NULL AND "sourceKey" IS NULL AND "sourceEtag" IS NULL)
    OR ("sourceBucket" IS NOT NULL AND "sourceKey" IS NOT NULL AND "sourceEtag" IS NOT NULL)
  ),
  CONSTRAINT "media_object_promotions_gc_claim_check" CHECK (
    (
      "status" = 'DELETING'
      AND "gcClaimedAt" IS NOT NULL
      AND "gcClaimToken" IS NOT NULL
      AND "gcPreviousStatus" IN ('PREPARING', 'READY')
    )
    OR (
      "status" <> 'DELETING'
      AND "gcClaimedAt" IS NULL
      AND "gcClaimToken" IS NULL
      AND "gcPreviousStatus" IS NULL
    )
  ),
  CONSTRAINT "media_object_promotions_deleted_check" CHECK (
    ("status" = 'DELETED' AND "deletedAt" IS NOT NULL)
    OR ("status" <> 'DELETED' AND "deletedAt" IS NULL)
  )
);

CREATE INDEX "media_object_promotions_gc_idx"
  ON "mediaObjectPromotions" ("unreferencedAt", "createdAt", "finalKey")
  WHERE "status" IN ('PREPARING', 'READY');

CREATE INDEX "media_object_promotions_stale_claim_idx"
  ON "mediaObjectPromotions" ("gcClaimedAt", "finalKey")
  WHERE "status" = 'DELETING';

CREATE TABLE "mediaObjectReferences" (
  "entityType" varchar(20) NOT NULL,
  "entityId" uuid NOT NULL,
  "finalKey" text NOT NULL REFERENCES "mediaObjectPromotions" ("finalKey") ON DELETE RESTRICT,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "media_object_references_pk" PRIMARY KEY ("entityType", "entityId", "finalKey"),
  CONSTRAINT "media_object_references_entity_type_check" CHECK ("entityType" IN ('PRODUCT', 'STYLE_POST'))
);

CREATE INDEX "media_object_references_final_key_idx"
  ON "mediaObjectReferences" ("finalKey");

WITH referenced_objects AS (
  SELECT DISTINCT ON ("finalKey") "finalKey", "ownerUserId", "kind", "contentType"
  FROM (
    SELECT
      image."finalKey",
      partner."ownerUserId",
      'PRODUCT'::varchar AS "kind",
      CASE substring(image."finalKey" from '\.([^.]+)$')
        WHEN 'jpg' THEN 'image/jpeg'
        WHEN 'png' THEN 'image/png'
        WHEN 'webp' THEN 'image/webp'
      END AS "contentType"
    FROM "products" product
    JOIN "partners" partner ON partner."partnerId" = product."partnerId"
    CROSS JOIN LATERAL unnest(product."imageKeys") AS image("finalKey")
    WHERE image."finalKey" ~ '^products/[0-9a-f-]{36}/[0-9a-f-]+\.(jpg|png|webp)$'

    UNION ALL

    SELECT
      image."finalKey",
      post."authorId" AS "ownerUserId",
      'STYLE_POST'::varchar AS "kind",
      CASE substring(image."finalKey" from '\.([^.]+)$')
        WHEN 'jpg' THEN 'image/jpeg'
        WHEN 'png' THEN 'image/png'
        WHEN 'webp' THEN 'image/webp'
        WHEN 'heic' THEN 'image/heic'
        WHEN 'heif' THEN 'image/heif'
      END AS "contentType"
    FROM "stylePosts" post
    CROSS JOIN LATERAL jsonb_array_elements_text(post."imageKeys") AS image("finalKey")
    WHERE image."finalKey" ~ '^style-posts/[0-9a-f-]{36}/[0-9a-f-]+\.(jpg|png|webp|heic|heif)$'
  ) source
  WHERE "contentType" IS NOT NULL
  ORDER BY "finalKey"
)
INSERT INTO "mediaObjectPromotions"
  ("finalKey", "ownerUserId", "kind", "contentType", "status", "readyAt")
SELECT "finalKey", "ownerUserId", "kind", "contentType", 'READY', now()
FROM referenced_objects
ON CONFLICT ("finalKey") DO NOTHING;

INSERT INTO "mediaObjectReferences" ("entityType", "entityId", "finalKey")
SELECT 'PRODUCT', product."productId", image."finalKey"
FROM "products" product
CROSS JOIN LATERAL unnest(product."imageKeys") AS image("finalKey")
JOIN "mediaObjectPromotions" promotion ON promotion."finalKey" = image."finalKey"
ON CONFLICT DO NOTHING;

INSERT INTO "mediaObjectReferences" ("entityType", "entityId", "finalKey")
SELECT 'STYLE_POST', post."stylePostId", image."finalKey"
FROM "stylePosts" post
CROSS JOIN LATERAL jsonb_array_elements_text(post."imageKeys") AS image("finalKey")
JOIN "mediaObjectPromotions" promotion ON promotion."finalKey" = image."finalKey"
ON CONFLICT DO NOTHING;
