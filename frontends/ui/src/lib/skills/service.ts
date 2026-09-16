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
import type { SkillCategoryRow } from '@/lib/db/schema'
import * as repository from './repository'
import * as categoryRepository from './skill-category-repository'
import * as platformRepository from './platform-repository'
import {
  CHAT_SKILL_AGENT,
  KNOWN_SKILL_AGENTS,
  METADATA_AGENTS,
  canonicalSkillAgent,
  isCuratedPlatformSkill,
  type CreateCategoryInput,
  type CreateSkillInput,
  type PatchCategoryInput,
  type PatchSkillInput,
  type SkillCategoryListItem,
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
  /** The category this skill stands on, or null when unsorted. */
  categoryId: string | null
  createdAt: Date | null
  updatedAt: Date | null
}

/** A skill the platform publishes to organizations, whichever tier it came from. */
type CuratedSkill = Pick<PlatformSkill, 'name' | 'description' | 'body' | 'metadata'> & {
  /** A dashboard row's stored category; null for rows and as the file default. */
  categoryId: string | null
  /** Builtin collection for file offers — resolved to a category by name. */
  collection?: string
}

/**
 * The live platform catalogue: everything published TO organizations.
 *
 * One audience since migration 0088 retired the `standard` tier, which was the
 * half nobody decided about. What the platform wants applied to every turn is a
 * standing instruction now — the platform prompt — and a skill is a capability
 * the model may reach for.
 */
type LivePlatformSkills = {
  /** Published `delivery: 'offer'` rows, plus `grid-catalog: curated` files. */
  offers: CuratedSkill[]
}

function toCurated(row: {
  name: string
  description: string
  body: string
  metadata: Record<string, string>
  categoryId?: string | null
}): CuratedSkill {
  return {
    name: row.name,
    description: row.description,
    body: row.body,
    metadata: { ...row.metadata },
    categoryId: row.categoryId ?? null,
  }
}

/**
 * Everything the platform publishes to organizations — a capability an
 * organization may take or leave:
 *
 *   - published `delivery: 'offer'` rows of `platform_skills`, written in
 *     Platform → Skills. We author a skill there, every organization can switch
 *     it on, and the body stays ours.
 *   - builtin FILES that opt in with `grid-catalog: curated`. The architect
 *     job playbooks (`einreichcheck`, `bestand`) ship this way: listed on the
 *     Skills tab, on until the org turns them off. A dashboard offer still
 *     starts off.
 *
 * Everything else under `builtin/` is the deep-research pipeline's machinery
 * and is nobody's decision. Machinery is the DEFAULT there, so a builtin
 * becomes org-facing only by saying so (see METADATA_CATALOG).
 *
 * There is no third category. `delivery: 'standard'` — published rows every
 * organization ran, unlisted and unswitchable, FORCED onto each run — was
 * retired by migration 0088 along with the composer's `skills` array, because
 * an instruction that always applies is not a capability and should not be
 * shaped like one. The two homes for those are the platform prompt and
 * `organization_instructions`.
 */
async function livePlatformSkills(): Promise<LivePlatformSkills> {
  const offerRows = await platformRepository.listPublishedOfferRows()
  const offers = new Map<string, CuratedSkill>()
  for (const file of listPlatformSkills()) {
    if (isCuratedPlatformSkill(file.metadata))
      offers.set(file.name, { ...toCurated(file), collection: file.collection })
  }
  // A dashboard row never replaces a shipped FILE of the same name. The write
  // boundary refuses that create, but the other direction is a deploy: a new
  // SKILL.md matching a row published months ago. The file is product code;
  // the row is dashboard copy. Product wins, same as an offer vs machinery.
  for (const row of offerRows) {
    if (findPlatformSkill(row.name)) continue
    offers.set(row.name, toCurated(row))
  }
  return { offers: [...offers.values()] }
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
 * offer by NAME instead. `enabled` is the org's own decision. File playbooks
 * a chat turn can run start on; dashboard offers start off.
 */
function platformToListItem(
  platform: CuratedSkill,
  enabled: boolean,
  categoryId: string | null,
): SkillListItem {
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
    categoryId,
    createdAt: null,
    updatedAt: null,
  }
}

