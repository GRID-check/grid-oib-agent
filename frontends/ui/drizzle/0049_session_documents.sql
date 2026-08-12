-- A file dropped into a chat becomes a real document row (ADR-0047 Phase 2).
--
-- ## What was wrong
--
-- Grid has three shelves — the org-wide Archiv, a project, and a private chat
-- session — and until now only two of them were rows. A session upload went
-- straight from the browser to the Python ingestor via
-- `POST /api/v1/collections/s_<id>/documents`, creating chunks in a collection
-- and nothing else. No `documents` row means: no storage-quota ledger entry, no
-- audit trail, no status reconciliation, no delete that reaches SeaweedFS — and,
-- since ADR-0045, no way for the model pipeline to see the upload at all, so an
-- IFC attached to a chat was embedded as raw STEP text instead of being parsed
-- into a building.
--
-- `documents.scope` gains `session` to fix that. The VALUE needs no migration:
-- the column is plain `text` with no CHECK constraint and a `'project'`
-- default, so a new member is a TypeScript change. What needs a migration is
-- the thing a session row has that no other row has — the conversation it
-- belongs to.
--
-- ## Why a column and not the collection name
--
-- `collection_name` already holds `s_<conversationId>` for these rows, and a
-- conversation id already IS an `s_…` string, so the two columns would hold the
-- same characters. Deriving one from the other is still the wrong answer, and
-- ADR-0047 is the reason: the whole ADR is the removal of code that recovers a
-- fact by parsing a name. `collection_name` means "where the chunks are"; that
-- it currently spells a conversation id is a naming coincidence one rename away
-- from being false.
--
-- The column also buys three things a string cannot:
--
--   1. **Existence.** A session document cannot reference a conversation that
--      is not there.
--   2. **Tenancy.** The key is composite — `(conversation_id, organization_id)`
--      against `conversations (id, organization_id)` — so a row cannot claim
--      this organization while pointing at another one's conversation.
--      `documents.organization_id` is denormalised, which is exactly the
--      condition that makes a single-column FK insufficient; 0031 and 0032
--      reached the same conclusion for `messages` and `conversation_reads`, and
--      `conversations` carries its `(id, organization_id)` unique constraint so
--      that keys like this can exist.
--   3. **Lifecycle.** Discarding a chat cannot leave its private attachments
--      behind as rows nothing lists and nothing can delete.
--
-- `text`, not `uuid`, because `conversations.id` is a client-minted `s_…`
-- string (the same reason `job_runs.conversation_id` is text).
--
-- ## Why CASCADE
--
-- A session attachment is not work product that outlives its thread the way a
-- job's conversation outlives the job (0044, SET NULL). It is *part of* the
-- thread: private to it, named only by it, and meaningless without it. Deleting
-- the conversation and keeping the document would leave a row no surface lists,
-- no permission check can resolve, and no delete path can reach.
--
-- The application deletes them explicitly first — chunks, then the SeaweedFS
-- objects, then the rows — because a cascade cannot reach an object store. This
-- is the backstop for the paths that do not go through that service, notably a
-- project purge, which deletes a project's conversations directly.
--
-- ## The CHECK constraint
--
-- `(scope = 'session') = (conversation_id IS NOT NULL)`: a session row has a
-- conversation and no other row does, both directions.
--
-- It is here because the scope partition used to be a convention held together
-- by a coincidence. With two shelves, "is this an Archiv row" could be asked as
-- `scope = 'archiv'` OR as `project_id IS NULL` and both were right; the
-- project listing relied on the second reading without ever saying so. A third
-- shelf that also has a NULL project is what makes those two questions
-- different, so the tie between a scope and the column that owns it is written
-- into the table rather than reconstructed by each query.
--
-- Added NOT VALID and validated separately. Both statements are needed for
-- correctness of the FUTURE — an unvalidated constraint is still enforced on
-- every insert and update — and splitting them keeps the ACCESS EXCLUSIVE lock
-- to a catalog update while the scan over existing rows runs under SHARE UPDATE
-- EXCLUSIVE, which does not block reads or writes. Every existing row satisfies
-- it trivially (`conversation_id` is new, so it is NULL everywhere, and no row
-- has `scope = 'session'` yet), so the scan finds nothing to reject.
--
-- ## RLS
--
-- Nothing to do. `documents` was secured by 0031 and adding a column does not
-- move a table in or out of the tenant boundary — the policy is on the table,
-- not on its column list. (`rls-coverage.spec.ts` reads `grid_secure_table`
-- calls to decide what is inside the boundary, so this migration deliberately
-- makes none and is deliberately absent from that spec's BOUNDARY_MIGRATIONS
-- list.)
--
-- ## Locks
--
-- `ADD COLUMN` with no default is catalog-only and instant. The FK's validation
-- scan skips every row, because MATCH SIMPLE skips a key with any NULL column
-- and `conversation_id` is NULL in all of them. The partial index is built over
-- an all-NULL column. The CHECK is split as described above.

-- ---------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------
ALTER TABLE "documents" ADD COLUMN "conversation_id" text;

-- ---------------------------------------------------------------------------
-- 2. The composite foreign key (see the header)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_conversation_id_organization_id_fkey"
  FOREIGN KEY ("conversation_id", "organization_id")
  REFERENCES "conversations" ("id", "organization_id")
  ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 3. The partial index
-- ---------------------------------------------------------------------------
-- It exists for two readers: the session document listing
-- (`WHERE conversation_id = $1 AND organization_id = $2`) and the foreign key,
-- since an unindexed referencing column makes every `DELETE FROM conversations`
-- seq-scan `documents`. Partial because session documents are a small minority
-- of the table and a full index would carry an entry for every project and
-- Archiv document to serve a lookup that only ever asks about conversations.
-- Drizzle's index builder cannot express a partial index, so it lives only here,
-- with a NOTE beside the column in schema/documents.ts.
--> statement-breakpoint
CREATE INDEX "documents_conversation_idx"
  ON "documents" ("conversation_id")
  WHERE "conversation_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. The scope partition, as an invariant (see the header)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_session_requires_conversation"
  CHECK (("scope" = 'session') = ("conversation_id" IS NOT NULL))
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_session_requires_conversation";

-- ---------------------------------------------------------------------------
-- 5. What the column means, in the catalog
-- ---------------------------------------------------------------------------
--> statement-breakpoint
COMMENT ON COLUMN "documents"."conversation_id" IS
  'The conversation a scope=session document was attached to; NULL for every project and archiv row. A real FK rather than a read of collection_name, which holds the same string only by naming coincidence (ADR-0047). Composite with organization_id so a row cannot point at another tenant''s conversation; ON DELETE CASCADE so discarding a chat takes its private attachments with it.';
