-- 0087: skill categories — the shelves skills stand on.
--
-- ## The gap this closes
--
-- The Skills tab shows two flat piles: platform-curated offers on top, the
-- org's own skills below. Sixteen platform skills and a growing org catalogue
-- with no grouping is a drawer nobody opens — curation you cannot arrange is
-- curation nobody keeps. Categories give both curators a shelf: the platform
-- owner arranges the fleet catalogue, each organization arranges its own
-- skills, and an org skill may also stand on a platform shelf.
--
-- ## Why one table and not two
--
-- A NULL `organization_id` IS a platform shelf; a set one is that org's own.
-- Two tables (platform shelves, org shelves) would need every read, write and
-- validation to exist twice for no additional safety: the tenant boundary
-- already distinguishes them, and the UI reads them as one ordered list
-- (platform shelves first, then the org's own). One table, one predicate.
--
-- ## Names are unique per shelf-owner
--
-- Postgres treats NULLs as distinct, so one plain UNIQUE would let two
-- platform shelves share a name. Two partial indexes instead: names unique
-- among platform rows, and unique within each org.
--
-- ## Seed and backfill
--
-- Five platform shelves from the builtin collections the sync script already
-- groups files by (oib, research, presentation, bim, synthesis), with STABLE
-- ids: seed rows are referenced by the backfill below and by later seed
-- migrations, and a random id would make this migration unrepeatable in
-- review. `platform_skills` rows are sorted onto them by today's builtin
-- name lists; dashboard-authored rows stay unsorted (NULL) until a platform
-- owner shelves them — categorising the catalogue is curation, not migration.
-- Org `skills` rows all start unsorted for the same reason.
--
-- ## RLS
--
-- Tenant predicate with a NULL arm: platform shelves are readable by every
-- tenant, org shelves only by their org —
-- `organization_id IS NULL OR organization_id = grid_current_org()`.
-- The WITH CHECK half is the same predicate, which lets the tenant role write
-- NULL-org rows at the RLS layer; that write path is closed one layer up, in
-- the service (platform shelves require the platform permission, org shelves
-- the org one). RLS is the backstop, never the plan. This migration joins
-- `rls-coverage.spec.ts`'s BOUNDARY_MIGRATIONS.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text,
  "name" text NOT NULL,
  "description" text,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_by" text NOT NULL,
  "created_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_categories_platform_name"
  ON "skill_categories" ("name")
  WHERE "organization_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skill_categories_org_name"
  ON "skill_categories" ("organization_id", "name")
  WHERE "organization_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_categories_organization_id"
  ON "skill_categories" ("organization_id");
--> statement-breakpoint
ALTER TABLE "skills"
  ADD COLUMN IF NOT EXISTS "category_id" uuid REFERENCES "skill_categories" ("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skills_category_id"
  ON "skills" ("category_id");
--> statement-breakpoint
ALTER TABLE "platform_skills"
  ADD COLUMN IF NOT EXISTS "category_id" uuid REFERENCES "skill_categories" ("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_platform_skills_category_id"
  ON "platform_skills" ("category_id");
--> statement-breakpoint
SELECT grid_secure_table('skill_categories',
  'organization_id IS NULL OR organization_id = grid_current_org()');
--> statement-breakpoint
-- Stable seed ids: referenced by the backfill below, so they must not move.
INSERT INTO "skill_categories"
  ("id", "organization_id", "name", "description", "sort_order", "created_by")
VALUES
  ('0b1b0000-0000-4000-8000-000000000001', NULL, 'OIB',
    'OIB-Richtlinien, Bestand und Einreichung — das Baurecht im engeren Sinn.', 10, 'platform-seed'),
  ('0b1b0000-0000-4000-8000-000000000002', NULL, 'Recherche',
    'Recherchieren, rechnen und auswerten — vom Fund zum Befund.', 20, 'platform-seed'),
  ('0b1b0000-0000-4000-8000-000000000003', NULL, 'Präsentation',
    'Pläne, Diagramme und alles, was ein Bild braucht.', 30, 'platform-seed'),
  ('0b1b0000-0000-4000-8000-000000000004', NULL, 'BIM',
    'IFC-Modelle lesen, messen und prüfen.', 40, 'platform-seed'),
  ('0b1b0000-0000-4000-8000-000000000005', NULL, 'Synthese',
    'Aus Recherche Befund machen — Berichte und Prognosen.', 50, 'platform-seed')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- One-time sort of today's builtin platform skills onto their shelves.
-- Dashboard-authored rows keep category_id NULL until curated.
UPDATE "platform_skills" SET "category_id" = '0b1b0000-0000-4000-8000-000000000001'
  WHERE "category_id" IS NULL AND "name" IN
    ('bebauung', 'bestand', 'brandschutz', 'einreichcheck', 'gebaeudeklasse', 'hygiene', 'nutzungssicherheit', 'waermeschutz');
--> statement-breakpoint
UPDATE "platform_skills" SET "category_id" = '0b1b0000-0000-4000-8000-000000000002'
  WHERE "category_id" IS NULL AND "name" IN
    ('data-table-analysis', 'forecast-analysis', 'lightweight-calculation');
--> statement-breakpoint
UPDATE "platform_skills" SET "category_id" = '0b1b0000-0000-4000-8000-000000000003'
  WHERE "category_id" IS NULL AND "name" IN ('diagrams');
--> statement-breakpoint
UPDATE "platform_skills" SET "category_id" = '0b1b0000-0000-4000-8000-000000000004'
  WHERE "category_id" IS NULL AND "name" IN ('ifc-spatial-reasoning');
--> statement-breakpoint
UPDATE "platform_skills" SET "category_id" = '0b1b0000-0000-4000-8000-000000000005'
  WHERE "category_id" IS NULL AND "name" IN ('long-form-report-writer', 'prediction-report-writer');
--> statement-breakpoint
COMMENT ON TABLE "skill_categories" IS
  'Shelves for skills, curated twice: NULL organization_id is a platform shelf (read by all, written via the platform dashboard), a set one is that org''s own shelf for the skills it authors. Skills point here with category_id (SET NULL on delete: removing a shelf never removes the books).';
--> statement-breakpoint
COMMENT ON COLUMN "skills"."category_id" IS
  'The org or platform shelf this skill stands on; NULL is unsorted. Org skills may stand on org or platform shelves.';
--> statement-breakpoint
COMMENT ON COLUMN "platform_skills"."category_id" IS
  'The platform shelf this skill stands on; NULL is unsorted. Tenant shelves are never addressable here — enforced in the service.';
