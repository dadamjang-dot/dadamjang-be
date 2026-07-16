ALTER TABLE "wishlists" RENAME TO "wishes";
ALTER TABLE "wishes" RENAME COLUMN "wishlistId" TO "wishId";
ALTER INDEX "wishlists_user_created_idx" RENAME TO "wishes_user_created_idx";