/**
 * Whether a curated skill is switched on for an org.
 *
 * A stored row is the decision. No row is the default, and the default
 * depends on what the offer IS:
 *
 *   - a builtin FILE that a chat turn can run starts ON. Those are reviewed
 *     playbooks we ship; leaving them off until someone finds the Skills tab
 *     means they never run.
 *   - a dashboard offer, or a file aimed only at deep research, starts OFF.
 */
function fileOfferDefaultsOn(name: string): boolean {
  const file = findPlatformSkill(name)
  if (!file || !isCuratedPlatformSkill(file.metadata)) return false
  return skillTargetsAgent(file.metadata, CHAT_SKILL_AGENT)
}

function isActivated(
  activations: { skillName: string; enabled: boolean }[],
  name: string,
): boolean {
  const row = activations.find((activation) => activation.skillName === name)
  if (row) return row.enabled
  return fileOfferDefaultsOn(name)
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
    categoryId: skill.categoryId,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
  }
}

function toCategoryListItem(row: SkillCategoryRow): SkillCategoryListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    slug: row.slug,
    sortOrder: row.sortOrder,
    scope: row.organizationId === null ? 'platform' : 'org',
  }
}

/**
 * The category a builtin file offer stands on.
 *
 * Files have no row to store a category on — their category is derived, by matching
 * the builtin collection against the platform categories' slugs. The match runs
 * on the slug and never the display name, so a name the owner renames can
 * never detach them.
 */
function fileOfferCategoryId(
  collection: string | undefined,
  platformCategories: SkillCategoryListItem[],
): string | null {
  if (!collection) return null
  const folded = collection.trim().toLowerCase()
  return (
    platformCategories.find(
      (category) => category.slug !== null && category.slug.toLowerCase() === folded,
    )?.id ?? null
  )
}

/**
 * What this organization has: its own skills, plus the platform skills offered
 * to it. Any member may read.
 *
 * The pipeline's MACHINERY is deliberately not here, though it used to be —
 * every builtin was merged in as an equal row, each with a "clone" button.
 * Nobody installs one, nobody can edit one, and none of them is an
 * organization's decision. Genre methods (Brandschutz, Gebäudeklasse) still
 * resolve for every chat turn; they are not listed because they load on their
 * own. Listing them in front of an org with two skills of its own made the
 * page look mostly like ours, and the only action they offered produced a
 * frozen copy of an instruction the org never wrote and would never maintain.
 *
 * What IS here is anything the platform OFFERS organizations, carrying the org's
 * own on/off decision. A chat-usable FILE offer starts on; a dashboard offer
 * or a deep-research-only file starts off. That is what replaces clone — no
 * copy, no drift, and an improvement we ship reaches every org that wants it.
 *
 * The platform's STANDARD skills are not here either, and that is the point of
 * them. They resolve for every organization on every run
 * (`resolveSkillsForAgent`), but they are not a tenant's decision, so putting
 * them on a page whose every row carries a switch would be showing somebody a
 * control they do not have. They are the platform's own instruction, and the
 * platform is where they are read, written and withdrawn.
 */
