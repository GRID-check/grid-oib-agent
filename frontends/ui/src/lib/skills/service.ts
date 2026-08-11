/**
 * Agent Skills domain service — the ORG TOOLBOX.
 *
 * Responsibilities (ADR-0017): authorization (feature gate, org skill
 * management), the agentskills.io write rules, and skill resolution — which
 * skills apply to an agent, and the deterministic snapshot a job pins when it
 * attaches one. The service NEVER returns raw error statuses; it throws typed
 * errors from `@/lib/api/errors`.
 *
 * Scheduling lives in `@/lib/jobs/service`, not here. A skill knows nothing
 * about time: a JOB is a prompt on a timer that MAY attach a skill, exactly as
 * typing `/name` before a message would.
 */

import 'server-only'
import { canManageSkills } from '@/lib/authz/organizations'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Skill, SkillOrigin } from '@/lib/db/schema'
import * as repository from './repository'
import {
  CHAT_SKILL_AGENT,
  KNOWN_SKILL_AGENTS,
  METADATA_AGENTS,
  type CreateSkillInput,
  type PatchSkillInput,
  type SkillSnapshot,
} from './types'
import { findPlatformSkill, listPlatformSkills } from './platform-skills'

// ---------------------------------------------------------------------------
// Feature gate + authorization helpers
// ---------------------------------------------------------------------------

/** Every session-facing call gates on the skills feature (routes do the same). */
function assertSkillsFeatureOn(session: AuthorizedSession): void {
  if (requireSkillsEnabled(session)) {
    throw new ForbiddenError('Agent Skills is disabled.')
  }
}

// ---------------------------------------------------------------------------
// Org toolbox (skills)
// ---------------------------------------------------------------------------

/**
 * A merged toolbox row. Org rows carry their id; builtin platform entries have
 * no DB row yet (id null) and are always enabled.
 */
export type SkillListItem = {
  id: string | null
  name: string
  description: string
  /** Full instruction body — the job builder's WYSIWYG preview needs it. */
  body: string
  metadata: Record<string, string>
  origin: SkillOrigin | 'platform'
  enabled: boolean
  clonedFrom: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

function platformToListItem(platform: ReturnType<typeof listPlatformSkills>[number]): SkillListItem {
  return {
    id: null,
    name: platform.name,
    description: platform.description,
    body: platform.body,
    // The generated module carries the frontmatter `metadata` verbatim, so the
    // toolbox reads a skill's real reserved keys (`grid-agents`, `grid-cards`)
    // rather than deriving badges from defaults.
    metadata: { ...platform.metadata },
    origin: 'platform',
    enabled: true,
    clonedFrom: null,
    createdAt: null,
    updatedAt: null,
  }
}

function orgToListItem(skill: Skill): SkillListItem {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    body: skill.body,
    metadata: { ...skill.metadata },
    origin: skill.origin,
    enabled: skill.enabled,
    clonedFrom: skill.clonedFrom,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }
}

/**
 * The merged toolbox list: every platform builtin PLUS every org row, org rows
 * shadowing platform entries of the same name. Any member may read.
 */
export async function listSkills(session: AuthorizedSession): Promise<{ skills: SkillListItem[] }> {
  assertSkillsFeatureOn(session)
  const rows = await repository.listSkillsInOrg(session.organizationId)
  const byName = new Map<string, SkillListItem>()
  for (const platform of listPlatformSkills()) {
    byName.set(platform.name, platformToListItem(platform))
  }
  for (const row of rows) {
    byName.set(row.name, orgToListItem(row))
  }
  return { skills: [...byName.values()] }
}

/** One entry of the composer's `/` menu — progressive disclosure level 1. */
export type InvocableSkill = {
  name: string
  description: string
  origin: SkillOrigin | 'platform'
}

/**
 * The skills a member may invoke with `/name` in chat.
 *
 * Deliberately level-1 ONLY: name + description, never a body. That is not an
 * optimisation, it is the same contract the agent runs under — at turn start
 * the model sees exactly this much about each skill, and the full instructions
 * enter context only when something calls `use_skill`. The menu a user reads
 * and the catalogue the model reads are therefore the same text, so a skill
 * whose description does not explain when to use it looks equally unhelpful to
 * both, which is the feedback a skill author needs.
 *
 * Filtered to what can actually run in a chat turn (`shallow_researcher`), so
 * the menu can never offer a deep-research skill the turn cannot execute.
 * Disabled skills are excluded. Any org member may list — invoking a skill is
 * using the product, not administering it; authoring stays `org:skills:manage`.
 */
