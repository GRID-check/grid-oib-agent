-- Reverse 0121. The predicate then trusts `screening_outcome` alone again.
ALTER TABLE "documents" DROP COLUMN IF EXISTS "screened_hash";
