-- 0108: mail_imports — an Outlook archive (.pst, .ost) a member is filing into
-- a project, one row per archive (ADR-0085).
--
-- ## Why
--
-- A planning office keeps years of correspondence with authorities, clients and
-- consultants in Outlook, and an archive of it is one file of up to twenty
-- gigabytes. The upload path takes one file of at most a hundred megabytes into
-- memory, and nothing in the product could read the file anyway. This row is the
-- import's whole state: the staged archive while it is uploaded in parts, the
-- cursor the filing job resumes from, and what was filed and skipped.
--
-- ## The position is the cursor
--
-- The backend numbers the archive's items in one fixed order, so `next_position`
-- names the next item on any replica. `inflight_position` and
-- `inflight_folder_id` record the one mail being filed right now: a slice that
-- dies after creating a mail's folder resumes INTO that folder instead of
-- creating a second one beside it. Everything filed before it is behind the
-- cursor and is never touched again.
--
-- ## Retries are counted here, not by the job queue
--
-- A twenty-gigabyte import runs for hours, and the queue's attempts are spent
-- per job and never given back for progress: three passing outages hours apart
-- would end it. So a slice that fails hands the import to a fresh job that waits
-- out a backoff, and `failure_streak` counts the failures since the cursor last
-- moved; filing a mail resets it, and only a streak that never moves the cursor
-- ends the import.
--
-- ## The staged archive is temporary
--
-- It lives in the organization's bucket under `staging_key` (inside the
-- project's prefix, so the project purge erases it too) until the import
-- ends, then it is deleted and `staging_deleted_at` says when. An upload that
-- was started and never finished is aborted by the background-work sweep after
-- two days (`sweepStaleMailImports`). The archive is personal data of everyone
-- who wrote to the office; keeping it after its mails are filed would keep a
-- second copy nobody can see or delete from the product.
--
-- ## RLS
--
-- Tenant data keyed by the organization, secured like `product_feedback`
-- (0100). The sweep finds stale rows under the platform bypass and settles each
-- inside its own tenant. Listed in `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

CREATE TABLE IF NOT EXISTS "mail_imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "user_email" text,
  "filename" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "status" text DEFAULT 'uploading' NOT NULL,
  "staging_bucket" text NOT NULL,
  "staging_key" text NOT NULL,
  -- The S3 multipart upload the parts go into; cleared once it is completed or
  -- aborted, because nothing can be added to it after that.
  "upload_id" text,
  "staging_deleted_at" timestamp with time zone,
  "root_folder_id" uuid,
  "total_items" integer,
  "next_position" integer DEFAULT 0 NOT NULL,
  "inflight_position" integer,
  "inflight_folder_id" uuid,
  "failure_streak" integer DEFAULT 0 NOT NULL,
  "mails_filed" integer DEFAULT 0 NOT NULL,
  "files_filed" integer DEFAULT 0 NOT NULL,
  "items_skipped" integer DEFAULT 0 NOT NULL,
  "files_skipped" integer DEFAULT 0 NOT NULL,
  -- A bounded sample of what was skipped and why, for the notification and the
  -- status view. The counts above are exact; this is for a person to read.
  "skipped_samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- Why an import ended without filing everything, as a code the UI words in
  -- the reader's language; `last_error` is the detail, for whoever debugs it.
  "error_code" text,
  "last_error" text,
  "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "mail_imports_status"
    CHECK ("status" IN ('uploading', 'queued', 'importing', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "mail_imports_size_positive" CHECK ("size_bytes" > 0),
  CONSTRAINT "mail_imports_filename_length"
    CHECK (btrim("filename") <> '' AND char_length("filename") <= 255),
  CONSTRAINT "mail_imports_positions"
    CHECK ("next_position" >= 0 AND ("total_items" IS NULL OR "next_position" <= "total_items")),
  CONSTRAINT "mail_imports_counts"
    CHECK ("mails_filed" >= 0 AND "files_filed" >= 0 AND "items_skipped" >= 0 AND "files_skipped" >= 0
      AND "failure_streak" >= 0),
  -- The in-flight mail is the one at the cursor, never one behind it.
  CONSTRAINT "mail_imports_inflight_at_cursor"
    CHECK ("inflight_position" IS NULL OR "inflight_position" = "next_position"),
  -- An import that ended says when, and only an ended one does.
  CONSTRAINT "mail_imports_completed_at"
    CHECK (("status" IN ('completed', 'failed', 'cancelled')) = ("completed_at" IS NOT NULL)),
  CONSTRAINT "mail_imports_error_length" CHECK ("last_error" IS NULL OR char_length("last_error") <= 1000),
  CONSTRAINT "mail_imports_error_code"
    CHECK ("error_code" IS NULL OR "error_code" IN
      ('unreadable', 'quota', 'access', 'requester_left', 'stopped', 'stalled', 'upload_expired')),
  -- Only an import that failed, or a send that expired, carries a reason.
  CONSTRAINT "mail_imports_error_code_ended"
    CHECK ("error_code" IS NULL OR "status" IN ('failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_imports_org_project_created_idx"
  ON "mail_imports" USING btree ("organization_id", "project_id", "created_at");
--> statement-breakpoint
-- One open import per person per project. The service asks first and answers
-- 409; this is the layer that holds when two tabs ask at once.
CREATE UNIQUE INDEX IF NOT EXISTS "mail_imports_one_open_per_person_uidx"
  ON "mail_imports" USING btree ("project_id", "user_id")
  WHERE "status" IN ('uploading', 'queued', 'importing');
--> statement-breakpoint
-- The sweep's read: imports still open, oldest first.
CREATE INDEX IF NOT EXISTS "mail_imports_open_updated_idx"
  ON "mail_imports" USING btree ("updated_at")
  WHERE "status" IN ('uploading', 'queued', 'importing');
--> statement-breakpoint
COMMENT ON TABLE "mail_imports" IS
  'An Outlook archive (.pst/.ost) a member is filing into a project (ADR-0085): the staged upload, the filing cursor, and what was filed and skipped. Tenant data; the staged archive is deleted when the import ends.';
--> statement-breakpoint
SELECT grid_secure_table('mail_imports', 'organization_id = grid_current_org()');