export async function listSkills(
  session: AuthorizedSession,
): Promise<{ skills: SkillListItem[]; categories: SkillCategoryListItem[] }> {
  assertSkillsFeatureOn(session)
  const [rows, activations, offers, categoryRows] = await Promise.all([
    repository.listSkillsInOrg(session.organizationId),
    repository.listCuratedSkillActivations(session.organizationId),
    curatedOffers(),
    categoryRepository.listCategoriesForOrg(session.organizationId),
  ])
  const categories = categoryRows.map(toCategoryListItem)
  const platformCategories = categories.filter((category) => category.scope === 'platform')
  const byName = new Map<string, SkillListItem>()
  for (const offer of offers) {
    // A dashboard row carries its stored category; a builtin file resolves its
    // collection against the live platform categories by slug.
    const categoryId =
      offer.categoryId ?? fileOfferCategoryId(offer.collection, platformCategories)
    byName.set(offer.name, platformToListItem(offer, isActivated(activations, offer.name), categoryId))
  }
  // An org row of the same name still shadows the offer, as it always has.
  for (const row of rows) {
    byName.set(row.name, orgToListItem(row))
  }
  return { skills: [...byName.values()], categories }
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
 * research. `curatedOffers()` does not hold it, so it is unreachable here by
 * construction rather than by a second check somebody has to remember.
 *
 * That is what makes "non-targetable" true rather than merely rendered. The org
 * UI never draws a switch for machinery, but the UI is not the boundary: this
 * is, and a hand-crafted PATCH naming one gets a 404.
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
  // The switch answers with the offer as listed — same category the toolbox shows.
  const platformCategories = (
    await categoryRepository.listCategoriesForOrg(session.organizationId)
  )
    .map(toCategoryListItem)
    .filter((category) => category.scope === 'platform')
  const categoryId = offer.categoryId ?? fileOfferCategoryId(offer.collection, platformCategories)
  return { skill: platformToListItem(offer, enabled, categoryId) }
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
 * Filtered to what can actually run in a chat turn (`researcher`), so
 * the menu can never offer a deep-research skill the turn cannot execute.
 * Disabled skills are excluded. Any org member may list — invoking a skill is
 * using the product, not administering it; authoring stays `org:skills:manage`.
 *
 * The pipeline MACHINERY is excluded (`resolveSelectableSkills`). It resolves
 * for this org and the model has it in its catalogue, but it is not something a
 * person picks: it loads on its own. Putting it in a `/` menu would hand
 * somebody a name they cannot look up, edit or switch off. Note the
 * consequence: this list is also what `SkillsUsedDisclosure` reads for
 * descriptions, so if a machinery skill is activated the disclosure names it
 * with no description rather than hiding it. That is deliberate — the
 * disclosure reports what shaped the answer, and a product built on traceable
 * sourcing must not have a class of instruction it declines to admit ran.
 *
 * Picking from this menu writes `/name ` into the composer and does nothing
 * else: the name travels as TEXT and the model chooses the skill out of the
 * same catalogue it always reads. Nothing here forces a skill onto a turn any
 * more (migration 0088).
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
/*
 * The org write boundary used to refuse a name the platform had STANDARDISED
 * fleet-wide (`assertNameNotStandardised`). That guard existed because a
 * standard skill outranked an org row of the same name, so authoring one
 * produced a green save and an agent that never once followed it.
 *
 * Migration 0088 removed the tier, and with it the collision. Every platform
 * skill is an offer now, and an org row deliberately SHADOWS an offer of the
 * same name — the tenant's version wins, ADR-0022's "explicit org value beats
 * deployment default". So there is nothing left to refuse: a row named
 * `piloti-voice` is the organization's own skill and it is the one that runs.
 */

/**
 * The category a skill write names, resolved or refused.
 *
 * An org skill may stand on the org's own category or a platform one; anything
 * else — another org's category, or nothing at all — is a 404 either way, so a
 * caller cannot probe which categories exist outside its scope. Undefined means
 * "don't touch" and passes through as null only where the column wants it.
 */
async function assertCategoryInScope(
  organizationId: string,
  categoryId: string | null | undefined,
): Promise<string | null> {
  if (categoryId === undefined || categoryId === null) return null
  const category = await categoryRepository.findCategoryInScope(categoryId, organizationId)
  if (!category) throw new NotFoundError('Skill category not found.')
  return category.id
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
  const categoryId = await assertCategoryInScope(session.organizationId, input.categoryId)

  const skill = await repository.insertSkill({
    organizationId: session.organizationId,
    name: input.name,
    description: input.description,
    body: input.body,
    metadata: input.metadata ?? {},
    origin: input.clonedFrom ? 'platform-clone' : 'org',
    clonedFrom: input.clonedFrom ?? null,
    categoryId,
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

  // A named category is resolved or refused; an explicit null removes it; an
  // omitted key leaves the skill where it stands. Spread directly it would do
  // the same, but only by accident of what drizzle ignores — said aloud here.
  const { categoryId, ...rest } = patch
  const skill = await repository.updateSkill(skillId, session.organizationId, {
    ...rest,
    ...(categoryId !== undefined
      ? { categoryId: await assertCategoryInScope(session.organizationId, categoryId) }
      : {}),
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
// Skill categories — the org's own arrangement
// ---------------------------------------------------------------------------

/**
 * Every category this organization sees: the platform's, then its own.
 *
 * Any member may read — arranging is administration, looking at the categories
 * is using the product.
 */
export async function listSkillCategories(
  session: AuthorizedSession,
): Promise<{ categories: SkillCategoryListItem[] }> {
  assertSkillsFeatureOn(session)
  const rows = await categoryRepository.listCategoriesForOrg(session.organizationId)
  return { categories: rows.map(toCategoryListItem) }
}

/**
 * Add a category to this organization. `org:skills:manage` required.
 *
 * Names are unique within the org (the partial index is the backstop; the
 * pre-check turns it into a 409 with a message rather than a 500). The count
 * is capped at the list limit: past it, categories would silently fall off the
 * toolbox read, so the overflowing create is refused instead.
 */
export async function createSkillCategory(
  session: AuthorizedSession,
  input: CreateCategoryInput,
): Promise<{ category: SkillCategoryListItem }> {
  assertSkillsFeatureOn(session)
  if (!canManageSkills(session)) throw new ForbiddenError('You need org skills management rights.')

  const existing = await categoryRepository.findOrgCategoryByName(input.name, session.organizationId)
  if (existing) {
    throw new ConflictError(`A category named "${input.name}" already exists in this organization.`)
  }
  const visible = await categoryRepository.listCategoriesForOrg(
    session.organizationId,
    categoryRepository.CATEGORIES_LIST_LIMIT + 1,
  )
  if (visible.length > categoryRepository.CATEGORIES_LIST_LIMIT) {
    throw new ConflictError(
      `Category limit reached (${categoryRepository.CATEGORIES_LIST_LIMIT}). Remove an unused category before adding another.`
    )
  }
  const row = await categoryRepository.insertCategory(
    categoryRepository.orgCategoryValues(session.organizationId, {
      name: input.name,
      description: input.description ?? null,
      sortOrder: input.sortOrder ?? 0,
      createdBy: session.userId,
      createdByEmail: session.email,
    }),
  )
  return { category: toCategoryListItem(row) }
}

/**
 * Rename, re-describe or re-order an org category. Platform categories are never
 * addressable here — renaming the fleet's category from a tenant is a 404, the
 * same shape as a category that never existed.
 */
export async function updateSkillCategory(
  session: AuthorizedSession,
  categoryId: string,
  patch: PatchCategoryInput,
): Promise<{ category: SkillCategoryListItem }> {
  assertSkillsFeatureOn(session)
  if (!canManageSkills(session)) throw new ForbiddenError('You need org skills management rights.')

  const existing = await categoryRepository.findOrgCategory(categoryId, session.organizationId)
  if (!existing) throw new NotFoundError('Skill category not found.')

  if (patch.name !== undefined && patch.name !== existing.name) {
    const other = await categoryRepository.findOrgCategoryByName(patch.name, session.organizationId)
    if (other) {
      throw new ConflictError(`A category named "${patch.name}" already exists in this organization.`)
    }
  }
  const row = await categoryRepository.updateCategory(categoryId, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    updatedAt: new Date(),
  })
  if (!row) throw new NotFoundError('Skill category not found.')
  return { category: toCategoryListItem(row) }
}

/**
 * Remove an org category. Skills standing on it are NOT removed — the FK is
 * ON DELETE SET NULL, so they fall back to unsorted.
 */
export async function deleteSkillCategory(
  session: AuthorizedSession,
  categoryId: string,
): Promise<{ deleted: true }> {
  assertSkillsFeatureOn(session)
  if (!canManageSkills(session)) throw new ForbiddenError('You need org skills management rights.')

  const existing = await categoryRepository.findOrgCategory(categoryId, session.organizationId)
  if (!existing) throw new NotFoundError('Skill category not found.')
  await categoryRepository.deleteCategory(categoryId)
  return { deleted: true }
}

// ---------------------------------------------------------------------------
// Snapshot resolution (what a job pins when it attaches a skill)
// ---------------------------------------------------------------------------

/**
 * Org row first, builtin platform fallback; unknown names 404.
 *
 * There used to be a guard ahead of all of it: a name the platform had
 * STANDARDISED was not resolvable at all, because `resolveAll` merged the
 * standard row last and a job pinned to the org's body would have been pinned
 * to instructions the agent was told to ignore. Migration 0088 removed the
 * tier, so the two resolvers agree again on the ordinary rule — the org's own
 * row wins, and every platform skill is an offer.
 */
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

/** One entry of the resolved set — the shape the internal resolve route serves. */
export type ResolvedSkill = {
  name: string
  description: string
  body: string
  metadata: Record<string, string>
  origin: SkillOrigin | 'platform'
  // There is deliberately no `standard` flag. It marked a published
  // `delivery: 'standard'` row so the backend would FORCE the skill for the
  // run rather than leave it in the catalog for the model to choose; migration
  // 0088 retired the tier, and the backend no longer reads the key. Every skill
  // in this set is one the model may reach for.
}

/**
 * The full resolution.
 *
 * Private, because the two callers want different subsets of it.
 * `resolveSkillsForAgent` is what a RUN gets — every skill, because that is the
 * set the agent may load. `resolveSelectableSkills` is what a PERSON gets — the
 * same set minus the pipeline machinery, which is not theirs to pick, attach or
 * see.
 */
async function resolveAll(
  organizationId: string,
  agent?: string,
): Promise<{ skills: ResolvedSkill[] }> {
  const [rows, activations, live] = await Promise.all([
    repository.listSkillsInOrg(organizationId),
    repository.listCuratedSkillActivations(organizationId),
    livePlatformSkills(),
  ])
  const byName = new Map<string, ResolvedSkill>()
  const put = (skill: CuratedSkill, origin: SkillOrigin | 'platform') => {
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
    })
  }

  // The offers this org took up, then the machinery. Machinery before the org's
  // own rows but after the offers, so an offer can never replace how deep
  // research writes its report. Nothing is merged after the org's rows any
  // more: the one thing that used to be (a `delivery: 'standard'` row, which
  // had to outrank them) is gone with the tier.
  //
  // Machinery is uncategorized BY CONSTRUCTION: a category is something a
  // person files a curated offer under, and this is the pipeline's own
  // instructions — nobody browses it. `toCurated` is what states that, by
  // defaulting `categoryId` to null, rather than the union being widened to
  // let a file skill through without one.
  const machinery = listPlatformSkills()
    .filter((skill) => !isCuratedPlatformSkill(skill.metadata))
    .map(toCurated)
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

  return { skills: [...byName.values()] }
}

/**
 * The resolved skill set for a RUN: the platform builtins merged with the org's
 * enabled rows and the offers it took up, filtered by `grid-agents` when an
 * agent is named (absent = all agents). No session — the internal resolve route
 * serves the backend's /v1/chat/skills.
 *
 * Every entry is a skill the model MAY load, never one it must: nothing in this
 * payload forces a skill onto the run since migration 0088 retired the
 * `standard` tier.
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
 * Everything `resolveSkillsForAgent` returns, minus the pipeline machinery.
 * That runs for this org — it is in the agent's catalogue — but it is not the
 * org's to invoke by name or to attach to a job. Listing it in a picker would
 * offer a handle on something the org cannot see, cannot edit and cannot switch
 * off.
 *
 * Offers the org took up stay. An org row that shadows machinery stays too:
 * that copy is theirs. The file itself is not.
 */
function isBuiltinMachinery(name: string): boolean {
  const file = findPlatformSkill(name)
  return Boolean(file && !isCuratedPlatformSkill(file.metadata))
}

export async function resolveSelectableSkills(
  organizationId: string,
  agent?: string,
): Promise<{ skills: ResolvedSkill[] }> {
  const { skills } = await resolveAll(organizationId, agent)
  return {
    skills: skills.filter(
      // An org row that shadows machinery is still theirs to pick. The file
      // itself is not: it is always on, and it has no switch.
      (skill) => skill.origin !== 'platform' || !isBuiltinMachinery(skill.name),
    ),
  }
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
 * `platform-skills.spec.ts` pins that they all still do. Machinery is kept out
 * of the `/` menu separately; `grid-agents` is what keeps a deep-only *offer*
 * out of chat.
 *
 * Kept deliberately close to the Python in shape as well as behaviour: the two
 * are a contract pair, and `service.spec.ts` pins them against the same cases.
 */
function skillTargetsAgent(metadata: Record<string, string>, agent: string): boolean {
  const raw = metadata[METADATA_AGENTS]
  if (!raw) return true
  const listed = raw
    .split(',')
    .map((part) => canonicalSkillAgent(part.trim()))
    .filter((part) => part.length > 0)
  const known = listed.filter((name) => (KNOWN_SKILL_AGENTS as readonly string[]).includes(name))
  // The caller's name is canonicalised too: a backend still on the pre-rename
  // build asks for `shallow_researcher`, and normalising only the stored side
  // would drop every skill from that caller for the length of a rolling deploy.
  return known.length === 0 || known.includes(canonicalSkillAgent(agent))
}
