-- Down for 0084. Deliberately NOT in `meta/_journal.json` — drizzle never
-- applies a `.down.sql`; it is the hand-run rollback companion.
--
-- What is lost: the NAMES, and nothing else. Every mount a Sammlung ever made
-- is an ordinary `conversation_mounts` row that stands on its own, so a Büro
-- thread keeps reading exactly the projects it was reading; what goes away is
-- the ability to say "Bezirk 3" instead of picking five projects. The Büro
-- surface is behind the `workspace-chat` flag, so with the flag off nothing
-- notices at all.
--
-- Members first: the composite foreign key would refuse the parent drop
-- otherwise, and being explicit says which direction the dependency runs.
DROP TABLE IF EXISTS "project_set_members";--> statement-breakpoint
DROP TABLE IF EXISTS "project_sets";
