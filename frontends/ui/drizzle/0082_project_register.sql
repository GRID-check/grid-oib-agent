-- 0082: the Projektregister — one Steckbrief per project.
--
-- ## The question this answers
--
-- A Büro-Chat (ADR-0054) has to be able to say WHICH projects an office
-- question touches without reading a single project document. Putting every
-- readable `proj_<id>` collection into the retrieval scope does not survive the
-- numbers — one vector query per collection per pass, doubled by HyDE and
-- multiplied by the requery loop — so the office reads a small per-project
-- FINGERPRINT instead, and mounts a bounded number of projects when it needs
-- their content.
--
-- This table is that fingerprint. Every column is derived from something the
-- application database already holds; nothing here is authored. The BFF is the
-- single writer (spec PR-5), the same boundary `project_memory` already
-- respects.
--
-- ## Why the register lives in Postgres and not in the vector store
--
-- Because the readable-project filter is an application fact only the BFF can
-- compute (`listProjects`, one FGA check per project), and a vector store
-- cannot be handed a forty-element allow-list per query. The register is small
-- — one bounded row per project — so a hybrid scan over it costs less than the
-- readability round-trips that follow it.
--
-- ## The four invariants, and why each is a constraint rather than a habit
--
-- 1. The COMPOSITE foreign key `(project_id, organization_id)` → `projects
--    (id, organization_id)`, the belt-and-braces `tasks` adopted in 0075. The
--    row denormalises `organization_id` so RLS can filter on it without a
--    join; the composite key is what stops that copy from disagreeing with the
--    project it names, i.e. a Steckbrief planted under another tenant's
--    project. `ON DELETE CASCADE` is also the whole of the purge story: a
--    deleted project takes its Steckbrief with it and no code has to remember.
-- 2. `project_register_steckbrief_bounded` — the 3000-character budget (spec
--    PR-3) as a database invariant. Five Steckbriefe plus the office memory
--    digest have to fit in one prompt; a builder bug that produced 40 KB would
--    otherwise be discovered as a context overflow in production rather than
--    as a failed INSERT in a test.
-- 3. `project_register_embedding_complete` — a vector, the fingerprint of the
--    model that produced it, and the time it was produced are one fact in
--    three columns. Two of the three is not a partial answer, it is a vector
--    nothing may compare: a similarity score against an unknown embedder is
--    noise wearing the right shape.
-- 4. RLS, via `grid_secure_table`, with the same two-part predicate `tasks`
--    carries: the row's own tenant column AND the tenant of the project it
--    names. The second half is not redundant with the foreign key — the FK
--    keeps the two in step, the predicate is what makes a cross-tenant read
--    return nothing (spec PR-17, AC-5, ADR-0041).

CREATE TABLE IF NOT EXISTS "project_register" (
  "project_id"       uuid PRIMARY KEY,
  "organization_id"  text NOT NULL,
  "project_name"     text NOT NULL,
  -- Read out of `projects.profile` facts (the `projektphase` intake answer);
  -- `projects` has no status column and NULL means "the profile does not say".
  "status"           text,
  "bundesland"       text,
  -- The <=3000-character prompt block, bounded below.
  "steckbrief"       text NOT NULL,
  "document_count"   integer NOT NULL DEFAULT 0,
  "last_activity_at" timestamp with time zone,
  -- Row-resident embedding, exactly as `project_memory` carries one (0069).
  "embedding"        real[],
  "embedding_model"  text,
  "embedded_at"      timestamp with time zone,
  -- Set by a writer, cleared by the build.
  "stale_at"         timestamp with time zone,
  "built_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"       timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "project_register_project_fk"
    FOREIGN KEY ("project_id","organization_id")
    REFERENCES "projects"("id","organization_id") ON DELETE CASCADE,
  CONSTRAINT "project_register_steckbrief_bounded"
    CHECK (char_length("steckbrief") <= 3000),
  CONSTRAINT "project_register_embedding_complete"
    CHECK (("embedding" IS NULL) = ("embedding_model" IS NULL)
       AND ("embedding" IS NULL) = ("embedded_at" IS NULL))
);--> statement-breakpoint

-- The reconcile's own query, and nothing else's: `stale_at IS NOT NULL ORDER BY
-- stale_at`. PARTIAL because the steady state is "nothing is stale" — a full
-- index over this column would be almost entirely dead entries kept warm for a
-- query that never asks for them.
CREATE INDEX IF NOT EXISTS "project_register_stale_idx" ON "project_register"
  ("organization_id","stale_at") WHERE "stale_at" IS NOT NULL;--> statement-breakpoint

-- The lexical half of hybrid recall (spec PR-9). German, because the
-- Steckbrief is German: the English configuration would stem "Wohngebäude" and
-- "Wohnhaus" to nothing useful and lose the compound matches this product's
-- questions are made of. An expression index, so the query MUST spell the
-- expression the same way (`to_tsvector('german', steckbrief)`) to use it.
CREATE INDEX IF NOT EXISTS "project_register_fts_idx" ON "project_register"
  USING gin (to_tsvector('german', "steckbrief"));--> statement-breakpoint

-- Tenant boundary. Both halves matter: the row's own denormalised tenant, and
-- the tenant of the project it names.
SELECT grid_secure_table('project_register',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');--> statement-breakpoint

COMMENT ON TABLE "project_register" IS
  'The Projektregister (ADR-0054): one derived, bounded Steckbrief per project, written only by the BFF and read by the Buero-Chat to answer WHICH project a question is about. Never evidence for what a project document says (spec PR-15).';
