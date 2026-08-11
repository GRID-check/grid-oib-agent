-- Conversations remember the job that produced them.
--
-- ## What this is for
--
-- A job with `output = 'chat'` materialises its run into a REAL conversation —
-- one the team opens, reads and keeps typing into. 0043 built the link in the
-- other direction (`job_runs.conversation_id`: "this run landed there"), which
-- answers the run-history question and only that one. It cannot answer the two
-- questions the conversation itself raises:
--
--   1. **Who is this thread?** A job conversation has a human owner
--      (`created_by` is the job's owner, a real user id — see the note below),
--      so with nothing else on the row the UI must render it as that person's
--      chat, with their face on it. It is not: nobody typed it. This column is
--      what lets the list render "Weekly OIB scan" with a job glyph instead.
--   2. **Where does it belong?** A weekly job is 52 threads a year. Left
--      indistinguishable they pile into its owner's personal chat history and
--      bury the chats they actually had. The client filters them out of the
--      sessions list by exactly this column, while the thread stays fully
--      openable by URL and from the job's run history.
--
-- Answering either from `job_runs` would mean a join — or worse a subquery —
-- on the hottest list read in the product, per row, to establish a fact that
-- never changes after insert. It is provenance, so it belongs on the row.
--
-- ## Why the FK is SET NULL and not CASCADE
--
-- Deleting a job must NOT delete its output. The conversations a job produced
-- are work product: they were read, replied to, and shared. Someone retiring a
-- recurring job is saying "stop running this", never "erase the eight
-- discussions it started". The thread survives with `job_id` NULL and reads
-- from then on as an ordinary conversation, which is the honest fallback — its
-- provenance genuinely no longer exists.
--
-- The reverse direction (0043's `job_runs.conversation_id`) is SET NULL for the
-- mirror-image reason: deleting a conversation must not delete run history.
-- Neither side owns the other.
--
-- ## Nullable, with no backfill
--
-- NULL means "a person started this", which is every conversation that exists
-- today and the great majority of every conversation that ever will. There is
-- nothing to backfill: before this migration no job wrote a conversation at all
-- (the fire path carried a `null` placeholder through the seam), so no existing
-- row has a job to point at.
--
-- ## Index
--
-- Partial, `WHERE job_id IS NOT NULL`. It exists for the FK: an unindexed
-- referencing column makes every `DELETE FROM jobs` seq-scan `conversations`,
-- the largest table in the schema, to find rows to null out. Partial because
-- job-produced conversations are a small minority and a full index would carry
-- an entry for every human chat to serve a lookup that only ever asks about
-- jobs. Drizzle's index builder cannot express a partial index, so — like
-- `idx_jobs_due` from 0041 — it lives only here, with a NOTE beside the column
-- in schema/conversations.ts.
--
-- ## RLS
--
-- Nothing to do. `conversations` was secured by 0031 and adding a column does
-- not move a table in or out of the tenant boundary; the policy is on the
-- table, not on its column list. (`rls-coverage.spec.ts` reads
-- `grid_secure_table` calls to decide what is inside the boundary, so this
-- migration deliberately makes none and is deliberately absent from that spec's
-- BOUNDARY_MIGRATIONS list.)
--
-- ## Locks
--
-- `ADD COLUMN` with no default is catalog-only and instant. The FK validation
-- scans `conversations`, but every existing row has `job_id` NULL and a MATCH
-- SIMPLE foreign key skips NULLs, so the scan finds nothing to check. The index
-- build is the only real work, and it is partial over an all-NULL column.

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
-- uuid, matching `jobs.id` (uuid, gen_random_uuid()) — unlike
-- `job_runs.conversation_id`, which is text because `conversations.id` is a
-- client-minted `s_…` string.
ALTER TABLE "conversations" ADD COLUMN "job_id" uuid;

-- ---------------------------------------------------------------------------
-- 2. The foreign key
-- ---------------------------------------------------------------------------
-- Single-column, referencing `jobs (id)` — NOT the composite
-- `(id, organization_id)` pattern 0032/0043 use for the other direction. A
-- composite FK here would need `conversations (organization_id)` to be part of
-- the reference and `jobs` has the unique constraint on `id` alone; the tenant
-- guarantee is already carried by RLS on both tables plus the fact that the
-- only writer (the jobs fire path) reads the organization off the job row it is
-- firing. Cross-tenant provenance is therefore unreachable, not merely
-- unchecked.
--> statement-breakpoint
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs" ("id")
  ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 3. The partial index (see the header)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
CREATE INDEX "conversations_job_id_idx" ON "conversations" ("job_id") WHERE "job_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. What the column means, in the catalog
-- ---------------------------------------------------------------------------
-- The next person to read this is looking at `\d+ conversations`, not at
-- migration history — and `created_by` on a job conversation is a real human
-- who never typed a word of it, which is surprising enough to write down where
-- it will be found.
--> statement-breakpoint
COMMENT ON COLUMN "conversations"."job_id" IS
  'The job that produced this conversation (output=chat), or NULL when a person started it. created_by is still the job OWNER, a real user id — the roster, the last-owner invariant and audit all read it as a person. Job conversations are created visibility=project and are kept out of the personal sessions list by this column.';
