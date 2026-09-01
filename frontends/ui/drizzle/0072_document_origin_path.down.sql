-- Down for 0072. The column is additive and carries no constraint, so dropping
-- it loses only the recorded origin paths — which are not recoverable from
-- anything else, and are not depended on by any other column.
ALTER TABLE "documents" DROP COLUMN IF EXISTS "origin_path";
