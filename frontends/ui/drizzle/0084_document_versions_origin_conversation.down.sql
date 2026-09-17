-- Reverse 0084: a version forgets which conversation filed it.
--
-- Dropping the column drops provenance, not state: no lifecycle transition, no
-- permission and no CHECK reads it. What stops working is the `REVIEW_DECISIONS
-- v1` block — the next turn of a conversation stops hearing that its draft was
-- sent back — and the revision effect then treats every refused version as
-- unattended, which is the pre-0084 behaviour rather than a broken one.
--
-- The index goes with it: it exists only to serve that lookup.

DROP INDEX IF EXISTS "idx_document_versions_origin_conversation";

ALTER TABLE "document_versions" DROP COLUMN IF EXISTS "origin_conversation_id";
