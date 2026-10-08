-- Upload screening and quarantine (ADR-0083).
--
-- `screening_outcome` is what the content gate in the ingest job concluded about
-- the CURRENT bytes: `clean` (the text layer was read and nothing matched),
-- `partial` (some pages had no text layer and were transcribed unscreened),
-- `unchecked` (nothing could be read locally: an image, a scan), `quarantined`
-- (a rule matched and nothing was indexed), or `released` (a reviewer let a
-- quarantined file through). NULL: not screened, which is every row written
-- before this migration and every job dispatched with screening off.
--
-- A release names the bytes it released (`screening_released_hash` is the
-- `content_hash` the reviewer saw), so a corrected re-upload under the same id
-- is screened again rather than inheriting a decision about other content. The
-- columns are not in `metadata` because `setDocumentIngestJob` replaces that
-- bag on every dispatch, and a release that a re-index forgot would quarantine
-- the file again.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "screening_outcome" text;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "screening_released_hash" text;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "screening_released_by" text;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "screening_released_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_screening_outcome_check";
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_screening_outcome_check" CHECK (
    "screening_outcome" IS NULL
    OR "screening_outcome" IN ('clean', 'partial', 'unchecked', 'quarantined', 'released')
  );
--> statement-breakpoint
-- A release is a person's decision about named bytes: all three or none.
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_screening_release_complete_check";
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_screening_release_complete_check" CHECK (
    ("screening_released_hash" IS NULL AND "screening_released_by" IS NULL AND "screening_released_at" IS NULL)
    OR ("screening_released_hash" IS NOT NULL AND "screening_released_by" IS NOT NULL AND "screening_released_at" IS NOT NULL)
  );
--> statement-breakpoint
-- The reviewers' queue reads quarantined rows per organization.
CREATE INDEX IF NOT EXISTS "documents_quarantined_idx"
  ON "documents" ("organization_id", "updated_at")
  WHERE "status" = 'quarantined';
