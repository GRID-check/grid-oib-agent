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
import * as platformRepository from './platform-repository'
import {
  CHAT_SKILL_AGENT,
  KNOWN_SKILL_AGENTS,
  METADATA_AGENTS,
  isCuratedPlatformSkill,
  type CreateSkillInput,
  type PatchSkillInput,
  type SkillSnapshot,
} from './types'
import { findPlatformSkill, listPlatformSkills, type PlatformSkill } from './platform-skills'

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

/** A skill the platform offers organizations, whichever tier it came from. */
type CuratedSkill = Pick<PlatformSkill, 'name' | 'description' | 'body' | 'metadata'>

/**
 * Everything the platform OFFERS organizations, from both sources:
 *
 *   - published rows of `platform_skills`, written in Platform → Skills. This
 *     is the one that matters day to day: we author a skill there and every
 *     organization can switch it on, with the body staying ours.
 *   - builtin FILES that opt in with `grid-catalog: curated`. None ship today;
 *     the door exists so a builtin can become org-facing without becoming a
 *     database row first.
 *
 * Everything else under `builtin/` is the deep-research pipeline's machinery
 * and is nobody's decision: it never appears on the Skills tab, never carries a
 * switch, and always resolves. Machinery is the DEFAULT, so a builtin becomes
 * org-facing only by saying so (see METADATA_CATALOG).
 *
 * Names cannot collide across the two: `platform-service.ts::assertNameIsFree`
 * refuses a curated row named after any builtin, precisely so that switching a
 * curated skill on can never shadow the machinery.
 */
async function curatedOffers(): Promise<CuratedSkill[]> {
  const rows = await platformRepository.listPublishedPlatformSkillRows()
  const byName = new Map<string, CuratedSkill>()
  for (const file of listPlatformSkills()) {
    if (isCuratedPlatformSkill(file.metadata)) byName.set(file.name, file)
  }
  for (const row of rows) {
    byName.set(row.name, {
      name: row.name,
      description: row.description,
      body: row.body,
      metadata: { ...row.metadata },
    })
  }
  return [...byName.values()]
}

/**
 * An offer as a toolbox row.
 *
 * `id` stays null even for a `platform_skills` row: that id belongs to the
 * platform catalogue, and handing it to a tenant would invite a PATCH against
 * `/api/skills/{id}` — an org editing the fleet's copy. The switch addresses an
 * offer by NAME instead. `enabled` is the org's own decision, and its default
 * is OFF: the platform publishes, the organization chooses.
 */
function platformToListItem(platform: CuratedSkill, enabled: boolean): SkillListItem {
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
    enabled,
    clonedFrom: null,
    createdAt: null,
    updatedAt: null,
  }
}

/**
 * Whether a curated skill is switched on for an org.
 *
 * No row means no decision, and no decision means OFF — a curated skill is an
 * offer, not an installation.
 */
