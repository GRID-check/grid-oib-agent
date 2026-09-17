-- 0084: a version remembers the conversation it was filed from.
--
-- ## The gap
--
-- ADR-0054 gave a document versions and a review round; ADR-0051 gave delegated
-- work a row that carries a reviewer's decision into the next attempt. Between
-- them sat the one case neither closed: a reviewer presses „Änderungen
-- anfordern" on a draft a chat turn wrote, and the comment reaches the Files
-- pane and nowhere else. The next turn of the very conversation that wrote the
-- draft knows nothing about it, and asks the reader what to change.
--
-- Closing that needs one fact the table did not hold: WHICH conversation this
-- version came out of. The internal filing route already receives it — the
-- signed request-context envelope carries `conversationId`, and the route
-- authorizes on that verified copy (ADR-0054 §4) — so the value is asserted by
-- this tier rather than chosen by the caller. It was simply not written down.
--
-- ## What the column is, and what it is not
--
-- Nullable, and null is the ordinary case: a human upload, a scheduled
-- deep-research report, a version forked from the Files pane. It is PROVENANCE,
-- never authorization: nothing reads it to decide who may act. Two readers,
-- both of them additive:
--
--   * `buildReviewDecisionsBlock` (`lib/documents/review-decisions.ts`) renders
--     a `REVIEW_DECISIONS v1` block for the next turn of that conversation, the
--     way `PROPOSAL_DECISIONS` already rides the memory channel;
--   * the `request_changes` transition's revision effect, which creates a
--     `revision` task exactly when the origin was NOT a live conversation —
--     because a conversation gets the block instead, and work with nobody
--     typing needs a row.
--
-- `text` and not a foreign key, for the reason `job_runs.conversation_id` is
-- text without one: `conversations.id` is text and the honest constraint is the
-- composite `(conversation_id, organization_id)`, which is worth its cost on a
-- row that decides access and is not worth it on one that decides prose. A
-- conversation deleted out from under a version leaves a string that resolves
-- to nothing, and every reader treats that as "no origin".
--
-- ## RLS
--
-- Untouched. `document_versions` was secured by 0082's `grid_secure_table` and
-- a column does not move a table's policy; the tenant boundary is unchanged and
-- this migration is deliberately NOT in `BOUNDARY_MIGRATIONS`.

--> statement-breakpoint
ALTER TABLE "document_versions"
  ADD COLUMN IF NOT EXISTS "origin_conversation_id" text;

--> statement-breakpoint
COMMENT ON COLUMN "document_versions"."origin_conversation_id" IS
  'The chat conversation this version was filed from, read off the VERIFIED request-context envelope at the internal filing route (ADR-0054 §4) and never off the request body. NULL for a human upload, a scheduled run and any version created from the Files pane. Provenance only: it decides what the next turn of that conversation is told about a review decision, and whether a refused version needs a revision task, never who may act.';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_versions_origin_conversation"
  ON "document_versions" ("origin_conversation_id", "reviewed_at" DESC)
  WHERE "origin_conversation_id" IS NOT NULL;
