/**
 * Agent Skills — request payload schemas and reserved-metadata helpers.
 *
 * The write boundary for the agentskills.io SKILL.md contract
 * (https://agentskills.io/specification):
 *
 *   - `name`: 1–64 chars, lowercase a-z/0-9 and hyphens, no leading, trailing
 *     or consecutive hyphens.
 *   - `description`: 1–1024 chars, non-empty. One sentence: what the skill
 *     does, in the words a colleague types. It is the only thing an agent
 *     sees about the skill until the skill is activated (level 1).
 *   - body: the Markdown instructions loaded on activation (level 2), capped at
 *     32000 to match the backend's job-input limit.
 *   - `metadata`: a flat string→string map. The spec leaves it open and
 *     recommends namespaced keys; the reserved `grid-*` keys below are ours.
 *     Every other key is opaque.
 *
 * `grid-execution` and `grid-schedulable` used to live here too. Both are gone:
 * a skill says nothing about WHEN a JOB runs or WHAT a run produces. Scheduling
 * is a property of the JOB that attaches the skill, and the output kind is the
 * user's choice on that job (`jobs.output`). `grid-auto-invoke` is catalog
 * membership, not scheduling: slash and jobs still attach the skill when it is
 * off.
 */

import { z } from 'zod'
import {
  isSelectableCardType,
  parsePreferredCardTypes,
} from '@/features/skills/lib/card-catalog'
import { PLATFORM_SKILL_DELIVERIES, type SkillOrigin } from '@/lib/db/schema'

export const MAX_SKILL_NAME_LENGTH = 64
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024
export const MAX_SKILL_BODY_LENGTH = 32000

// ---------------------------------------------------------------------------
// Reserved metadata keys
// ---------------------------------------------------------------------------

/**
 * `grid-agents` — comma-separated agent names this skill is for; absent = all
 * agents. THE availability gate: it is consumed by the resolve endpoint, by the
 * composer's `/` menu, and by the job builder's skill picker (an output kind
 * maps to exactly one agent, so a job can never attach a skill it cannot run).
 */
export const METADATA_AGENTS = 'grid-agents'

/**
 * `grid-cards` — comma-separated Grid card `type` values the skill would like
 * its answers rendered as; absent = no preference.
 *
 * A PREFERENCE, not a contract. It is inert until the skill is activated, at
 * which point the Python runtime appends a short block naming these types to
 * the skill body it hands the model. Because that text goes to the model, the
 * write boundary only accepts cards the model is allowed to emit: system cards
 * (`memory_proposal`, `document_grid`) come from tools on sanctioned paths, and
 * inviting the model to produce one would be inviting it to fabricate one.
 */
export const METADATA_CARDS = 'grid-cards'

/**
 * `grid-catalog` — whether a PLATFORM skill is offered to organizations.
 *
 * Only meaningful on a platform skill (a file under
 * `src/aiq_agent/skills/builtin/`), because only those have two possible
 * audiences:
 *
 *   absent            Machinery. The pipeline's own instructions. Never listed
 *                     on the Skills tab, never switchable, always resolved.
 *
 *   `curated`         A capability published TO organizations. Listed on the
 *                     Skills tab with a switch. A chat-usable FILE starts ON;
 *                     a dashboard offer or a deep-research-only file starts
 *                     OFF (`curated_skill_activations` records the decision).
 *
 * Machinery is the DEFAULT, deliberately: a new builtin that says nothing about
 * itself stays invisible, and exposing one to every tenant has to be a sentence
 * somebody wrote.
 */
export const METADATA_CATALOG = 'grid-catalog'

/** The one `grid-catalog` value that means "offer this to organizations". */
export const CATALOG_CURATED = 'curated'

/**
 * Whether a platform skill is offered to organizations rather than being
 * pipeline machinery. Case- and whitespace-insensitive; anything unrecognised
 * reads as machinery, which is the closed default.
 */
export function isCuratedPlatformSkill(metadata: Record<string, string>): boolean {
  return (metadata[METADATA_CATALOG] ?? '').trim().toLowerCase() === CATALOG_CURATED
}

/**
 * `grid-hidden` — keep a skill's activation OUT OF THE NOISY LIVE LINE.
 *
 * A boolean-ish flag mirroring the Python `GRID_HIDDEN_KEY`. Some skills apply
 * on every single answer (a house voice is the type case), so announcing them
 * live under every turn is pure noise. A hidden skill's activation is routed to
 * the technical channel instead of the live one (backend `events.py`), so it
 * stays out of the running line but STILL fires and STILL records.
 *
 * Hidden means "not in the live one-liner by default", NEVER "concealed": the
 * `SkillsUsedDisclosure` still names it, and a reader who turns on the
 * `showReasoningSkills` preference surfaces it in the reasoning view. Doctrine,
 * not a nicety — a product built on traceable sourcing must not have a class of
 * instruction it declines to admit ran (agent-skills.md, activation
 * transparency).
 */
export const METADATA_HIDDEN = 'grid-hidden'

/** Case-insensitive truthy tokens marking a skill hidden; anything else visible. */
const HIDDEN_TRUE: ReadonlySet<string> = new Set(['true', '1', 'yes'])

/**
 * Whether a skill's live activation line is suppressed by default.
 *
 * Fail-open like every other reserved-metadata reader: an absent or
 * unrecognised value reads as visible, because visible is the safe default —
 * forgetting the flag shows a line too many rather than silently swallowing a
 * skill's activation from the live line without anyone asking.
 */
export function isHiddenSkill(metadata: Record<string, string>): boolean {
  return HIDDEN_TRUE.has((metadata[METADATA_HIDDEN] ?? '').trim().toLowerCase())
}

