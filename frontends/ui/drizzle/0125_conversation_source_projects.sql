-- 0125: conversation_source_projects — the OTHER projects whose content a
-- conversation drew on through the cross-project lookups (ADR-0094).
--
-- A chat, shared or solo, may search the projects its audience may open (ADR-0094:
-- the reach is the audience's). Content from such a project then sits in the
-- conversation, so whoever may later read the conversation must be someone who may
-- open that project too. A restricted folder of that project is recorded where
-- every restricted folder is, by folder id, in `conversation_restricted_folders`
-- (0112); this table records the PROJECT, which covers what is open to every
-- member of it, including the documents filed at its root, which have no folder to
-- name.
--
-- Written only by `recordCrossProjectHandOut` (`lib/conversations/cross-project-use.ts`),
-- under the per-conversation advisory lock every widening of the conversation's
-- audience takes, after checking that the audience is still the one the lookup
-- searched for (`audienceKey`); a change since then records nothing. Read at
-- read time against the project's current access: nothing here says who may
-- read; it says what the conversation used.
--
-- No foreign keys, for 0112's reasons: the first turn of a chat runs before its
-- row exists, and deleting a project must not quietly open what was drawn from
-- it. A project id nobody may open any more is a project nobody may read.
CREATE TABLE IF NOT EXISTS "conversation_source_projects" (
  "organization_id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "first_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "conversation_source_projects_pk" PRIMARY KEY ("organization_id", "conversation_id", "project_id"),
  CONSTRAINT "conversation_source_projects_order" CHECK ("last_at" >= "first_at")
);
--> statement-breakpoint
COMMENT ON TABLE "conversation_source_projects" IS
  'Another project whose content this conversation drew on through a cross-project lookup (ADR-0094). Who may read the conversation is decided at read time: only people who may open every recorded project.';
--> statement-breakpoint
SELECT grid_secure_table('conversation_source_projects', 'organization_id = grid_current_org()');
