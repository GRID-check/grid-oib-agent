-- 0121: a verdict names the bytes it judged (ADR-0083, amended 2026-10-08).
--
-- `screening_outcome` was a fact about "the current bytes" that every writer of
-- `storage_key`/`content_hash` had to remember to reset. The upload's replace
-- did; publishing a draft of a person's document, and a content write to a
-- version that mirrors the item, swapped the bytes and kept the old `clean`, so
-- the new bytes reached every member unscreened.
--
-- `screened_hash` is the `content_hash` of the bytes the verdict (or, with
-- screening off, the completed read) was about. It is written with the verdict,
-- from the hash the dispatch recorded beside its job id, and the visibility
-- predicate passes a person's upload only while it equals `content_hash`. A
-- writer that swaps the bytes and forgets the verdict now holds the file back
-- instead of vouching for it.
--
-- Existing rows keep what they show today: their verdict is taken to be about
-- their current bytes, which is what every reader assumed until now.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "screened_hash" text;
--> statement-breakpoint
UPDATE "documents" SET "screened_hash" = "content_hash" WHERE "authored_by" = 'user' AND "screened_hash" IS NULL;
