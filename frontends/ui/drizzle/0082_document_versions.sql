-- 0082: document_versions — one history for every document, and the publish
-- door (ADR-0054).
--
-- ## What was missing
--
-- Two things, and they turn out to be one table.
--
-- **A document had no history.** Re-uploading a file under a name that already
-- exists has replaced the document in place since migration 0074 — the SAME id,
-- deliberately, so citations, chat subjects and folder assignments survive —
-- and `discardSupersededObjects` then threw the previous bytes away. That is
-- versioning without the history: the gesture an architect means by dropping a
-- corrected plan is "this is the new one", not "delete the old one".
--
-- **A document had no editorial state.** `documents` could say who uploaded it,
-- who may open it, who is on the hook for it and whose hand wrote it (ADR-0047's
-- four relations). It could not say whether anybody had ASSERTED the content.
-- „Zuweisen" answers responsibility and is untouched by this migration;
-- „Freigeben" and „Veröffentlichen" answer a different question.
--
-- So the item stays `documents` — its id is what every relation references, and
-- what `uniq_documents_authored_ref_producer_per_project` is keyed on — and this
-- table holds one set of bytes plus its state. A human upload is version 1,
-- `published`, born approved; a re-upload is version N+1 and leaves N standing;
-- an agent filing is a `draft` that walks the review states. One pointer, one
-- version list, one vocabulary.
--
-- ## The CHECKs are the ratchet
--
-- The state machine's authority is this file, not a library. `state` is NOT
-- NULL with a known-values CHECK; a review is by somebody at some time or it is
-- not a review (`document_versions_review_complete`, copied from
-- `tasks_review_complete` in 0075); a refusal carries words; and — the one that
-- matters — **a published version has a human approver**
-- (`document_versions_published_is_approved`). Slice 4 dispatches only a
-- published version to the index, so "a document Piloti wrote can be cited back
-- to Piloti" becomes a row Postgres refuses to store rather than a predicate in
-- a retrieval path whose documented posture is fail-open.
--
-- Two partial unique indexes carry the rest: one OPEN version per document
-- (draft / in_review / changes_requested) so two turns cannot fork the same item
-- into two live drafts, and one PUBLISHED version per document so the pointer on
-- the item can never be ambiguous. Both carry a COMMENT ON INDEX, because the
-- next person to meet one meets it as a constraint violation in a log line, not
-- as this file.
--
-- ## The backfill, and the alternative that was rejected
--
-- EVERY existing `documents` row gets exactly ONE version, `published`,
-- mirroring its current bytes and its current storage key, with
-- `approved_by = published_by = created_by` and
-- `approved_at = published_at = created_at`.
--
-- For a human upload that is simply what the row already means: a person put
-- these bytes in this project, in their own session, with
-- `project:documents:write` in hand, and the product has shown the file as filed
-- ever since. For an agent-authored report it is the only honest mapping too —
-- the built report is already the assignee's to own; `createdBy` is the
-- commissioning human, the `document.generated` audit event already names them
-- as the actor, and the new columns must not retroactively claim otherwise.
--
-- The alternative considered and rejected was **"pending for every unassigned
-- report"** — mapping existing agent-authored documents to `draft` or
-- `in_review` on the grounds that nobody has formally pressed Freigeben. It
-- would put every report an office has ever filed into a review queue nobody
-- asked for, on the day of the deploy, with an inbox item each. That is a
-- product change dressed as a data migration, and it would invent a refusal
-- where there was never a decision.
--
-- The INSERT is guarded by `NOT EXISTS`, so re-running this migration adds
-- nothing; the UPDATE that moves the pointer only fills NULLs.
--
-- ## Superseded bytes stay
--
-- A superseded version keeps its object. History you cannot open is a list of
-- dates. The consequence is stated rather than hidden: superseded versions stay
-- charged against the organization's storage quota, because they exist. A
-- per-organization retention policy is a later row on a later table, not an
-- `if` here. Bytes leave when the document is deleted — `deleteDocument` walks
-- every version's objects — or when a version is explicitly discarded.
--
-- ## RLS
--
-- Tenant table. The predicate is the organization AND, for the rows that have a
-- project, that project's organization — the `tasks` shape, widened by the NULL
-- arm because the org-wide Archiv and a conversation's private attachments have
-- no project, exactly as their `documents` rows do not. Listed in
-- `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "document_id" uuid NOT NULL,
  "project_id" uuid,
  "version_number" integer NOT NULL,
  "state" text DEFAULT 'draft' NOT NULL,
  "storage_key" text NOT NULL,
  "storage_bucket" text,
  "content_type" text,
  "file_size" integer,
  "content_hash" text,
  "submitted_by" text,
  "submitted_at" timestamp with time zone,
  "reviewed_by" text,
  "reviewed_at" timestamp with time zone,
  "approved_by" text,
  "approved_at" timestamp with time zone,
  "published_by" text,
  "published_at" timestamp with time zone,
  "review_comment" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_versions_id_document_id_key" UNIQUE ("id", "document_id"),
  -- Composite, the `documents_folder_id_project_id_fkey` shape: a version
  -- cannot be filed against a document in another tenant's project, without a
  -- recursive policy and without a subquery. MATCH SIMPLE skips the check when
  -- `project_id` is NULL, which is every Archiv and session row — exactly the
  -- rows with no project to validate.
  CONSTRAINT "document_versions_document_id_project_id_fkey"
    FOREIGN KEY ("document_id", "project_id")
    REFERENCES "documents" ("id", "project_id") ON DELETE CASCADE,
  CONSTRAINT "document_versions_state_known"
    CHECK ("state" IN ('draft', 'in_review', 'changes_requested', 'approved', 'published', 'superseded', 'rejected')),
  CONSTRAINT "document_versions_review_complete"
    CHECK (("reviewed_by" IS NULL) = ("reviewed_at" IS NULL)),
  CONSTRAINT "document_versions_published_is_approved"
    CHECK ("state" <> 'published' OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL)),
  CONSTRAINT "document_versions_refusal_has_comment"
    CHECK ("state" NOT IN ('changes_requested', 'rejected') OR "review_comment" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_versions_document" ON "document_versions" ("document_id", "version_number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_document_versions_organization_id" ON "document_versions" ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_document_versions_open_per_document"
  ON "document_versions" ("document_id")
  WHERE "state" IN ('draft', 'in_review', 'changes_requested');
--> statement-breakpoint
COMMENT ON INDEX "uniq_document_versions_open_per_document" IS
  'One version of a document may be open at a time (draft, in_review, changes_requested). Two chat turns that both fork a draft from the published version must not produce two live drafts of one file: the second insert fails and the caller is told a draft already exists. Widen the predicate here and in OPEN_DOCUMENT_VERSION_STATES together.';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_document_versions_published_per_document"
  ON "document_versions" ("document_id")
  WHERE "state" = 'published';
--> statement-breakpoint
COMMENT ON INDEX "uniq_document_versions_published_per_document" IS
  'A document has at most one published version, which is what documents.published_version_id points at and what the item''s storage columns mirror. A re-upload or a publish supersedes the previous one in the same call; without this index a failure between the two would leave two rows claiming to be the live one and no way to say which.';
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "published_version_id" uuid;
--> statement-breakpoint
COMMENT ON COLUMN "documents"."published_version_id" IS
  'The version whose bytes this item''s storage columns mirror, or NULL when nothing has been published. Composite FK on (published_version_id, id) so the pointer can only ever name a version OF THIS DOCUMENT.';
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_published_version_id_fkey"
  FOREIGN KEY ("published_version_id", "id")
  REFERENCES "document_versions" ("id", "document_id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "lifecycle" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
COMMENT ON COLUMN "documents"."lifecycle" IS
  'Whether the item is in the working set (active) or has left the default listings (archived). Archiving keeps the bytes and purges the chunks; it is not a delete and there is no soft delete on this table.';
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_lifecycle_known" CHECK ("lifecycle" IN ('active', 'archived'));
--> statement-breakpoint
-- The backfill. One published version per existing document, human-uploaded and
-- agent-authored alike, mirroring its current bytes; see the header for why this
-- and not a review queue.
INSERT INTO "document_versions" (
  "id", "organization_id", "document_id", "project_id", "version_number", "state",
  "storage_key", "storage_bucket", "content_type", "file_size", "content_hash",
  "approved_by", "approved_at", "published_by", "published_at",
  "created_by", "created_at", "updated_at"
)
SELECT
  gen_random_uuid(), d."organization_id", d."id", d."project_id", 1, 'published',
  d."storage_key", d."storage_bucket", d."content_type", d."file_size", d."content_hash",
  d."created_by", d."created_at", d."created_by", d."created_at",
  d."created_by", d."created_at", d."updated_at"
FROM "documents" d
WHERE NOT EXISTS (SELECT 1 FROM "document_versions" v WHERE v."document_id" = d."id");
--> statement-breakpoint
UPDATE "documents" d
SET "published_version_id" = v."id"
FROM "document_versions" v
WHERE v."document_id" = d."id" AND v."state" = 'published' AND d."published_version_id" IS NULL;
--> statement-breakpoint
SELECT grid_secure_table('document_versions',
  'organization_id = grid_current_org() AND (project_id IS NULL OR EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org()))');
