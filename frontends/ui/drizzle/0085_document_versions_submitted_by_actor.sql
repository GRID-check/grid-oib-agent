-- 0085: a submission remembers whose hand made it.
--
-- ## The gap this closes
--
-- ADR-0054 put one guard on `approve` that a CHECK cannot see: **the submitter
-- may not approve their own version.** „Freigabe" is the office asserting the
-- content, and an assertion nobody but the author has read is not one.
--
-- That rule was written for a person submitting a document they wrote. It is
-- read by the code as „the user id in `submitted_by`", and for a version Piloti
-- filed that id is not the author at all — it is the COMMISSIONING human, whose
-- session the agent acted in. `fileResearchReport` submits with the requester
-- as the reviewer and the requester in `submitted_by`, so the one person who
-- asked for the report was the one person forbidden to release it. The
-- Ziviltechniker who ordered a Befund could not sign it off.
--
-- Two facts were collapsed into one column, and this migration separates them.
-- `submitted_by` stays WHOSE AUTHORITY the submission carried — permissions,
-- audit, the inbox all read it and none of them changes. The new column says
-- WHOSE HAND it was, and it is the one the guard reads: a submission a machine
-- made is not a self-assertion by the person it was made for, so approving it
-- is a first human reading rather than a second look at your own work.
--
-- ## Why a column and not an inference
--
-- The alternative was to derive it — „`created_by` is an agent producer, so the
-- submit must have been the agent's". It is not derivable: a person may submit
-- a draft Piloti wrote (that IS a human assertion of machine-written content,
-- and the guard should apply to whoever presses Freigeben afterwards), and a
-- run may submit a document a person forked. The fact belongs to the submit
-- ACT, so it is written when the act happens, from `TransitionInput.actingHuman`
-- — the same flag the publish door itself is built on, so a caller cannot claim
-- one thing to the door and another to the row.
--
-- DEFAULT 'human' and NOT NULL: every row that exists today was submitted
-- through a session route or backfilled by 0082, and 'human' is the reading
-- that keeps the existing guard exactly as strict as it was. A wrong default in
-- the other direction would silently waive it for the whole corpus.
--
-- ## RLS
--
-- Untouched. `document_versions` was secured by 0082's `grid_secure_table`, and
-- a column does not move a table's policy — the tenant predicate is unchanged
-- and this migration is deliberately NOT in `BOUNDARY_MIGRATIONS`.

--> statement-breakpoint
ALTER TABLE "document_versions"
  ADD COLUMN IF NOT EXISTS "submitted_by_actor" text DEFAULT 'human' NOT NULL;

--> statement-breakpoint
ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_submitted_by_actor_known"
  CHECK ("submitted_by_actor" IN ('human', 'agent'));

--> statement-breakpoint
COMMENT ON COLUMN "document_versions"."submitted_by_actor" IS
  'Whose HAND submitted this version, as opposed to whose AUTHORITY it carried (submitted_by). Written from TransitionInput.actingHuman at the submit transition. The not-the-submitter guard on approve applies only when this is ''human'': a version a run submitted in a person''s session was never that person''s own assertion, so their Freigabe is a first reading and not a second look at their own work.';
