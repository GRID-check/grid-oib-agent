/**
 * Jobs — request payload schemas and the shared job-level helpers.
 *
 * A **job is a prompt on a timer**. It fires into a fresh run the way a person
 * opening a new chat and typing would, and a skill MAY be attached on top,
 * exactly as typing `/name` before the message would attach it.
 *
 * The write boundary therefore validates:
 *
 *   - `prompt`: REQUIRED, 1–8000 chars, trimmed. It is what the job IS; the old
 *     shape derived it from the pinned skill, which made "ask this question
 *     every Monday" unexpressible without first inventing a skill for it.
 *   - `skillName`: OPTIONAL/nullable. Absent means no skill, and then
 *     `skillSnapshot` is NULL as well — the pair is enforced in the database by
 *     `jobs_skill_pair_check`, so no writer may produce one without the other.
 *   - `output`: a plain enum over `JOB_OUTPUTS`. It is the USER's choice on the
 *     job, not something derived from skill metadata: `grid-execution` (and
 *     `grid-schedulable`) no longer exist.
 *   - cron/timezone: 5-field cron in an IANA timezone, min-interval enforced at
 *     save time (`./schedule`).
 */

import { z } from 'zod'
import { JOB_OUTPUTS, type JobOutput } from '@/lib/db/schema'
import { skillNameSchema, type KnownSkillAgent, type SkillSnapshot } from '@/lib/skills/types'
import { isValidCronExpression, isValidTimezone } from './schedule'

export const MAX_JOB_NAME_LENGTH = 200
/**
 * The prompt cap. Deliberately well under the backend's 48000-char ceiling for
 * the COMPOSED input (job prompt + the attached skill's 32000-char body), so a
 * job that attaches the largest legal skill still fits.
 */
export const MAX_JOB_PROMPT_LENGTH = 8000
export const MAX_DATA_SOURCES = 50
/** The always-on knowledge source (project documents + OIB base corpus). */
export const KNOWLEDGE_SOURCE_ID = 'knowledge_layer'

/**
 * The agent an output kind runs on — the mirror of `_OUTPUT_AGENT_TYPES` in
 * `routes/skills.py`, and the same mapping the skill picker filters by: a job
 * must never be able to attach a skill its chosen output kind cannot run.
 */
export const AGENT_FOR_OUTPUT: Record<JobOutput, KnownSkillAgent> = {
  chat: 'shallow_researcher',
  'deep-research': 'deep_researcher',
}

/**
 * Normalize a stored/submitted `dataSources` value so the always-on
 * `knowledge_layer` source (project documents + OIB base corpus) is present —
 * the same contract the workflows domain uses. `null` (all sources) stays
 * `null`; an array is returned as a copy with `knowledge_layer` prepended when
 * absent (an empty array becomes `['knowledge_layer']`); when already present
 * the array is returned unchanged.
 */
export function withAlwaysOnKnowledge(dataSources: string[] | null): string[] | null {
  if (dataSources === null) return null
  // A COPY in both branches. Returning the caller's own array when the source
  // was already present made the result alias its input, so a later push on
  // either one silently mutated the other — the one path where this is applied
  // to a stored row's `dataSources` would then edit the row object in place.
  if (dataSources.includes(KNOWLEDGE_SOURCE_ID)) return [...dataSources]
  return [KNOWLEDGE_SOURCE_ID, ...dataSources]
}

/**
 * What a skill-less job's run records in `job_runs.skill_snapshot`.
 *
 * That column is NOT NULL even though `jobs.skill_snapshot` is nullable, so
 * run history keeps ONE shape to read: `{}` is the documented value for "no
 * skill was attached" (see the column comment in `schema/jobs.ts`). The cast is
 * the honest expression of that — an empty object really is what the row holds.
 */
export function emptySkillSnapshot(): SkillSnapshot {
  return {} as SkillSnapshot
}

// ---------------------------------------------------------------------------
// Job schemas
// ---------------------------------------------------------------------------

const jobNameSchema = z
  .string()
  .trim()
  .min(1, 'A job name is required.')
  .max(MAX_JOB_NAME_LENGTH, `Job names are at most ${MAX_JOB_NAME_LENGTH} characters.`)

/** The scheduled prompt: required, trimmed, and never empty. */
export const jobPromptSchema = z
  .string()
  .trim()
  .min(1, 'A prompt is required.')
  .max(MAX_JOB_PROMPT_LENGTH, `Prompts are at most ${MAX_JOB_PROMPT_LENGTH} characters.`)

/**
 * What the run produces. A plain enum over the schema's domain — it is a user
 * choice validated at the write boundary, no longer a value derived from a
 * skill's metadata.
 */
export const jobOutputSchema = z.enum(JOB_OUTPUTS)

/**
 * The attached skill's name, or explicitly none.
 *
 * `nullish`: absent on create means "no skill"; an explicit `null` on patch
 * means "detach the skill I had". Both end with `skill_name` and
 * `skill_snapshot` NULL together.
 */
const attachedSkillNameSchema = skillNameSchema.nullish()

const dataSourcesSchema = z.array(z.string().trim().min(1)).max(MAX_DATA_SOURCES)

/** Cron/timezone shape check shared by create + patch of a job. */
function refineSchedule(
  value: { scheduleCron?: string | null; scheduleTimezone?: string },
  ctx: z.RefinementCtx
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

export const createJobSchema = z
  .object({
    name: jobNameSchema,
    prompt: jobPromptSchema,
    skillName: attachedSkillNameSchema,
    output: jobOutputSchema,
    dataSources: dataSourcesSchema.nullish(),
    enabled: z.boolean().optional(),
    scheduleCron: z.string().trim().min(1).nullish(),
    scheduleTimezone: z.string().trim().min(1).optional(),
  })
  .superRefine(refineSchedule)

export type CreateJobInput = z.infer<typeof createJobSchema>

export const patchJobSchema = z
  .object({
    name: jobNameSchema.optional(),
    prompt: jobPromptSchema.optional(),
    skillName: attachedSkillNameSchema,
    output: jobOutputSchema.optional(),
    dataSources: dataSourcesSchema.nullish(),
    enabled: z.boolean().optional(),
    scheduleCron: z.string().trim().min(1).nullish(),
    scheduleTimezone: z.string().trim().min(1).optional(),
  })
  .superRefine(refineSchedule)

export type PatchJobInput = z.infer<typeof patchJobSchema>

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>

/**
 * Body of the internal fire endpoint the scheduler POSTs.
 *
 * Still `scheduleId`, and deliberately: the scheduler container and the BFF
 * deploy separately, so renaming the wire field would break every scheduled run
 * in the window between the two deploys — the same hazard the `execution` ->
 * `output` rename is carrying a compatibility shim for. It names a `jobs.id`.
 */
export const internalFireSchema = z.object({
  scheduleId: z.string().uuid(),
})

/** Query of the attachable-skills route: which skills a given output can run. */
export const attachableSkillsQuerySchema = z.object({
  output: jobOutputSchema,
})

export type AttachableSkillsQuery = z.infer<typeof attachableSkillsQuerySchema>
