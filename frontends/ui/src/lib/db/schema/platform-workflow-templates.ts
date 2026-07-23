import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import {
  DEFAULT_TEMPLATE_AGENT_TYPE,
  type PlatformTemplateContent,
  type TemplateProvenance,
} from '@/lib/platform-workflow-templates/types'

/**
 * Platform workflow templates (ADR-0027) — platform-owner-authored research
 * briefs published into every organization's Workflows template gallery.
 *
 * GLOBAL, not tenant-scoped: there is deliberately no `organization_id` /
 * `project_id`. A published row is visible to every org's gallery, the same way
 * the shared base-knowledge corpus (ADR-0016) is. Selecting a template only
 * PRE-FILLS a project's workflow builder — it never auto-creates or runs
 * anything — so this table is a curated content catalog, carrying no run state.
 *
 * `content` is the per-locale (de/en) author text plus the version-1 block
 * definition; `data_sources` mirrors the `workflows` contract (null = all
 * sources, otherwise the ADDITIONAL sources beyond the always-on knowledge
 * layer). See src/lib/platform-workflow-templates/types.ts and
 * docs/architecture/workflows.md ("Platform templates").
 */

export const platformWorkflowTemplates = pgTable(
  'platform_workflow_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    provenance: text('provenance').$type<TemplateProvenance>().notNull().default('auto'),
    // null = all sources available to the agent.
    dataSources: jsonb('data_sources').$type<string[]>(),
    agentType: text('agent_type').notNull().default(DEFAULT_TEMPLATE_AGENT_TYPE),
    // 5-field cron suggestion; NULL = manual-only template.
    scheduleCron: text('schedule_cron'),
    scheduleTimezone: text('schedule_timezone').notNull().default('UTC'),
    content: jsonb('content').$type<PlatformTemplateContent>().notNull(),
    published: boolean('published').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdByEmail: text('created_by_email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // NOTE: the org-facing gallery scan is backed by a PARTIAL index on
  // (sort_order, created_at) WHERE published — the drizzle builder can't express
  // a partial index, so it lives in migration 0024_platform_workflow_templates.sql
  // (same arrangement as `workflows`' partial due-scan index).
)

export type PlatformWorkflowTemplate = typeof platformWorkflowTemplates.$inferSelect
export type NewPlatformWorkflowTemplate = typeof platformWorkflowTemplates.$inferInsert
