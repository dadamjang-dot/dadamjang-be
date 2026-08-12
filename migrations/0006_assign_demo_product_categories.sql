WITH assignments ("title", "category_slug") AS (
  VALUES
    ('임시 슈퍼세일 오버핏 반팔 티셔츠', 'tops'),
    ('임시 슈퍼세일 바로배송 오버핏 반팔 티셔츠', 'outerwear'),
    ('임시 바로배송 오버핏 반팔 티셔츠', 'bottoms'),
    ('임시 오버핏 반팔 티셔츠', 'wallets')
)
UPDATE "products" product
SET
  "categoryId" = category."categoryId",
  "updatedAt" = now()
FROM assignments assignment
JOIN "categories" category ON category."slug" = assignment."category_slug"
WHERE product."title" = assignment."title";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "products" product
    JOIN "categories" category ON category."categoryId" = product."categoryId"
    WHERE category."slug" = 'clothing'
  ) THEN
    RAISE EXCEPTION 'products still reference clothing category';
  END IF;
END $$;

DELETE FROM "categories"
WHERE "slug" = 'clothing';
