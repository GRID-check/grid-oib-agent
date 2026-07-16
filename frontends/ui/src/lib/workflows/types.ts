/**
 * Workflow definition (versioned builder state) and request payload schemas.
 *
 * The `definition` JSONB carries a `version` field so a future multi-step
 * builder can migrate (ADR-0023 §2). Version 1 is a single block-based research
 * brief compiled to Markdown by `compiler.ts`.
 */

import { z } from 'zod'
import { isValidCronExpression, isValidTimezone } from './schedule'

export const WORKFLOW_DEFINITION_VERSION = 1
export const MAX_WORKFLOW_NAME_LENGTH = 200
export const MAX_WORKFLOW_DESCRIPTION_LENGTH = 2000
/** Matches the backend `JobSubmitRequest.input` cap. */
export const MAX_COMPILED_PROMPT_LENGTH = 32000
export const MAX_DATA_SOURCES = 50

/**
 * The `knowledge_layer` data source (project documents + OIB base corpus) is the
 * product's factual/normative basis, so it is ALWAYS included in every workflow
 * run — a research run without it is never intended (product decision). The
 * stored/user-selectable `dataSources` list therefore means "additional sources"
 * on top of this one; the backend contract stays `data_sources: string[] | null`
 * (null = all sources available to the agent).
 *
 * This is the config-defined source id from the `data_source_registry` — keep in
 * sync with `configs/*.yml` (`config_oib_openrouter.yml` → data_sources).
 */
export const KNOWLEDGE_SOURCE_ID = 'knowledge_layer'

/**
 * Normalize a stored/submitted `dataSources` value so the always-on
 * `knowledge_layer` source is present:
 * - `null` (all sources) is returned unchanged.
 * - an array is returned as a copy with `knowledge_layer` prepended when absent
 *   (an empty array becomes `['knowledge_layer']`); when already present the
 *   array is returned unchanged (copied).
 *
 * Applied both when persisting (create/update) and when building the fire
 * payload, so legacy rows written before this rule still submit with knowledge.
 */
export function withAlwaysOnKnowledge(dataSources: string[] | null): string[] | null {
  if (dataSources === null) return null
  if (dataSources.includes(KNOWLEDGE_SOURCE_ID)) return [...dataSources]
  return [KNOWLEDGE_SOURCE_ID, ...dataSources]
}

/** Version-1 block-based research brief. Objective required; the rest optional. */
export const workflowDefinitionSchema = z.object({
  version: z.literal(WORKFLOW_DEFINITION_VERSION),
  blocks: z.object({
    objective: z.string().trim().min(1, 'Objective is required.'),
    context: z.string().trim().min(1).optional(),
    questions: z.array(z.string().trim().min(1)).optional(),
    outputFormat: z.string().trim().min(1).optional(),
  }),
})

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>
export type WorkflowDefinitionBlocks = WorkflowDefinition['blocks']

const dataSourcesSchema = z.array(z.string().trim().min(1)).max(MAX_DATA_SOURCES)

/** Cron/timezone shape check shared by create + patch (min-interval is a
 *  service-level, env-dependent check via schedule.validateCron). */
function refineSchedule(
  value: { scheduleCron?: string | null; scheduleTimezone?: string },
  ctx: z.RefinementCtx,
): void {
  const tz = value.scheduleTimezone ?? 'UTC'
  if (value.scheduleTimezone != null && !isValidTimezone(value.scheduleTimezone)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scheduleTimezone'],
      message: 'Unknown IANA timezone.',
    })
  }
  if (value.scheduleCron != null && !isValidCronExpression(value.scheduleCron, tz)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scheduleCron'],
      message: 'Invalid 5-field cron expression.',
    })
  }
}

export const createWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_WORKFLOW_NAME_LENGTH),
    description: z.string().trim().max(MAX_WORKFLOW_DESCRIPTION_LENGTH).optional(),
    definition: workflowDefinitionSchema,
    dataSources: dataSourcesSchema.nullish(),
    enabled: z.boolean().optional(),
    scheduleCron: z.string().trim().min(1).nullish(),
    scheduleTimezone: z.string().trim().min(1).optional(),
  })
  .superRefine(refineSchedule)

export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>

export const patchWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_WORKFLOW_NAME_LENGTH).optional(),
    description: z.string().trim().max(MAX_WORKFLOW_DESCRIPTION_LENGTH).nullish(),
    definition: workflowDefinitionSchema.optional(),
    dataSources: dataSourcesSchema.nullish(),
    enabled: z.boolean().optional(),
    scheduleCron: z.string().trim().min(1).nullish(),
    scheduleTimezone: z.string().trim().min(1).optional(),
  })
  .superRefine(refineSchedule)

export type PatchWorkflowInput = z.infer<typeof patchWorkflowSchema>

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>

/** Body of the internal fire endpoint the scheduler POSTs. */
export const internalFireSchema = z.object({
  workflowId: z.string().uuid(),
})
