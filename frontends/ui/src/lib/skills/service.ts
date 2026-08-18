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

/** A skill the platform publishes to organizations, whichever tier it came from. */
type CuratedSkill = Pick<PlatformSkill, 'name' | 'description' | 'body' | 'metadata'>

/**
 * The live platform catalogue, split by who decides whether it runs.
 *
 * One read, two audiences. Both halves are wanted together on the hot path, and
 * the catalogue is capped at 200 rows, so partitioning here beats a second
 * query keyed on `delivery`.
 */
type LivePlatformSkills = {
  /** Published `delivery: 'offer'` rows, plus `grid-catalog: curated` files. */
  offers: CuratedSkill[]
  /** Published `delivery: 'standard'` rows. Nobody's decision but ours. */
  standard: CuratedSkill[]
}

function toCurated(row: {
  name: string
  description: string
  body: string
  metadata: Record<string, string>
}): CuratedSkill {
  return {
    name: row.name,
    description: row.description,
    body: row.body,
    metadata: { ...row.metadata },
  }
}

/**
 * Everything the platform publishes, from both tiers, partitioned by delivery.
 *
 * OFFERS — a capability an organization may take or leave:
 *   - published `delivery: 'offer'` rows of `platform_skills`, written in
 *     Platform → Skills. We author a skill there, every organization can switch
 *     it on, and the body stays ours.
 *   - builtin FILES that opt in with `grid-catalog: curated`. None ship today;
 *     the door exists so a builtin can become org-facing without becoming a
 *     database row first.
 *
 * STANDARD — the fleet's own equipment, and NOT an offer:
 *   - published `delivery: 'standard'` rows. Every organization runs them, none
 *     of them is asked, and none of them can see the skill on its Skills tab or
 *     switch it off. It is the file tier's "machinery" property made available
 *     to the dashboard, so fleet policy stops requiring a deploy.
 *
 * Everything else under `builtin/` is the deep-research pipeline's machinery and
 * is likewise nobody's decision. Machinery is the DEFAULT there, so a builtin
 * becomes org-facing only by saying so (see METADATA_CATALOG).
 *
 * A standard row named after a BUILTIN is dropped here, and that is the second
 * half of a guard whose first half cannot cover it.
 * `platform-service.ts::assertNameIsFree` refuses a row named after an existing
 * builtin, at create and at rename — but it only guards the row direction. The
 * other direction is a deploy: shipping a new `SKILL.md` whose name matches a
 * standard row somebody published months ago. No write boundary can see that
 * coming, and the consequence would be severe, because standard is merged after
 * the org's rows and therefore after the machinery: a dashboard row would
 * silently replace how deep research writes its report for every tenant at once,
 * and `resolveSkillSnapshot` would 404 the machinery a job needs to attach.
 *
 * So the collision is made INERT rather than destructive, and it is made inert
 * at READ time, where both resolvers see the same answer. Machinery wins; the
 * standard row simply does not exist while a builtin owns its name, and starts
 * working again if that builtin is ever removed. Dropping it against
 * `findPlatformSkill` — every builtin, not just the machinery — closes the
 * curated-file case in the same line: a `grid-catalog: curated` FILE and a
 * standard ROW sharing a name would otherwise put that name in BOTH halves,
 * which is exactly the state where a standard skill appears on the Skills tab
 * with a working switch.
 */
async function livePlatformSkills(): Promise<LivePlatformSkills> {
  const [offerRows, standardRows] = await Promise.all([
    platformRepository.listPublishedOfferRows(),
    platformRepository.listPublishedStandardRows(),
  ])
  const offers = new Map<string, CuratedSkill>()
  for (const file of listPlatformSkills()) {
    if (isCuratedPlatformSkill(file.metadata)) offers.set(file.name, file)
  }
  for (const row of offerRows) offers.set(row.name, toCurated(row))

  const standard = new Map<string, CuratedSkill>()
  for (const row of standardRows) {
    if (findPlatformSkill(row.name)) continue
    standard.set(row.name, toCurated(row))
  }
  return { offers: [...offers.values()], standard: [...standard.values()] }
}

