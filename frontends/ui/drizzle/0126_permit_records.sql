-- 0126: permit_records and permit_requirements — what a Bescheid says, read
-- once at ingest and kept as rows (docs/design/permitting-memory.md,
-- ADR-0094), so „Fragt die Behörde das wieder nach?" is answered from what the
-- office's own past procedures went through.
--
-- ## The records
--
-- `permit_records`: one row per source document the ingest typed `Bescheid`
-- and a model then read with a strict schema: the kind of notice, the
-- authority, the Gemeinde, the date, the reference. `document_id` is unique, so
-- a re-extraction replaces the record instead of adding a second one, and it
-- cascades: deleting the document takes the record with it.
--
-- ## The requirements
--
-- `permit_requirements`: the record's items, one row each: an Auflage of a
-- granted permit, an item a Nachforderung demands, with the evidence it asks
-- for and the legal basis it cites. `project_id` and `restricted_folder_ids`
-- are copied from the record so the search scopes and filters without a join.
-- `embedding` is the vector of content + evidence and `embedding_model` the
-- fingerprint of the model that made it, as `project_memory` stores them: a
-- vector is comparable only within one model, and NULL says the token channel
-- alone ranks the row.
--
-- ## Restricted folders
--
-- `restricted_folder_ids` is the document's source folders (ADR-0088), as
-- 0113 stores them on memory: NULL is open, otherwise 1–20 folder ids, served
-- only to a reader who may read all of them now.
--
-- No closed-project guard (0116) on either table: they are derived index data
-- like chunks and embeddings, and the archive import extracts from closed
-- projects. A person never edits them; re-extraction replaces them.
CREATE TABLE IF NOT EXISTS "permit_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "collection_name" text NOT NULL,
  "file_name" text NOT NULL,
  "restricted_folder_ids" uuid[],
  "kind" text NOT NULL,
  "authority" text,
  "municipality" text,
  "bundesland" text,
  "issued_on" date,
  "reference" text,
  "model" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "permit_records_document_key" UNIQUE ("document_id"),
  CONSTRAINT "permit_records_project_fkey" FOREIGN KEY ("project_id", "organization_id")
    REFERENCES "projects" ("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "permit_records_document_fkey" FOREIGN KEY ("document_id")
    REFERENCES "documents" ("id") ON DELETE CASCADE,
  CONSTRAINT "permit_records_kind_check" CHECK ("kind" IN ('bewilligung', 'nachforderung', 'ablehnung', 'sonstiges')),
  CONSTRAINT "permit_records_restricted_folders_check" CHECK (
    "restricted_folder_ids" IS NULL OR cardinality("restricted_folder_ids") BETWEEN 1 AND 20
  )
);
--> statement-breakpoint
COMMENT ON TABLE "permit_records" IS
  'What a Bescheid says, one row per source document, read once at ingest by a model with a strict schema (0126, ADR-0094). Derived index data: re-extraction replaces it, deleting the document deletes it.';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permit_requirements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "record_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "restricted_folder_ids" uuid[],
  "position" integer NOT NULL,
  "kind" text NOT NULL,
  "content" text NOT NULL,
  "evidence" text,
  "legal_basis" text,
  "page" integer,
  "embedding" real[],
  "embedding_model" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "permit_requirements_record_fkey" FOREIGN KEY ("record_id")
    REFERENCES "permit_records" ("id") ON DELETE CASCADE,
  CONSTRAINT "permit_requirements_kind_check" CHECK ("kind" IN ('auflage', 'nachforderung', 'hinweis')),
  CONSTRAINT "permit_requirements_content_length" CHECK (char_length("content") <= 1000),
  CONSTRAINT "permit_requirements_restricted_folders_check" CHECK (
    "restricted_folder_ids" IS NULL OR cardinality("restricted_folder_ids") BETWEEN 1 AND 20
  )
);
--> statement-breakpoint
COMMENT ON TABLE "permit_requirements" IS
  'The items of a permit record: an Auflage, or what a Nachforderung demands, with the evidence asked for and the legal basis cited (0126, ADR-0094). Copies project_id and restricted_folder_ids from the record so the search needs no join.';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permit_records_project_idx" ON "permit_records" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permit_records_organization_idx" ON "permit_records" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permit_requirements_project_idx" ON "permit_requirements" ("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permit_requirements_record_idx" ON "permit_requirements" ("record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "permit_requirements_organization_idx" ON "permit_requirements" ("organization_id");
--> statement-breakpoint
SELECT grid_secure_table('permit_records', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('permit_requirements', 'organization_id = grid_current_org()');
