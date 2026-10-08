-- 0109: upload_batches — what one upload gesture brought in, so its uploader
-- can be told when it has all been read, and so a project keeps a record of its
-- uploads (tickets „Übersicht – Was ist angekommen?", ADR-0085).
--
-- ## Why a row of its own
--
-- One upload is one request per file, and until now nothing on the server knew
-- that forty requests were one folder. The browser knew, and forgot when the
-- tab closed. Completion was likewise only ever seen by a reader polling a
-- listing. A batch row is the unit "an ingestion completed" is about, and the
-- thing a project's upload history lists.
--
-- ## What it does NOT hold
--
-- The NAMES of the files the office's screening kept on the uploader's machine.
-- Those never reached the server as files, and „Gehaltsabrechnung Huber
-- 2026-03.pdf" is personal data in its own right; the batch keeps the terms
-- that matched and how many files each held back (`excluded`), which is what
-- the summary needs to say why something is missing.
--
-- ## Settling
--
-- `sealed_at`: the browser finished sending (or the sweep gave up waiting for
-- it). `completed_at`: sealed, and every document carrying this batch id has a
-- terminal status. Set once, by an UPDATE guarded on `completed_at IS NULL`, so
-- the inbox item it triggers is emitted once however many readers reconcile
-- the last document at the same moment.

CREATE TABLE IF NOT EXISTS "upload_batches" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "created_by" text NOT NULL,
  "scope" text NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "conversation_id" text,
  "expected_count" integer NOT NULL,
  "excluded" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "unchanged_count" integer DEFAULT 0 NOT NULL,
  "failed_count" integer DEFAULT 0 NOT NULL,
  "sealed_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "upload_batches_scope" CHECK ("scope" IN ('project', 'archiv', 'session')),
  -- A project upload names its project; the other shelves have none.
  CONSTRAINT "upload_batches_project_scope"
    CHECK (("scope" = 'project') = ("project_id" IS NOT NULL)),
  CONSTRAINT "upload_batches_counts"
    CHECK ("expected_count" BETWEEN 0 AND 10000 AND "unchanged_count" >= 0 AND "failed_count" >= 0),
  -- Completed implies sealed: nothing is "all read" while files may still come.
  CONSTRAINT "upload_batches_completed_after_seal"
    CHECK ("completed_at" IS NULL OR "sealed_at" IS NOT NULL),
  CONSTRAINT "upload_batches_excluded_is_array" CHECK (jsonb_typeof("excluded") = 'array')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_batches_project_created_idx"
  ON "upload_batches" USING btree ("organization_id", "project_id", "created_at" DESC);
--> statement-breakpoint
-- The sweep reads open batches only.
CREATE INDEX IF NOT EXISTS "upload_batches_open_idx"
  ON "upload_batches" USING btree ("created_at") WHERE "completed_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "upload_batch_id" uuid;
--> statement-breakpoint
-- No FK on purpose: a batch row may be pruned while its documents live on, and
-- the document must not go with it. The id is a pointer for the summary only.
CREATE INDEX IF NOT EXISTS "documents_upload_batch_idx"
  ON "documents" USING btree ("upload_batch_id") WHERE "upload_batch_id" IS NOT NULL;
--> statement-breakpoint
COMMENT ON TABLE "upload_batches" IS
  'One upload gesture: what the browser sent, what the screening kept back (terms and counts, never file names), and when every document in it was read. Feeds the upload.completed inbox item and a project''s upload history.';
--> statement-breakpoint
SELECT grid_secure_table('upload_batches', 'organization_id = grid_current_org()');
