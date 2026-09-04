-- Down for 0078. Additive, unconstrained, and not read by anything that would
-- break without it: dropping it loses the digests, which means the next folder
-- upload classifies every file it matches as an update rather than as
-- unchanged. That is the pre-0078 behaviour, not a failure.
ALTER TABLE "documents" DROP COLUMN IF EXISTS "content_hash";