/**
 * `grid-auto-invoke` — whether the model may pick this skill from L1.
 *
 * On (the default, and the absent key): the one-line description sits in the
 * catalog the model reads every turn, and it may call `use_skill` unprompted.
 * Off: the skill is still resolved, still in the `/` picker, still attachable
 * to a job, still loadable when forced. It is merely invisible to the model
 * until a person or a job names it.
 *
 * Mirrors the Python `GRID_AUTO_INVOKE_KEY`. This is not scheduling.
 */
export const METADATA_AUTO_INVOKE = 'grid-auto-invoke'

/** Case-insensitive falsy tokens marking auto-invoke off; anything else is on. */
const AUTO_INVOKE_FALSE: ReadonlySet<string> = new Set(['false', '0', 'no'])

/**
 * Whether the model may pick this skill from the L1 catalog unprompted.
 *
 * Absent or unrecognised reads as on: that is today's behaviour, and forgetting
 * the flag must not silently hide a skill from every turn.
 */
export function isAutoInvokeSkill(metadata: Record<string, string>): boolean {
  const token = (metadata[METADATA_AUTO_INVOKE] ?? '').trim().toLowerCase()
  if (!token) return true
  return !AUTO_INVOKE_FALSE.has(token)
}

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

/**
 * The agent a chat turn runs on, and therefore the one a `/name` invocation
 * from the composer resolves against.
 */
export const CHAT_SKILL_AGENT: KnownSkillAgent = 'shallow_researcher'

/**
 * The card types a skill prefers, in author order; `[]` when unset.
 *
 * Filtered against the live catalogue on READ as well as on write, so a row
 * stored before a card type was retired cannot put a name in front of the model
 * (or in front of the editor's chips) that no longer exists. A stale entry is
 * not worth throwing over: the preference degrades to the remaining cards,
 * which is exactly what the author meant.
 */
export function preferredCardsOf(metadata: Record<string, string>): string[] {
  return parsePreferredCardTypes(metadata[METADATA_CARDS])
}

/** The deterministic WYSIWYG copy a job (and every run) pins. */
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
 * Anything shaped like an XML/HTML tag.
 *
 * NOT an agentskills.io rule — the open format says nothing about tags. It is a
 * GRID prompt-safety rule, and it applies to `name` and `description` only:
 * both are interpolated into an agent's system prompt (the level-1 catalogue in
 * `SkillRuntime.prompt_block`), where a stray tag can close a structural
 * element the prompt opened and let skill text land in a position it was never
 * meant to occupy. The body is deliberately NOT checked — it arrives as a tool
 * result, and rejecting tags there would break any skill that documents HTML.
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
  // `grid-cards` is validated HERE rather than tolerated on read, because this
  // is the one place a human is still in the loop: a typo the write boundary
  // waves through only shows up as a card preference that quietly never
  // applies. The Python parser rejects the same values for a SKILL.md file.
  .superRefine((metadata, ctx) => {
    const raw = metadata[METADATA_CARDS]
    if (raw === undefined) return
    const unknown = raw
      .split(',')
      .map((part) => part.trim())
      .filter((type) => type !== '' && !isSelectableCardType(type))
    if (unknown.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [METADATA_CARDS],
        message: `Unknown card type(s) in ${METADATA_CARDS}: ${unknown.join(', ')}.`,
      })
    }
  })

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

/**
 * Body of `PATCH /api/skills/curated/[name]` — an org switching a curated
 * platform skill on or off. The NAME is in the path (a platform skill has no
 * id), so the decision is the whole body.
 */
export const curatedSkillActivationSchema = z.object({
  enabled: z.boolean(),
})

export type CuratedSkillActivationInput = z.infer<typeof curatedSkillActivationSchema>

/**
 * `delivery` — how a curated skill reaches organizations.
 *
 * The DB constraint (`platform_skills_delivery_check`, 0049) says the same
 * thing; this is the boundary that turns a bad value into a 400 with a message
 * rather than a 500 from Postgres. Both are needed: the schema catches the
 * caller, the constraint catches everything that is not a caller.
 */
export const platformSkillDeliverySchema = z.enum(PLATFORM_SKILL_DELIVERIES)

/**
 * Platform → Skills write boundary: the fleet-wide catalogue.
 *
 * The same SKILL.md rules as an org skill, because it is the same document —
 * a curated skill is not a privileged shape, it is the same thing written one
 * tier up. Two extra fields, and both default closed:
 *
 *   `published`  false. The dashboard is a writing surface, and a draft must
 *                not reach every tenant.
 *   `delivery`   `offer`. A skill that says nothing about its audience is one
 *                organizations may take or leave, never one imposed on them.
 *
 * Imposing on the fleet therefore takes two deliberate words, which is the
 * right price for the only combination a tenant cannot undo.
 */
export const createPlatformSkillSchema = z.object({
  name: skillNameSchema,
  description: descriptionSchema,
  body: bodySchema,
  metadata: metadataSchema.optional(),
  published: z.boolean().optional(),
  delivery: platformSkillDeliverySchema.optional(),
})

export type CreatePlatformSkillInput = z.infer<typeof createPlatformSkillSchema>

export const patchPlatformSkillSchema = createPlatformSkillSchema.partial()

export type PatchPlatformSkillInput = z.infer<typeof patchPlatformSkillSchema>

/** Query of the internal resolve endpoint (skills available to an agent). */
export const resolveQuerySchema = z.object({
  organization_id: z.string().trim().min(1),
  agent: z.string().trim().min(1).optional(),
})

export type ResolveQuery = z.infer<typeof resolveQuerySchema>
