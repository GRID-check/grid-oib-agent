-- Reverse 0033.
--
-- DESTRUCTIVE if per-organization buckets were ever enabled: dropping the
-- column discards the only record of which bucket each object is in, and the
-- read path falls back to the shared bucket for every row — so every object
-- written into a tenant bucket becomes unreachable. The bytes survive; the
-- pointer does not.
--
-- Before running this, set SEAWEED_PER_ORG_BUCKETS=false and move any object
-- out of a tenant bucket back into the shared one (the keys are identical, so
-- it is a copy, not a rewrite).

ALTER TABLE documents DROP COLUMN IF EXISTS storage_bucket;
