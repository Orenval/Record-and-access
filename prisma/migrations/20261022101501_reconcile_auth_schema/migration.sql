-- Reconcile the stale auth init migration with the current schema.
-- The initial migration was never applied to this database (the database was
-- provisioned from the current schema); it still declares three auth objects
-- that no longer exist in prisma/schema.prisma. Dropping them here makes the
-- migration history replay to exactly the current schema. This migration is
-- recorded as applied rather than executed against the existing database,
-- because the objects do not exist there.

-- AlterTable
ALTER TABLE "User" DROP COLUMN "emailVerified";

-- DropTable
DROP TABLE "VerificationCode";

-- DropTable
DROP TABLE "PasswordResetToken";
