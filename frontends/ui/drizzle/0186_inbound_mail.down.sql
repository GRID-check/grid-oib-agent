-- Reverse 0186. ORDER: roll the frontend back first; the newer build receives
-- mail, runs the filing and follow jobs and sweeps these tables.
--
-- REFUSED while any row still names a staged object or a kept original: the
-- rows are the only record of those keys, and erasure is by exact key (the
-- project purge alone deletes by prefix). Dropping them first would leave a
-- stranger's mail and every filed message's original in the organization's
-- bucket with nothing that knows about them (RT-S8). List them:
--
--   SELECT staging_bucket, raw_storage_key, read_storage_key FROM inbound_mails
--    WHERE raw_storage_key IS NOT NULL OR read_storage_key IS NOT NULL;
--   SELECT m.staging_bucket, p.storage_key FROM inbound_mail_parts p
--     JOIN inbound_mails m ON m.id = p.mail_id WHERE p.storage_key IS NOT NULL;
--   SELECT original_bucket, original_storage_key FROM mail_thread_entries
--    WHERE original_storage_key IS NOT NULL;
--
-- delete each object by its key, set the column NULL (as the platform role,
-- with the feature paused: GRID_INBOUND_MAIL_PAUSED=1), and run this again.
--
-- Lossy, even then. Every project's address goes, and members must be given a
-- new one after re-applying; every mail still waiting goes with the only record
-- that it was waiting; the decisions go (those audited are in the audit trail).
-- Filed documents, an E-Mail-Verlauf and its Fassungen included, are ordinary
-- documents and stay, without their entries and without the record of which
-- mail brought which Fassung (D36): the thread's next reply starts a
-- new Verlauf, and nobody follows anything.
--
-- The inbox rows that announced mail and threads go (an older build has no
-- presentation for their types), and so do the inbound mail jobs on the queue
-- (an older build has no handler for their kinds, and each would burn its
-- attempts and go dead).

DO $$
BEGIN
  -- Each table on its own, so a run that stopped half-way can be repeated.
  IF (to_regclass('public.inbound_mails') IS NOT NULL
      AND EXISTS (SELECT 1 FROM inbound_mails WHERE raw_storage_key IS NOT NULL OR read_storage_key IS NOT NULL))
  OR (to_regclass('public.inbound_mail_parts') IS NOT NULL
      AND EXISTS (SELECT 1 FROM inbound_mail_parts WHERE storage_key IS NOT NULL))
  OR (to_regclass('public.mail_thread_entries') IS NOT NULL
      AND EXISTS (SELECT 1 FROM mail_thread_entries WHERE original_storage_key IS NOT NULL)) THEN
    RAISE EXCEPTION 'reverse 0186 refused: rows still name staged mail or kept originals in object storage'
      USING ERRCODE = 'object_in_use',
            HINT = 'Erase each object by the key its row names, set the column NULL, then run this again; the listing queries are in the header of 0186_inbound_mail.down.sql.';
  END IF;
END
$$;
--> statement-breakpoint
DELETE FROM "inbox_items" WHERE "type" LIKE 'inbound\_mail.%' OR "type" LIKE 'mail\_thread.%';
--> statement-breakpoint
DELETE FROM "bff_job_queue" WHERE "kind" LIKE 'inbound\_mail\_%';
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mail_thread_entry_attachments_legal_hold_guard" ON "mail_thread_entry_attachments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mail_thread_entry_attachments_guard" ON "mail_thread_entry_attachments";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "mail_thread_entries_legal_hold_guard" ON "mail_thread_entries";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "inbound_mails_legal_hold_guard" ON "inbound_mails";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "inbound_mail_decisions_guard" ON "inbound_mail_decisions";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "inbound_mail_parts_decision_guard" ON "inbound_mail_parts";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "inbound_mail_parts_document_guard" ON "inbound_mail_parts";
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_refuse_held_project_row_delete();
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_inbound_mail_decisions_guard();
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_inbound_mail_parts_decision_guard();
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_inbound_mail_parts_document_guard();
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_mail_thread_entry_attachments_guard();
--> statement-breakpoint
-- Parts and decisions name each other; the key from parts goes first.
ALTER TABLE IF EXISTS "inbound_mail_parts" DROP CONSTRAINT IF EXISTS "inbound_mail_parts_decision_fkey";
--> statement-breakpoint
DROP TABLE IF EXISTS "inbound_mail_decisions";
--> statement-breakpoint
DROP TABLE IF EXISTS "inbound_mail_parts";
--> statement-breakpoint
DROP TABLE IF EXISTS "inbound_mails";
--> statement-breakpoint
DROP TABLE IF EXISTS "inbound_mail_addresses";
--> statement-breakpoint
DROP TABLE IF EXISTS "mail_thread_message_ids";
--> statement-breakpoint
DROP TABLE IF EXISTS "mail_thread_entry_attachments";
--> statement-breakpoint
DROP TABLE IF EXISTS "mail_thread_entries";
--> statement-breakpoint
DROP TABLE IF EXISTS "mail_thread_follows";
--> statement-breakpoint
DROP TABLE IF EXISTS "mail_threads";
