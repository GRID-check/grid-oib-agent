-- Reverting drops the stored mode; every thread then derives from its author
-- count, which is the same answer for any thread that never had it set by hand.
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "engagement";