export async function listInvocableSkills(
  session: AuthorizedSession,
): Promise<{ skills: InvocableSkill[] }> {
  assertSkillsFeatureOn(session)
  const { skills } = await resolveSkillsForAgent(session.organizationId, CHAT_SKILL_AGENT)
  return {
    skills: skills
      .map(({ name, description, origin }) => ({ name, description, origin }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }
}

/**
 * Author a skill in the org toolbox. `org:skills:manage` required. Reserved
 * metadata is validated by `createSkillSchema` at the route boundary; a
 * `clonedFrom` hint records a platform clone.
 */
export async function createSkill(
  session: AuthorizedSession,
  input: CreateSkillInput,
): Promise<{ skill: Skill }> {
  assertSkillsFeatureOn(session)
  if (!canManageSkills(session)) throw new ForbiddenError('You need org skills management rights.')

  const existing = await repository.findSkillByName(input.name, session.organizationId)
  if (existing) {
    throw new ConflictError(`A skill named "${input.name}" already exists in this organization.`)
  }

  const skill = await repository.insertSkill({
    organizationId: session.organizationId,
    name: input.name,
    description: input.description,
    body: input.body,
    metadata: input.metadata ?? {},
    origin: input.clonedFrom ? 'platform-clone' : 'org',
    clonedFrom: input.clonedFrom ?? null,
    enabled: input.enabled ?? true,
    createdBy: session.userId,
    createdByEmail: session.email,
  })
  return { skill }
}

export async function updateSkill(
  session: AuthorizedSession,
  skillId: string,
  patch: PatchSkillInput,
): Promise<{ skill: Skill }> {
  assertSkillsFeatureOn(session)
  if (!canManageSkills(session)) throw new ForbiddenError('You need org skills management rights.')

  const existing = await repository.findSkill(skillId, session.organizationId)
  if (!existing) throw new NotFoundError('Skill not found.')

  if (patch.name !== undefined && patch.name !== existing.name) {
    const other = await repository.findSkillByName(patch.name, session.organizationId)
    if (other) throw new ConflictError(`A skill named "${patch.name}" already exists in this organization.`)
  }

  const skill = await repository.updateSkill(skillId, session.organizationId, {
    ...patch,
    updatedAt: new Date(),
  })
  if (!skill) throw new NotFoundError('Skill not found.')
  return { skill }
}

export async function deleteSkill(
  session: AuthorizedSession,
  skillId: string,
): Promise<{ deleted: true }> {
  assertSkillsFeatureOn(session)
  if (!canManageSkills(session)) throw new ForbiddenError('You need org skills management rights.')

  const existing = await repository.findSkill(skillId, session.organizationId)
  if (!existing) throw new NotFoundError('Skill not found.')
  await repository.deleteSkill(skillId, session.organizationId)
  return { deleted: true }
}

// ---------------------------------------------------------------------------
// Snapshot resolution (what a job pins when it attaches a skill)
// ---------------------------------------------------------------------------

/** Org row first, builtin platform fallback; unknown names 404. */
export async function resolveSkillSnapshot(
  name: string,
  organizationId: string,
): Promise<SkillSnapshot> {
  const orgSkill = await repository.findSkillByName(name, organizationId)
  if (orgSkill) {
    return {
      name: orgSkill.name,
      description: orgSkill.description,
      body: orgSkill.body,
      metadata: { ...orgSkill.metadata },
      origin: orgSkill.origin,
    }
  }
  const platform = findPlatformSkill(name)
  if (platform) {
    return {
      name: platform.name,
      description: platform.description,
      body: platform.body,
      metadata: {},
      origin: 'platform',
    }
  }
  throw new NotFoundError(`Unknown skill "${name}".`)
}

// ---------------------------------------------------------------------------
// Agent resolution (internal)
// ---------------------------------------------------------------------------

/**
 * The resolved skill set for a run: platform builtins merged with the org's
 * enabled rows (org shadows platform on name), filtered by `grid-agents` when
 * an agent is named (absent = all agents). No session — the internal resolve
 * route serves the backend's /v1/chat/skills.
 */
export async function resolveSkillsForAgent(
  organizationId: string,
  agent?: string,
): Promise<{
  skills: { name: string; description: string; body: string; metadata: Record<string, string>; origin: SkillOrigin | 'platform' }[]
}> {
  const rows = await repository.listSkillsInOrg(organizationId)
  const byName = new Map<string, { name: string; description: string; body: string; metadata: Record<string, string>; origin: SkillOrigin | 'platform' }>()
  for (const platform of listPlatformSkills()) {
    // Platform metadata rides along VERBATIM. Sending `{}` here dropped the
    // reserved `grid-*` keys, and because the backend resolver merges this
    // payload OVER its own filesystem copy, the shipped
    // `grid-execution: deep-research` targeting was erased on arrival — the
    // chat agent was then offered writer/sandbox skills it cannot execute.
    if (agent && !skillTargetsAgent(platform.metadata, agent)) continue
    byName.set(platform.name, {
      name: platform.name,
      description: platform.description,
      body: platform.body,
      metadata: { ...platform.metadata },
      origin: 'platform',
    })
  }
  for (const row of rows) {
    if (!row.enabled) continue
    if (agent && !skillTargetsAgent(row.metadata, agent)) continue
    byName.set(row.name, {
      name: row.name,
      description: row.description,
      body: row.body,
      metadata: { ...row.metadata },
      origin: row.origin,
    })
  }
  return { skills: [...byName.values()] }
}

/**
 * Whether a skill applies to `agent` — the mirror of the backend resolver's
 * `_skill_applies_to_agent` (`src/aiq_agent/skills/resolver.py`).
 *
 * ONE gate: `grid-agents`, a comma-separated allowlist, absent = every agent.
 * Names that match no known agent are ignored rather than obeyed, so a typo
 * cannot silently delete a skill from every agent at once.
 *
 * `grid-execution` is deliberately NOT a gate here, though it once was. It says
 * what a SCHEDULED run of the skill produces — a chat turn or a deep-research
 * report — and reading that as an availability rule let a skill's output format
 * decide where the skill existed. A skill whose scheduled runs write a report
 * is still an ordinary skill to invoke in chat.
 *
 * The builtins that truly cannot run in a chat turn declare
 * `grid-agents: deep_researcher`, which is the mechanism for precisely that.
 * `platform-skills.spec.ts` pins that they all still do, because it is now the
 * only thing keeping them out of the composer's `/` menu.
 *
 * Kept deliberately close to the Python in shape as well as behaviour: the two
 * are a contract pair, and `service.spec.ts` pins them against the same cases.
 */
function skillTargetsAgent(metadata: Record<string, string>, agent: string): boolean {
  const raw = metadata[METADATA_AGENTS]
  if (!raw) return true
  const listed = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const known = listed.filter((name) => (KNOWN_SKILL_AGENTS as readonly string[]).includes(name))
  return known.length === 0 || known.includes(agent)
}