function isActivated(
  activations: { skillName: string; enabled: boolean }[],
  name: string,
): boolean {
  return activations.find((activation) => activation.skillName === name)?.enabled ?? false
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
 * What this organization has: its own skills, plus the platform skills offered
 * to it. Any member may read.
 *
 * The pipeline's MACHINERY is deliberately not here, though it used to be —
 * all five builtins were merged in as equal rows, each with a "clone" button.
 * Nobody installs one, nobody can edit one, and none of them is an
 * organization's decision: every builtin shipping today declares
 * `grid-agents: deep_researcher`, so none can even be invoked from chat. They
 * are how deep research analyses figures and writes its report. Listing five of
 * those in front of an org with two skills of its own made the page look mostly
 * like ours, and the only action they offered produced a frozen copy of an
 * instruction the org never wrote and would never maintain. They still resolve,
 * unchanged, for every run (`resolveSkillsForAgent`).
 *
 * What IS here is anything the platform curates for organizations
 * (`grid-catalog: curated`), carrying the org's own on/off decision. A curated
 * skill is an offer: it arrives switched off, and the org turns it on. That is
 * what replaces clone — no copy, no drift, and an improvement we ship reaches
 * every org that wants it.
 */
export async function listSkills(session: AuthorizedSession): Promise<{ skills: SkillListItem[] }> {
  assertSkillsFeatureOn(session)
  const [rows, activations, offers] = await Promise.all([
    repository.listSkillsInOrg(session.organizationId),
    repository.listCuratedSkillActivations(session.organizationId),
    curatedOffers(),
  ])
  const byName = new Map<string, SkillListItem>()
  for (const offer of offers) {
    byName.set(offer.name, platformToListItem(offer, isActivated(activations, offer.name)))
  }
  // An org row of the same name still shadows the offer, as it always has.
  for (const row of rows) {
    byName.set(row.name, orgToListItem(row))
  }
  return { skills: [...byName.values()] }
}

/**
 * Switch a platform-curated skill on or off for this organization.
 *
 * `org:skills:manage`, same as authoring: deciding what the agent may reach for
 * is the same authority as writing it.
 *
 * Addressed by NAME because a platform skill has no id — it is a file. Only a
 * CURATED name is addressable: the pipeline's machinery is not an offer, so
 * asking to switch it off is a 404 rather than a stored row that would quietly
 * break deep research. That check is here, in the service, and not only in the
 * UI that hides those skills.
 */
export async function setCuratedSkillEnabled(
  session: AuthorizedSession,
  name: string,
  enabled: boolean,
): Promise<{ skill: SkillListItem }> {
  assertSkillsFeatureOn(session)
  if (!canManageSkills(session)) throw new ForbiddenError('You need org skills management rights.')

  const offer = (await curatedOffers()).find((skill) => skill.name === name)
  if (!offer) throw new NotFoundError(`Unknown platform skill "${name}".`)

  await repository.upsertCuratedSkillActivation({
    organizationId: session.organizationId,
    skillName: offer.name,
    enabled,
    updatedBy: session.userId,
    updatedByEmail: session.email,
  })
  return { skill: platformToListItem(offer, enabled) }
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
  // Machinery FIRST, and for two reasons.
  //
  // Precedence: `resolveSkillsForAgent` merges machinery last, so it wins a
  // name collision there. Checking offers first here would have made the two
  // resolvers disagree — a curated row carrying a builtin name would 404 a
  // machinery skill that must always resolve. `assertNameIsFree` refuses such a
  // row today, so this is defence in depth; the two paths agreeing is the
  // point, because only one of them is exercised on the job-fire path.
  //
  // Cost: this lookup is in-memory. Reaching it AFTER `curatedOffers()` meant
  // every machinery snapshot paid a `platform_skills` query to learn nothing.
  const platform = findPlatformSkill(name)
  if (platform && !isCuratedPlatformSkill(platform.metadata)) {
    return {
      name: platform.name,
      description: platform.description,
      body: platform.body,
      metadata: {},
      origin: 'platform',
    }
  }

  // An OFFER resolves only for an org that switched it on, so a job cannot
  // newly attach one the org has not taken up. Jobs that attached it BEFORE it
  // was switched off keep running: they pinned a snapshot at save time and
  // never come back through here.
  const offer = (await curatedOffers()).find((skill) => skill.name === name)
  if (offer) {
    const activations = await repository.listCuratedSkillActivations(organizationId)
    if (!isActivated(activations, offer.name)) {
      throw new NotFoundError(`Unknown skill "${name}".`)
    }
    return {
      name: offer.name,
      description: offer.description,
      body: offer.body,
      metadata: { ...offer.metadata },
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
  const [rows, activations, offers] = await Promise.all([
    repository.listSkillsInOrg(organizationId),
    repository.listCuratedSkillActivations(organizationId),
    curatedOffers(),
  ])
  const byName = new Map<string, { name: string; description: string; body: string; metadata: Record<string, string>; origin: SkillOrigin | 'platform' }>()
  // The offers this org took up, then the machinery. Machinery LAST on purpose:
  // the catalogue already refuses a curated name that collides with a builtin
  // (`platform-service.ts::assertNameIsFree`), and this ordering means that
  // even if such a row somehow existed it could not replace how deep research
  // writes its report.
  const machinery = listPlatformSkills().filter((skill) => !isCuratedPlatformSkill(skill.metadata))
  const taken = offers.filter((offer) => isActivated(activations, offer.name))
  for (const platform of [...taken, ...machinery]) {
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
