-- Existing users get '' (matches no PIN); they set one through the password reset route.
ALTER TABLE "User" ADD COLUMN "pinHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ALTER COLUMN "pinHash" DROP DEFAULT;
