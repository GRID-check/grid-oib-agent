/**
 * Platform workflow templates (ADR-0027) — content model + request/interchange
 * schemas.
 *
 * A platform template is a curated, GLOBAL research brief the platform owner
 * publishes into every organization's Workflows gallery. Unlike the built-in
 * templates (whose text lives in the i18n dictionaries), a platform template
 * carries author-written text for BOTH supported locales (de + en) so the
 * gallery can render it in the viewer's active locale. Selecting it only
 * pre-fills a project's workflow builder — it never auto-creates or runs — so
 * the schema mirrors the builder's version-1 block definition and the
 * `workflows` data-source contract (null = all sources; otherwise ADDITIONAL
 * sources beyond the always-on knowledge layer).
 */

import { z } from 'zod'
import {
  MAX_WORKFLOW_DESCRIPTION_LENGTH,
  MAX_WORKFLOW_NAME_LENGTH,
  MAX_DATA_SOURCES,
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from '@/lib/workflows/types'
import { isValidCronExpression, isValidTimezone } from '@/lib/workflows/schedule'

/** The two locales the gallery renders; every template must supply both. */
export const TEMPLATE_LOCALES = ['de', 'en'] as const
export type TemplateLocale = (typeof TEMPLATE_LOCALES)[number]

/** Presentational provenance tint the gallery card's icon tile carries. */
export const TEMPLATE_PROVENANCES = ['law', 'project', 'office', 'auto'] as const
export type TemplateProvenance = (typeof TEMPLATE_PROVENANCES)[number]

/** Default (and, today, only) agent a template drives once adopted. */
export const DEFAULT_TEMPLATE_AGENT_TYPE = 'deep_researcher'

/** Short uppercase pill label shown on a gallery card. */
export const MAX_TEMPLATE_CATEGORY_LENGTH = 40

/**
 * One locale's author-written content: the gallery card text plus the
 * version-1 block definition (the brief that pre-fills the builder). The
 * definition's `objective` is required by `workflowDefinitionSchema`.
 */
export const localizedTemplateContentSchema = z.object({
  name: z.string().trim().min(1).max(MAX_WORKFLOW_NAME_LENGTH),
  description: z.string().trim().min(1).max(MAX_WORKFLOW_DESCRIPTION_LENGTH),
  category: z.string().trim().min(1).max(MAX_TEMPLATE_CATEGORY_LENGTH),
  definition: workflowDefinitionSchema,
})

export type LocalizedTemplateContent = z.infer<typeof localizedTemplateContentSchema>

/** Per-locale content bundle stored in the `content` JSONB column. */
export const platformTemplateContentSchema = z.object({
  de: localizedTemplateContentSchema,
  en: localizedTemplateContentSchema,
})

export type PlatformTemplateContent = z.infer<typeof platformTemplateContentSchema>

const dataSourcesSchema = z.array(z.string().trim().min(1)).max(MAX_DATA_SOURCES)
const provenanceSchema = z.enum(TEMPLATE_PROVENANCES)

/**
 * Cron/timezone SHAPE check (5-field cron + IANA tz). A template's schedule is
 * only a SUGGESTION the adopting user reviews before saving, so the
 * env-dependent min-interval rule enforced on real workflows is intentionally
 * NOT applied here.
 */
function refineTemplateSchedule(
  value: { scheduleCron?: string | null; scheduleTimezone?: string },
  ctx: z.RefinementCtx,
): void {
  const tz = value.scheduleTimezone ?? 'UTC'
  if (value.scheduleTimezone != null && !isValidTimezone(value.scheduleTimezone)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleTimezone'], message: 'Unknown IANA timezone.' })
  }
  if (value.scheduleCron != null && !isValidCronExpression(value.scheduleCron, tz)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['scheduleCron'], message: 'Invalid 5-field cron expression.' })
  }
}

/**
 * Create/import payload. The JSON-file import path validates against this exact
 * schema (an export is a superset with extra read-only keys that are ignored),
 * so an exported template re-imports losslessly. `published` defaults to false:
 * an imported or freshly-created template is a draft until the owner publishes.
 */
export const createPlatformTemplateSchema = z
  .object({
    provenance: provenanceSchema.default('auto'),
    dataSources: dataSourcesSchema.nullish(),
    agentType: z.string().trim().min(1).max(200).optional(),
    scheduleCron: z.string().trim().min(1).nullish(),
    scheduleTimezone: z.string().trim().min(1).optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    published: z.boolean().optional(),
    content: platformTemplateContentSchema,
  })
  .superRefine(refineTemplateSchedule)

export type CreatePlatformTemplateInput = z.infer<typeof createPlatformTemplateSchema>

/** Partial update. `content`, when present, must still carry both locales. */
export const updatePlatformTemplateSchema = z
  .object({
    provenance: provenanceSchema.optional(),
    dataSources: dataSourcesSchema.nullish(),
    agentType: z.string().trim().min(1).max(200).optional(),
    scheduleCron: z.string().trim().min(1).nullish(),
    scheduleTimezone: z.string().trim().min(1).optional(),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    published: z.boolean().optional(),
    content: platformTemplateContentSchema.optional(),
  })
  .superRefine(refineTemplateSchedule)

export type UpdatePlatformTemplateInput = z.infer<typeof updatePlatformTemplateSchema>

/**
 * The JSON-file interchange schema. Import tolerates a leading envelope from an
 * export (`kind`/`version` and the read-only `id`, timestamps) by stripping
 * unknown keys before validating the template body against the create schema.
 */
export const TEMPLATE_EXPORT_KIND = 'grid.workflow-template'
export const TEMPLATE_EXPORT_VERSION = 1

/** DTO returned to the platform UI and (published-only) the org gallery. */
export interface PlatformTemplateDto {
  id: string
  provenance: TemplateProvenance
  dataSources: string[] | null
  agentType: string
  scheduleCron: string | null
  scheduleTimezone: string
  content: PlatformTemplateContent
  published: boolean
  sortOrder: number
  createdByEmail: string | null
  createdAt: string
  updatedAt: string
}

/** Re-export so the definition type is importable from one place. */
export type { WorkflowDefinition }
