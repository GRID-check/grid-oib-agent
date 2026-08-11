/**
 * Agent Skills (Phase A) — request payload schemas and reserved-metadata
 * helpers, mirroring the workflows domain (`@/lib/workflows/types`).
 *
 * Skill names and metadata follow the agentskills.io format:
 *
 *   - name: lowercase a-z/0-9/hyphens, no leading/trailing/consecutive
 *     hyphens, 1–64 chars.
 *   - description: 1–1024 chars; body 1–32000 chars.
 *   - metadata: a flat string→string map. Three keys are reserved and read at
 *     schedule/fire time (see below); every other key is opaque content the
 *     agent may consume.
 */

import { z } from 'zod'
import { BadRequestError } from '@/lib/api/errors'
import { SKILL_EXECUTIONS, type SkillExecution, type SkillOrigin } from '@/lib/db/schema'
import { isValidCronExpression, isValidTimezone } from './schedule'

export const MAX_SKILL_NAME_LENGTH = 64
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024
export const MAX_SKILL_BODY_LENGTH = 32000
export const MAX_SKILL_SCHEDULE_NAME_LENGTH = 200
export const MAX_DATA_SOURCES = 50
/** The always-on knowledge source (project documents + OIB base corpus). */
export const KNOWLEDGE_SOURCE_ID = 'knowledge_layer'

// ---------------------------------------------------------------------------
// Reserved metadata keys
// ---------------------------------------------------------------------------

/**
 * `grid-execution` — the DETERMINISTIC execution mode: 'chat' | 'deep-research'
 * (default 'chat'). A skill never implicitly creates a deep research run; the
 * value is read at schedule-save time and denormalized onto the schedule row,
 * and an invalid value is rejected at write time.
 */
export const METADATA_EXECUTION = 'grid-execution'

/**
 * `grid-schedulable` — 'false' opts a skill out of cron scheduling. Default:
 * schedulable (fail-open — any value other than the literal 'false' keeps it
 * schedulable).
 */
export const METADATA_SCHEDULABLE = 'grid-schedulable'

/**
 * `grid-agents` — comma-separated agent names this skill is for; absent = all
 * agents. Consumed by the resolve endpoint and by the fire path's skill
 * selection, never by schedule writes.
 */
export const METADATA_AGENTS = 'grid-agents'

/**
 * The agents a skill may name in `grid-agents`.
 *
 * These are the backend `AGENT_REGISTRY` identifiers — the same strings a
 * schedule's `agent_type`, the job-submit path and the Python resolver's
 * `KNOWN_AGENTS` use, so the feature carries ONE agent vocabulary end to end
 * rather than one per layer.
 */
export const KNOWN_SKILL_AGENTS = ['shallow_researcher', 'deep_researcher'] as const
export type KnownSkillAgent = (typeof KNOWN_SKILL_AGENTS)[number]

/** The execution a skill's metadata demands, deterministically. */
export function executionOf(metadata: Record<string, string>): SkillExecution {
  const raw = metadata[METADATA_EXECUTION]
  if (raw === undefined) return 'chat'
  if ((SKILL_EXECUTIONS as readonly string[]).includes(raw)) return raw as SkillExecution
  // Invalid values fail at write time (createSkill/updateSkill validate), so a
  // stored row carrying one is a bug this throws loudly about rather than
  // silently defaulting — a silently-defaulted deep-research-capable skill
  // could run in chat mode and mislead.
  throw new BadRequestError(
    `Invalid ${METADATA_EXECUTION} value: "${raw}" (expected "chat" or "deep-research").`
  )
}

/**
 * Whether a skill may be cron-scheduled. False ONLY for the literal
 * 'false' — everything else (absent, other values) stays schedulable (the
 * agentskills.io fail-open default).
 */
