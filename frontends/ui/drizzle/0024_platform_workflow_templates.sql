-- Platform workflow templates (ADR-0027): platform-owner-authored workflow
-- briefs published into every organization's Workflows template gallery.
--
-- Global, NOT tenant-scoped (no organization_id): a published row is visible to
-- every org, mirroring the shared base-knowledge corpus (ADR-0016). Selecting a
-- template in the gallery only PRE-FILLS the project workflow builder — it never
-- auto-creates or runs anything — so this table carries no project/org FK and no
-- run state; it is a curated content catalog.
--
-- `content` holds per-locale (de/en) author text + the version-1 block
-- definition; see src/lib/platform-workflow-templates/types.ts for its schema.
CREATE TABLE IF NOT EXISTS "platform_workflow_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provenance" text DEFAULT 'auto' NOT NULL,
  -- null = all sources available to the agent; otherwise the ADDITIONAL sources
  -- beyond the always-on knowledge layer (same contract as `workflows`).
  "data_sources" jsonb,
  "agent_type" text DEFAULT 'deep_researcher' NOT NULL,
  -- 5-field cron suggestion; NULL = manual-only template.
  "schedule_cron" text,
  "schedule_timezone" text DEFAULT 'UTC' NOT NULL,
  -- Per-locale content: { de: {...}, en: {...} } (name/description/category +
  -- version-1 block definition per locale).
  "content" jsonb NOT NULL,
  "published" boolean DEFAULT false NOT NULL,
  -- Gallery display order (ascending); ties broken by created_at.
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_by" text NOT NULL,
  "created_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Gallery read path: published rows in display order. A partial index keeps the
-- hot org-facing scan tight (unpublished drafts are excluded).
CREATE INDEX IF NOT EXISTS "idx_platform_workflow_templates_published"
  ON "platform_workflow_templates" ("sort_order", "created_at")
  WHERE "published";
