-- 0091: a run is one message in the thread that commissioned it.
--
-- ## The gap this closes
--
-- A deep-research run and a task run produce work a person waited for, and
-- neither of them has a place in the conversation where that person asked. A
-- deep-research run streams into a side panel that vanishes on reload; a
-- scheduled run materialises a WHOLE CONVERSATION per fire (`createRunConversation`,
-- `lib/jobs/service.ts`), so a weekly task deposits 52 threads a year that
-- nobody reads twice. Both shapes lose the same fact: what the run DID.
--
-- The design of record (PR 1, ADR-0062) makes a run ONE assistant message in
-- the conversation it was commissioned in, carrying a **run ledger** —
-- `messages.metadata.run_ledger`, sanitised on write and on read exactly as
-- `retrieval_ledger` is (`lib/runs/run-ledger.ts`). That needs two facts the
-- schema does not hold: which run a message belongs to, and which message a run
-- writes into.
--
-- ## Why two columns and not a table
--
-- The ledger is metadata ON a message, like every other transparency payload
-- this product stores (`retrieval_ledger`, `answerMeta`, `stages`). A
-- `run_ledgers` table would be a second home for one message's own account,
-- with a join on the hottest read in the product and two rows that can disagree
-- about a run's status. So: one text column on `messages` naming the run, one
-- uuid on `task_runs` naming the message, and the ledger itself in the jsonb
-- that is already there.
--
-- `messages.run_id` is `text` and NOT a foreign key, for the reason
-- `document_versions.origin_conversation_id` (0084) and `job_runs.conversation_id`
-- are: the honest constraint here would be composite with the tenant column, it
-- is worth its cost on a row that decides access and is not worth it on one that
-- decides rendering. A run deleted out from under a message leaves a string that
-- resolves to nothing, and every reader treats that as „kein Lauf".
--
-- `task_runs.run_message_id` is the same bargain in the other direction, and it
-- is deliberately nullable: every run that predates this migration has no
-- message, and a run whose conversation was deleted must keep its history rather
-- than cascade away with it.
--
-- ## RLS
--
-- Untouched, and this migration is deliberately NOT in `BOUNDARY_MIGRATIONS`.
-- There is no new table: `messages` was secured by 0031 (on its own
-- `organization_id`, not a subquery) and `task_runs` by 0086, and a column does
-- not move a table's policy. `rls-coverage.spec.ts` reads the drizzle schema for
-- TABLES, so nothing here needs a `grid_secure_table` line — adding one would
-- claim a boundary change that did not happen.
--
-- ## What this migration does NOT do, and why
--
-- The design also asks for a partial unique index enforcing „one thread per
-- standing task definition":
--
--     CREATE UNIQUE INDEX uniq_conversations_definition
--       ON conversations (job_id) WHERE job_id IS NOT NULL;
--
-- **It cannot be created on live data.** `conversations.job_id` has meant „the
-- definition whose fire produced this thread" since 0044, and `submitAgentRun`
-- stamps it on a NEW conversation at every fire (`lib/jobs/service.ts`, the
-- `output: 'chat'` arm). Every recurring chat definition therefore already has
-- as many conversations as it has fires, and this index would fail at deploy on
-- exactly the deployments that use the feature. Dropping the duplicates' `job_id`
-- to make it succeed would delete the provenance that identifies them as run
-- output, which is the one thing the design says to keep.
--
-- So the invariant is enforced UPSTREAM instead, at no cost and with no
-- backfill: the standing thread's id is DERIVED from the definition id (uuid5,
-- the same trick `conversation_output._message_id` uses for a job's turn and
-- `createRunMessage` uses below), so `conversations`' own primary key plus
-- `ON CONFLICT DO NOTHING` makes „ensure the thread" idempotent and concurrent
-- fires converge on one row. A unique index would have added nothing the primary
-- key does not already give, and it would have cost a failed deploy.

--> statement-breakpoint
ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "run_id" text;

--> statement-breakpoint
COMMENT ON COLUMN "messages"."run_id" IS
  'The task_runs row this message is the account of (PR 1, ADR-0062). Set on the ONE assistant message a run writes into, which carries the run ledger in metadata.run_ledger; NULL on every message a person or an ordinary turn wrote. Rendering and lookup only — never authorization, which comes from the conversation.';

--> statement-breakpoint
-- Partial, because a run message is a small minority of all messages and an
-- index entry per chat message would be paid for on every insert. Drizzle's
-- index builder cannot express a partial index, so it lives only here — the same
-- arrangement as `conversations_job_id_idx` and `idx_task_definitions_due`.
CREATE INDEX IF NOT EXISTS "idx_messages_run_id"
  ON "messages" ("run_id")
  WHERE "run_id" IS NOT NULL;

--> statement-breakpoint
ALTER TABLE "task_runs"
  ADD COLUMN IF NOT EXISTS "run_message_id" uuid;

--> statement-breakpoint
COMMENT ON COLUMN "task_runs"."run_message_id" IS
  'The assistant message this run writes its ledger and its report into, in the conversation the work was commissioned in (PR 1, ADR-0062). Minted deterministically from the run id (uuid5) so a retried submit is a no-op. NULL for every run created before this migration and for a run whose message could not be created; a run without one still runs.';
