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
