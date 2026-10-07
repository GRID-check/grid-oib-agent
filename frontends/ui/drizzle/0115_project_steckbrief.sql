-- 0115: the Steckbrief of a project (ADR-0083, ticket „Abgeschlossene Projekte
-- mit Eckdaten", slice 1b): its period, and everyone who worked on it.
--
-- ## The period
--
-- `projects.started_on` (Beginn) and `projects.ended_on` (Abschluss), at month
-- precision: a date that is always the first of its month. Closing a project
-- fills `ended_on` with the month it was closed in, when nobody set it.
--
-- ## The people
--
-- `project_people`: one row per person who worked on the project, with or
-- without a Piloti account: former staff, external planners, the client's
-- project manager. Name, Funktion, Firma, von–bis (months), and optionally the
-- WorkOS user id of their Piloti account. No e-mail and no phone: as few fields
-- as the purpose needs (GDPR Art. 5(1)(c)). A row is deleted outright, never
-- soft-deleted: deleting it is the erasure (Art. 17). The rows never reach the
-- agent's prompt: the profile does, and they are not in it.
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "started_on" date;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "ended_on" date;
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_period_check";
--> statement-breakpoint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_period_check" CHECK (
    ("started_on" IS NULL OR extract(day FROM "started_on") = 1)
    AND ("ended_on" IS NULL OR extract(day FROM "ended_on") = 1)
    AND ("started_on" IS NULL OR "ended_on" IS NULL OR "ended_on" >= "started_on")
  );
--> statement-breakpoint
COMMENT ON COLUMN "projects"."started_on" IS 'Beginn, month precision: always the first of its month (0115).';
--> statement-breakpoint
COMMENT ON COLUMN "projects"."ended_on" IS 'Abschluss, month precision: always the first of its month. Closing fills it when unset (0115).';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_people" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "name" text NOT NULL,
  "function" text,
  "company" text,
  "started_on" date,
  "ended_on" date,
  "user_id" text,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_people_project_fkey" FOREIGN KEY ("project_id", "organization_id")
    REFERENCES "projects" ("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "project_people_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 200),
  CONSTRAINT "project_people_function_length" CHECK ("function" IS NULL OR char_length("function") <= 200),
  CONSTRAINT "project_people_company_length" CHECK ("company" IS NULL OR char_length("company") <= 200),
  CONSTRAINT "project_people_period_check" CHECK (
    ("started_on" IS NULL OR extract(day FROM "started_on") = 1)
    AND ("ended_on" IS NULL OR extract(day FROM "ended_on") = 1)
    AND ("started_on" IS NULL OR "ended_on" IS NULL OR "ended_on" >= "started_on")
  )
);
--> statement-breakpoint
COMMENT ON TABLE "project_people" IS
  'Everyone who worked on a project, with or without a Piloti account (0115, ADR-0083). Personal data of people who did not give it: name, function, company, months, an optional account link, nothing else. Deleted outright on request. Never part of the agent''s prompt.';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_people_project_idx" ON "project_people" ("organization_id", "project_id", "name");
--> statement-breakpoint
SELECT grid_secure_table('project_people', 'organization_id = grid_current_org()');
--> statement-breakpoint
-- The Steckbrief of a closed project is read-only (ADR-0082): the 0114 guard
-- refuses a person added to one. Deleting a person stays possible: erasure.
DROP TRIGGER IF EXISTS "project_people_closed_project_guard" ON "project_people";
--> statement-breakpoint
CREATE TRIGGER "project_people_closed_project_guard"
  BEFORE INSERT ON "project_people"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_insert_into_closed_project();
