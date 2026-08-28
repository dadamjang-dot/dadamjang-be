ALTER TABLE "partners"
  ADD CONSTRAINT "partners_owner_user_unique" UNIQUE ("ownerUserId");