/** Just the half an organization gets to decide about. */
async function curatedOffers(): Promise<CuratedSkill[]> {
  return (await livePlatformSkills()).offers
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
 * What IS here is anything the platform OFFERS organizations, carrying the org's
 * own on/off decision. An offer arrives switched off, and the org turns it on.
 * That is what replaces clone — no copy, no drift, and an improvement we ship
 * reaches every org that wants it.
 *
 * The platform's STANDARD skills are not here either, and that is the point of
 * them. They resolve for every organization on every run
 * (`resolveSkillsForAgent`), but they are not a tenant's decision, so putting
 * them on a page whose every row carries a switch would be showing somebody a
 * control they do not have. They are the platform's own instruction, and the
 * platform is where they are read, written and withdrawn.
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
 * Addressed by NAME because a platform skill has no id — it is a file. Only an
 * OFFER is addressable: the pipeline's machinery is not an offer, so asking to
 * switch it off is a 404 rather than a stored row that would quietly break deep
 * research, and the platform's STANDARD skills are refused by the same line for
 * the same reason. `curatedOffers()` holds neither, so both are unreachable here
 * by construction rather than by a second check somebody has to remember.
 *
 * That is what makes "non-targetable" true rather than merely rendered. The org
 * UI never draws a switch for a standard skill, but the UI is not the boundary:
 * this is, and a hand-crafted PATCH naming one gets a 404.
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
 *
 * The platform's STANDARD skills are excluded too (`resolveSelectableSkills`).
 * They resolve for this org and the model has them in its catalogue, but the
 * organization does not administer them, so putting one in a `/` menu would be
 * handing somebody a name they cannot look up, edit or switch off. Note the
 * consequence: this list is also what `SkillsUsedDisclosure` reads for
 * descriptions, so if a standard skill is activated the disclosure names it with
 * no description rather than hiding it. That is deliberate — the disclosure
 * reports what shaped the answer, and a product built on traceable sourcing must
 * not have a class of instruction it declines to admit ran.
 */
export async function listInvocableSkills(
  session: AuthorizedSession,
): Promise<{ skills: InvocableSkill[] }> {
  assertSkillsFeatureOn(session)
  const { skills } = await resolveSelectableSkills(session.organizationId, CHAT_SKILL_AGENT)
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
/**
 * Refuse a name the platform has standardised fleet-wide.
 *
 * The narrow exception to "an org row shadows a platform skill of the same
 * name". That rule is right for machinery and for offers — the tenant's version
 * wins, ADR-0022's ordering — and wrong for a standard skill, which is platform
 * policy the org is not administering. So the resolver merges standard LAST and
 * the org row would never run. Accepting the save and silently ignoring the
 * result is the failure mode this codebase exists to avoid: the author would get
 * a skill in their toolbox, a green save, and an agent that never once follows
 * it, with nothing anywhere saying why.
 *
 * The message names no more than the collision. It does not say the skill is a
 * platform one, what it does, or that it exists — an org that cannot see a
 * standard skill should not learn its purpose from an error. The name itself is
 * unavoidable: it is the thing the author just typed.
 *
 * Only PUBLISHED standard skills reserve a name. A draft imposes nothing, so it
 * has no business taking a word out of a tenant's vocabulary.
 */
async function assertNameNotStandardised(name: string): Promise<void> {
  const standard = await platformRepository.findStandardPlatformSkillRowByName(name)
  if (standard) {
    throw new ConflictError(`The name "${name}" is reserved. Please choose another.`)
  }
}

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
  await assertNameNotStandardised(input.name)

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

  // The row's CURRENT name, checked on every edit and not only on a rename.
  //
  // A row that predates the standard skill wearing its name is inert: the
  // resolver deletes that name before merging the platform's version, so nothing
  // typed here will ever reach an agent. Letting the edit succeed is the exact
  // "green save, and an agent that never once follows it" failure the create
  // boundary exists to prevent — the same trap, reached by editing a row that
  // was already there instead of by authoring a new one.
  //
  // Refused rather than hidden: the row stays on the Skills tab and `deleteSkill`
  // still works, so the author can see what they have and remove it. Hiding it
  // would leave an invisible row nobody can delete.
  await assertNameNotStandardised(existing.name)

  if (patch.name !== undefined && patch.name !== existing.name) {
    const other = await repository.findSkillByName(patch.name, session.organizationId)
    if (other) throw new ConflictError(`A skill named "${patch.name}" already exists in this organization.`)
    await assertNameNotStandardised(patch.name)
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

/**
 * Org row first, builtin platform fallback; unknown names 404.
 *
 * A name the platform has STANDARDISED is not resolvable at all, and the check
 * comes before every other lookup rather than after. Two things would go wrong
 * otherwise, and they are different bugs:
 *
 *   - The standard skill itself would have to be found somewhere to be attached,
 *     and it must not be: it is not in the org's vocabulary, so a job that named
 *     it would be a job built on a skill nobody in that org can see or edit.
 *   - A legacy ORG row wearing the same name would be found FIRST and snapshot
 *     ITS body — which the run would then never follow, because `resolveAll`
 *     merges standard last. A job would be pinned to instructions the agent has
 *     already been told to ignore.
 */
export async function resolveSkillSnapshot(
  name: string,
  organizationId: string,
): Promise<SkillSnapshot> {
  // Guarded on the builtin lookup, which is in-memory, for both correctness and
  // cost. Correctness: `livePlatformSkills` drops a standard row whose name a
  // builtin owns, so asking the catalogue here would 404 a machinery skill that
  // the run itself still resolves — the two resolvers have to agree, and only
  // this one runs when a job pins its snapshot. Cost: a machinery name never
  // pays a `platform_skills` query to learn nothing.
  if (!findPlatformSkill(name) && (await platformRepository.findStandardPlatformSkillRowByName(name))) {
    throw new NotFoundError(`Unknown skill "${name}".`)
  }
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

/** One entry of the resolved set — the shape the internal resolve route serves. */
export type ResolvedSkill = {
  name: string
  description: string
  body: string
  metadata: Record<string, string>
  origin: SkillOrigin | 'platform'
  /**
   * Fleet standard equipment — a published `delivery: standard` platform row.
   *
   * On the wire because only the BFF can see `platform_skills`, and the backend
   * needs the distinction to APPLY the skill rather than merely offer it: a
   * standard skill is forced for the run, so its body is loaded instead of
   * sitting in the catalog as a one-line description the model may never open.
   * Without this the tier resolved everywhere and bound nowhere.
   *
   * Not derivable from `origin`, which is also `'platform'` for the machinery
   * and for offers an org took up — neither of which imposes anything.
   */
  standard?: boolean
}

/**
 * The full resolution, with the platform's standard names kept to one side.
 *
 * Private, because those two facts answer different questions and only one of
 * them belongs on the wire. `resolveSkillsForAgent` is what a RUN gets — every
 * skill, standard included, because that is the set the agent may actually load.
 * `resolveSelectableSkills` is what a PERSON gets — the same set minus the
 * standard skills, because those are not theirs to pick, attach or see.
 */
async function resolveAll(
  organizationId: string,
  agent?: string,
): Promise<{ skills: ResolvedSkill[]; standardNames: Set<string> }> {
  const [rows, activations, live] = await Promise.all([
    repository.listSkillsInOrg(organizationId),
    repository.listCuratedSkillActivations(organizationId),
    livePlatformSkills(),
  ])
  const byName = new Map<string, ResolvedSkill>()
  const put = (skill: CuratedSkill, origin: SkillOrigin | 'platform', standard = false) => {
    // Platform metadata rides along VERBATIM. Sending `{}` here dropped the
    // reserved `grid-*` keys, and because the backend resolver merges this
    // payload OVER its own filesystem copy, the shipped
    // `grid-execution: deep-research` targeting was erased on arrival — the
    // chat agent was then offered writer/sandbox skills it cannot execute.
    if (agent && !skillTargetsAgent(skill.metadata, agent)) return
    byName.set(skill.name, {
      name: skill.name,
      description: skill.description,
      body: skill.body,
      metadata: { ...skill.metadata },
      origin,
      ...(standard ? { standard: true } : {}),
    })
  }

  // The offers this org took up, then the machinery. Machinery before the org's
  // own rows but after the offers, so an offer can never replace how deep
  // research writes its report.
  //
  // Note this ordering does NOT protect machinery from a standard skill, which
  // is merged after the org's rows and so after this. Nothing here could: org
  // rows deliberately shadow machinery (ADR-0022's "explicit org value beats
  // deployment default"), and standard has to outrank org rows, so standard
  // necessarily outranks machinery too. That collision is prevented by name
  // instead — `livePlatformSkills` drops any standard row a builtin has named.
  const machinery = listPlatformSkills().filter((skill) => !isCuratedPlatformSkill(skill.metadata))
  const taken = live.offers.filter((offer) => isActivated(activations, offer.name))
  for (const platform of [...taken, ...machinery]) put(platform, 'platform')

  // The org's own rows, which still shadow a builtin of the same name — the
  // tenant's version wins, mirroring BYOK's "explicit org value beats deployment
  // default" ordering (ADR-0022).
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

  // STANDARD LAST, and this is the one place the ordering is load-bearing rather
  // than defensive. A standard skill is the platform's own instruction, imposed
  // on the fleet and policed here; an org row that could shadow it would be a
  // tenant editing platform policy by picking a name. `createSkill` refuses the
  // name at the write boundary, so in practice nothing reaches this line — but
  // the boundary only covers rows authored AFTER the standard skill was
  // published, and this covers the ones that were already there.
  //
  // The rule is stated as a DELETE followed by a put, not as a put alone,
  // because `grid-agents` still applies to standard skills and `put` returns
  // early when it filters one out. Overwriting only would then leave a legacy
  // org row standing on exactly the agents the platform's own instruction does
  // not target — a tenant holding a standardised name on the chat agent because
  // the platform scoped its version to deep research. A standardised name
  // resolves to the platform's skill or to nothing; it never resolves to a
  // tenant's.
  //
  // (The `grid-agents` gate itself is untouched: it answers which agent CAN run
  // a skill, which is a different question from who decides that it runs. A
  // standard skill written for deep research is still not handed to a chat turn.)
  for (const platform of live.standard) {
    byName.delete(platform.name)
    put(platform, 'platform', true)
  }

  return { skills: [...byName.values()], standardNames: new Set(live.standard.map((s) => s.name)) }
}

/**
 * The resolved skill set for a RUN: platform builtins and the fleet's standard
 * skills merged with the org's enabled rows and the offers it took up, filtered
 * by `grid-agents` when an agent is named (absent = all agents). No session —
 * the internal resolve route serves the backend's /v1/chat/skills.
 */
export async function resolveSkillsForAgent(
  organizationId: string,
  agent?: string,
): Promise<{ skills: ResolvedSkill[] }> {
  const { skills } = await resolveAll(organizationId, agent)
  return { skills }
}

/**
 * The resolved set a PERSON in this organization may act on.
 *
 * Everything `resolveSkillsForAgent` returns, minus the platform's standard
 * skills. They run for this org — they are in the agent's catalogue on every
 * turn — but they are not the org's to invoke by name or to attach to a job, and
 * listing them in a picker would be offering a handle on something the org
 * cannot see, cannot edit and cannot switch off.
 *
 * Filtering by NAME rather than by origin is deliberate: `origin: 'platform'`
 * is also carried by the machinery and by offers the org took up, and both of
 * those are legitimately pickable.
 */
export async function resolveSelectableSkills(
  organizationId: string,
  agent?: string,
): Promise<{ skills: ResolvedSkill[] }> {
  const { skills, standardNames } = await resolveAll(organizationId, agent)
  return { skills: skills.filter((skill) => !standardNames.has(skill.name)) }
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
