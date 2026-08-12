DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "products") THEN
    RAISE EXCEPTION 'a source product is required to seed catalog products';
  END IF;
END $$;

WITH seed_products ("title", "description", "image_url", "is_on_sale", "is_express") AS (
  VALUES
    ('임시 슈퍼세일 오버핏 반팔 티셔츠', '슈퍼세일 UI 상태 확인용 상품', 'https://picsum.photos/seed/dadamjang-super-sale/400/512', true, false),
    ('임시 바로배송 오버핏 반팔 티셔츠', '바로배송 UI 상태 확인용 상품', 'https://picsum.photos/seed/dadamjang-express/400/512', false, true),
    ('임시 슈퍼세일 바로배송 오버핏 반팔 티셔츠', '슈퍼세일과 바로배송 UI 상태 확인용 상품', 'https://picsum.photos/seed/dadamjang-super-sale-express/400/512', true, true)
)
INSERT INTO "products" (
  "partnerId",
  "categoryId",
  "title",
  "description",
  "imageUrls",
  "status",
  "approvalStatus",
  "isOnSale",
  "isExpressDelivery",
  "publishedAt"
)
SELECT
  source."partnerId",
  source."categoryId",
  seed."title",
  seed."description",
  jsonb_build_array(seed."image_url"),
  'PUBLISHED',
  'APPROVED',
  seed."is_on_sale",
  seed."is_express",
  now()
FROM seed_products seed
CROSS JOIN (
  SELECT "partnerId", "categoryId"
  FROM "products"
  ORDER BY "createdAt", "productId"
  LIMIT 1
) source
WHERE NOT EXISTS (
  SELECT 1
  FROM "products" existing
  WHERE existing."title" = seed."title"
);

WITH seed_skus ("title", "code", "option_name", "price") AS (
  VALUES
    ('임시 슈퍼세일 오버핏 반팔 티셔츠', 'temporary-super-sale-tee-sale', '세일 옵션', 14900),
    ('임시 슈퍼세일 오버핏 반팔 티셔츠', 'temporary-super-sale-tee-base', '정상 옵션', 29900),
    ('임시 바로배송 오버핏 반팔 티셔츠', 'temporary-express-tee-default', '기본 옵션', 24900),
    ('임시 슈퍼세일 바로배송 오버핏 반팔 티셔츠', 'temporary-super-sale-express-tee-sale', '세일 옵션', 17900),
    ('임시 슈퍼세일 바로배송 오버핏 반팔 티셔츠', 'temporary-super-sale-express-tee-base', '정상 옵션', 34900)
)
INSERT INTO "productSkus" ("productId", "code", "optionName", "price", "stock")
SELECT product."productId", seed."code", seed."option_name", seed."price", 100
FROM seed_skus seed
JOIN "products" product ON product."title" = seed."title"
WHERE NOT EXISTS (
  SELECT 1
  FROM "productSkus" existing
  WHERE existing."code" = seed."code"
);