export function isSchedulable(metadata: Record<string, string>): boolean {
  return metadata[METADATA_SCHEDULABLE] !== 'false'
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

/** The deterministic WYSIWYG copy a schedule (and every run) carries. */
export interface SkillSnapshot {
  name: string
  description: string
  body: string
  metadata: Record<string, string>
  origin: SkillOrigin | 'platform'
}

export function snapshotOf(skill: SkillSnapshot): SkillSnapshot {
  return {
    name: skill.name,
    description: skill.description,
    body: skill.body,
    metadata: { ...skill.metadata },
    origin: skill.origin,
  }
}

// ---------------------------------------------------------------------------
// Skill schemas
// ---------------------------------------------------------------------------

/** Agent Skills name rule: lowercase alphanumerics + single internal hyphens. */
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Words the Agent Skills spec reserves: a skill may not be named after the
 * vendor or the model. Matched as a case-insensitive substring, which is how
 * the spec states it ("must not contain").
 */
export const RESERVED_NAME_WORDS = ['anthropic', 'claude'] as const

/**
 * Anything shaped like an XML/HTML tag. The spec forbids tags in `name` and
 * `description` because both are interpolated into an agent's system prompt,
 * where a stray tag can close a structural element the harness opened and let
 * skill text escape into a position it was never meant to occupy.
 */
export const XML_TAG_PATTERN = /<[^>]+>/

export const skillNameSchema = z
  .string()
  .trim()
  .min(1, 'A skill name is required.')
  .max(MAX_SKILL_NAME_LENGTH, `Skill names are at most ${MAX_SKILL_NAME_LENGTH} characters.`)
  .regex(
    NAME_PATTERN,
    'Skill names must be lowercase a-z/0-9 separated by single hyphens (no leading, trailing or consecutive hyphens).'
  )
  .refine(
    (name) => !RESERVED_NAME_WORDS.some((word) => name.toLowerCase().includes(word)),
    `Skill names must not contain the reserved words ${RESERVED_NAME_WORDS.join(' or ')}.`
  )
  .refine((name) => !XML_TAG_PATTERN.test(name), 'Skill names must not contain XML tags.')

const descriptionSchema = z
  .string()
  .trim()
  .min(1, 'A skill description is required.')
  .max(
    MAX_SKILL_DESCRIPTION_LENGTH,
    `Skill descriptions are at most ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`
  )
  .refine(
    (description) => !XML_TAG_PATTERN.test(description),
    'Skill descriptions must not contain XML tags.'
  )

const bodySchema = z
  .string()
  .min(1, 'The skill body is required.')
  .max(MAX_SKILL_BODY_LENGTH, `Skill bodies are at most ${MAX_SKILL_BODY_LENGTH} characters.`)

const metadataSchema = z
  .record(z.string(), z.string())
  .refine(
    (metadata) => Object.keys(metadata).length <= 64,
    'A skill may carry at most 64 metadata keys.'
  )

export const createSkillSchema = z.object({
  name: skillNameSchema,
  description: descriptionSchema,
  body: bodySchema,
  metadata: metadataSchema.optional(),
  enabled: z.boolean().optional(),
  clonedFrom: z.string().trim().min(1).max(MAX_SKILL_NAME_LENGTH).optional(),
})

export type CreateSkillInput = z.infer<typeof createSkillSchema>

export const patchSkillSchema = z.object({
  name: skillNameSchema.optional(),
  description: descriptionSchema.optional(),
  body: bodySchema.optional(),
  metadata: metadataSchema.optional(),
  enabled: z.boolean().optional(),
})

export type PatchSkillInput = z.infer<typeof patchSkillSchema>

// ---------------------------------------------------------------------------
// Schedule schemas
// ---------------------------------------------------------------------------

const dataSourcesSchema = z.array(z.string().trim().min(1)).max(MAX_DATA_SOURCES)

/** Cron/timezone shape check shared by create + patch of a schedule. */
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

export const createSkillScheduleSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'A schedule name is required.')
      .max(MAX_SKILL_SCHEDULE_NAME_LENGTH),
    skillName: skillNameSchema,
    dataSources: dataSourcesSchema.nullish(),
    enabled: z.boolean().optional(),
    scheduleCron: z.string().trim().min(1).nullish(),
    scheduleTimezone: z.string().trim().min(1).optional(),
  })
  .superRefine(refineSchedule)

export type CreateSkillScheduleInput = z.infer<typeof createSkillScheduleSchema>

export const patchSkillScheduleSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'A schedule name is required.')
      .max(MAX_SKILL_SCHEDULE_NAME_LENGTH)
      .optional(),
    skillName: skillNameSchema.optional(),
    dataSources: dataSourcesSchema.nullish(),
    enabled: z.boolean().optional(),
    scheduleCron: z.string().trim().min(1).nullish(),
    scheduleTimezone: z.string().trim().min(1).optional(),
  })
  .superRefine(refineSchedule)

export type PatchSkillScheduleInput = z.infer<typeof patchSkillScheduleSchema>

export const listRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export type ListRunsQuery = z.infer<typeof listRunsQuerySchema>

/** Body of the internal fire endpoint the scheduler POSTs. */
export const internalFireSchema = z.object({
  scheduleId: z.string().uuid(),
})

/** Query of the internal resolve endpoint (skills available to an agent). */
export const resolveQuerySchema = z.object({
  organization_id: z.string().trim().min(1),
  agent: z.string().trim().min(1).optional(),
})

export type ResolveQuery = z.infer<typeof resolveQuerySchema>