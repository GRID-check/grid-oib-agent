-- 0083: the mounted projects of a Büro conversation.
--
-- ## The question this answers
--
-- A workspace conversation (0081) has no project, and that is the point: the
-- office asks above the projects. But the answer to "wie haben wir die
-- Sprinkler-Steigleitung im Projekt Seestadt gelöst?" lives inside Seestadt's
-- documents, and putting every readable project collection into the retrieval
-- scope does not survive the numbers (see 0082's header). So a bounded number
-- of projects are EINGEBLENDET — mounted — into the conversation, and this
-- table is where that fact lives between two turns (ADR-0054, spec MT-5).
--
-- Without a row here a mount would last exactly one WebSocket connection: the
-- grant the mounts endpoint mints is short-lived by design, and the next
-- upgrade rebuilds the scope from scratch. The row is what makes the mounted
-- set survive a reload, and re-authorizing it on every upgrade (MT-7) is what
-- makes a revoked permission narrow the scope instead of lingering.
--
-- ## Why the mount belongs to the CONVERSATION and not to the person
--
-- Spec MT-14. Everyone who can read the thread must see the same "Im Blick"
-- set and the same provenance for its answers; a per-user mount would make two
-- readers of one shared thread disagree about what the answers were grounded
-- in, which is the one thing an audit trail may not do. `mounted_by` records
-- WHO put it there — that is attribution, not ownership.
--
-- ## The four invariants, and why each is a constraint rather than a habit
--
-- 1. TWO composite foreign keys, `(conversation_id, organization_id)` →
--    `conversations (id, organization_id)` and `(project_id, organization_id)`
--    → `projects (id, organization_id)`, the belt-and-braces `tasks` adopted in
--    0075 and `project_register` repeats in 0082. The row denormalises
--    `organization_id` so RLS filters on it without a join; the composite keys
--    are what stop that copy from disagreeing with either side. In particular a
--    mount tying one tenant's conversation to another tenant's project is not
--    merely refused by the policy, it has no pair to point at.
-- 2. `ON DELETE CASCADE` on BOTH keys, and nothing else cascades. Deleting a
--    project removes its mounts and stops there (spec MT-15): the conversation
--    belongs to the ORGANISATION and survives (ADR-0011), so the purge's "all
--    conversation ids for this project" enumeration must never learn about this
--    table. Deleting a conversation removes its mounts for the same reason in
--    the other direction — a mount is a property OF the conversation.
-- 3. `conversation_mounts_actor_known` plus
--    `conversation_mounts_user_is_named` — the actor vocabulary, and the
--    biconditional that ties it to `mounted_by_user_id`. Half-filled rows (an
--    agent mount carrying a user id, a user mount carrying none) are exactly
--    what makes an attribution chip a guess later, and a guess about who
--    widened a conversation's scope is not something to discover in the UI.
-- 4. `uniq_conversation_mounts` on (conversation_id, project_id). This is what
--    makes re-mounting IDEMPOTENT and what stops one project consuming the cap
--    twice: the service inserts ON CONFLICT DO NOTHING and reads the existing
--    row back, so a double-click and a retried tool call are the same mount.
--
-- ## The cap is not here
--
-- `GRID_WORKSPACE_MAX_MOUNTED_PROJECTS` is enforced in the mounts service and
-- nowhere else (ADR-0054). It is a deployment knob, not an invariant of the
-- data: a deployment that lowers it must not make the rows it already has
-- unwritable, and a CHECK counting sibling rows is not something Postgres can
-- express without a trigger nobody would remember reading.

CREATE TABLE IF NOT EXISTS "conversation_mounts" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id"    text NOT NULL,
  "organization_id"    text NOT NULL,
  "project_id"         uuid NOT NULL,
  "mounted_by"         text NOT NULL,
  "mounted_by_user_id" text,
  "mounted_at"         timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "conversation_mounts_conversation_fk"
    FOREIGN KEY ("conversation_id","organization_id")
    REFERENCES "conversations"("id","organization_id") ON DELETE CASCADE,
  CONSTRAINT "conversation_mounts_project_fk"
    FOREIGN KEY ("project_id","organization_id")
    REFERENCES "projects"("id","organization_id") ON DELETE CASCADE,
  CONSTRAINT "conversation_mounts_actor_known" CHECK ("mounted_by" IN ('user','agent')),
  CONSTRAINT "conversation_mounts_user_is_named"
    CHECK (("mounted_by" = 'user') = ("mounted_by_user_id" IS NOT NULL))
);--> statement-breakpoint

-- Idempotence, as an index rather than as a rule the service is trusted to
-- keep: one project is mounted into one conversation at most once.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_conversation_mounts"
  ON "conversation_mounts" ("conversation_id","project_id");--> statement-breakpoint

-- The project's own direction of travel: "which conversations mounted this
-- project", which the purge's cascade walks and a project surface may ask.
CREATE INDEX IF NOT EXISTS "conversation_mounts_project_idx"
  ON "conversation_mounts" ("project_id");--> statement-breakpoint

-- Tenant boundary. Both halves matter, exactly as in 0075 and 0082: the row's
-- own denormalised tenant, AND the tenant of the project it names. The second
-- half is not redundant with the foreign key — the key keeps the two in step,
-- the predicate is what makes a cross-tenant read return nothing (ADR-0041).
SELECT grid_secure_table('conversation_mounts',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');--> statement-breakpoint

COMMENT ON TABLE "conversation_mounts" IS
  'Which projects a Buero conversation currently reads (ADR-0054): one row per (conversation, project), a property of the CONVERSATION rather than of the person who mounted it (spec MT-14), re-authorized on every WebSocket upgrade. A project purge takes these rows and stops there — the conversation is the organisation''s and survives (spec MT-15, ADR-0011).';
