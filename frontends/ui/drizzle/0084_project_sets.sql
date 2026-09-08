-- 0084: Sammlungen — a named, reusable set of projects (spec GR-2, ADR-0054).
--
-- ## The question this answers
--
-- 0083 made a Büro conversation read a bounded number of projects, one mount at
-- a time. The office does not think one project at a time: "vergleiche die
-- Brandschutzkonzepte der Bezirk-3-Projekte" names a SET somebody already has
-- in their head — a Bezirk, a client, a year — and re-picking its members from
-- a tree every morning is the work the office was hoping to stop doing.
--
-- GR-2 says the generalisation MUST be "one table and no new mechanism". That
-- is what these two tables are, and it is why there is no `conversation_sets`
-- beside `conversation_mounts`: mounting a Sammlung expands to the SAME mount
-- rows a person's clicks would have written, through the same service and the
-- same permission check. The set is an addressing convenience, never a second
-- kind of scope — so a conversation whose set later gains a project does not
-- silently start reading it, and the cap keeps meaning what it meant.
--
-- ## Two tables, and why the membership is not a jsonb array on the set
--
-- A `uuid[]` column would have been shorter and would have lost both things
-- that matter here. A project purge has to take its memberships with it, and
-- only a real foreign key does that (ADR-0011's pipeline learns nothing new).
-- And "which Sammlungen is this project in?" is the direction a project surface
-- asks in, which an array answers with a scan.
--
-- ## The four invariants
--
-- 1. `project_sets_id_organization_id_key`, the composite UNIQUE that gives the
--    membership's foreign key a pair to point at. Same belt-and-braces `tasks`
--    adopted in 0075 and 0083 repeats: `organization_id` is denormalised onto
--    the membership so RLS filters without a join, and the composite keys are
--    what stop that copy from disagreeing with either side.
-- 2. TWO composite foreign keys on the membership, both ON DELETE CASCADE.
--    Deleting a Sammlung takes its memberships; purging a project takes its
--    memberships and STOPS. Neither reaches a conversation: a mount that was
--    made through a set is an ordinary mount row afterwards, so removing the
--    set it came from changes nothing about what a thread already reads (the
--    same direction 0083 takes for a conversation the organisation owns).
-- 3. `uniq_project_sets_org_name` on (organization_id, lower(name)). A name is
--    the whole of a Sammlung's usefulness — it is what the person types and
--    what the cap refusal says — and two "Bezirk 3"s differing in case are two
--    things nobody can tell apart. Expression index, so drizzle cannot express
--    it and it lives here.
-- 4. `project_sets_name_present`, a non-blank name. `lower('')` is a perfectly
--    good unique key and a perfectly useless label; the one place that would
--    surface is a refusal string naming the set, where a blank reads as a bug
--    in the refusal.
--
-- ## What is NOT here
--
-- No `created_by` foreign key: WorkOS owns users, and this database has never
-- held a users table to point at (every other `created_by` in the schema is the
-- same bare text). No cap on the membership count either — the cap is on what a
-- CONVERSATION mounts, enforced in `lib/workspace/mounts-service.ts` and
-- nowhere else (ADR-0054). A Sammlung of forty projects is a legitimate thing
-- to own; mounting it is what gets refused, with the cap and the set named.

CREATE TABLE IF NOT EXISTS "project_sets" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" text NOT NULL,
  "name"            text NOT NULL,
  "description"     text,
  "created_by"      text NOT NULL,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "project_sets_id_organization_id_key" UNIQUE ("id","organization_id"),
  CONSTRAINT "project_sets_name_present" CHECK (length(btrim("name")) > 0)
);--> statement-breakpoint

-- One "Bezirk 3" per organisation, whatever case it is typed in.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_sets_org_name"
  ON "project_sets" ("organization_id", lower("name"));--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "project_set_members" (
  "set_id"          uuid NOT NULL,
  "organization_id" text NOT NULL,
  "project_id"      uuid NOT NULL,
  "added_at"        timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "project_set_members_pkey" PRIMARY KEY ("set_id","project_id"),
  CONSTRAINT "project_set_members_set_fk"
    FOREIGN KEY ("set_id","organization_id")
    REFERENCES "project_sets"("id","organization_id") ON DELETE CASCADE,
  CONSTRAINT "project_set_members_project_fk"
    FOREIGN KEY ("project_id","organization_id")
    REFERENCES "projects"("id","organization_id") ON DELETE CASCADE
);--> statement-breakpoint

-- "Which Sammlungen is this project in?" — the purge's direction of travel, and
-- a project surface's.
CREATE INDEX IF NOT EXISTS "project_set_members_project_idx"
  ON "project_set_members" ("project_id");--> statement-breakpoint

-- Tenant boundary. The set carries its own tenant and nothing else (ADR-0041).
SELECT grid_secure_table('project_sets', 'organization_id = grid_current_org()');--> statement-breakpoint

-- The membership needs both halves, exactly as 0082 and 0083 do: the row's own
-- denormalised tenant AND the tenant of the project it names. The second half
-- is not redundant with the foreign key — the key keeps the two in step, the
-- predicate is what makes a cross-tenant read return nothing.
SELECT grid_secure_table('project_set_members',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');--> statement-breakpoint

COMMENT ON TABLE "project_sets" IS
  'Sammlungen (ADR-0054, spec GR-2): a named, reusable set of projects — a Bezirk, a client, a year — mounted into a Buero conversation as one unit. The set is an addressing convenience over conversation_mounts, never a second kind of scope: mounting one writes the same mount rows a person''s clicks would have written, and the cap is enforced once over the resulting total.';--> statement-breakpoint

COMMENT ON TABLE "project_set_members" IS
  'Which projects a Sammlung names (ADR-0054, spec GR-2). Composite foreign keys to project_sets and projects, both ON DELETE CASCADE and neither reaching a conversation: a mount made through a set is an ordinary mount row afterwards, so deleting the set changes nothing about what a thread already reads.';
