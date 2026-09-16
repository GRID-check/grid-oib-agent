/**
 * Platform skills service — the fleet-wide curated catalogue (Platform → Skills).
 *
 * One row written here is offered to EVERY organization at once. That is the
 * point, and it is also why this module is separate from `./service`: that one
 * is org-scoped and gates on `org:skills:manage`, while nothing here is a
 * tenant's decision at all. Authorization is the platform-owner gate, which
 * `platformApiRoute` applies before the handler runs (ADR-0016/0038) — so these
 * functions take no session and make no authorization claim of their own.
 *
 * What an organization then does with an offer is the other half, and it lives
 * in `./service`: `listSkills` shows the published rows carrying that org's own
 * on/off state, and `setCuratedSkillEnabled` records the decision. Nothing here
 * can switch a skill on for somebody — publishing offers, it does not impose.
 */

import 'server-only'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import type { PlatformSkillDelivery, PlatformSkillRow } from '@/lib/db/schema'
import * as repository from './platform-repository'
import * as categoryRepository from './skill-category-repository'
import { findPlatformSkill } from './platform-skills'
import type {
  CreateCategoryInput,
  CreatePlatformSkillInput,
  PatchCategoryInput,
  PatchPlatformSkillInput,
  SkillCategoryListItem,
} from './types'

/** A curated skill as the platform dashboard sees it — drafts included. */
export type PlatformSkillListItem = {
  id: string
  name: string
  description: string
  body: string
  metadata: Record<string, string>
  published: boolean
  /** `offer`, and only `offer`: organizations choose it (migration 0088). */
  delivery: PlatformSkillDelivery
  /** The platform skill category this skill stands on, or null when unsorted. */
  categoryId: string | null
  createdAt: Date
  updatedAt: Date
}

function toListItem(row: PlatformSkillRow): PlatformSkillListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    metadata: { ...row.metadata },
    published: row.published,
    delivery: row.delivery,
    categoryId: row.categoryId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function toCategoryListItem(row: {
  id: string
  name: string
  description: string | null
  slug: string | null
  sortOrder: number
}): SkillCategoryListItem {
  return { id: row.id, name: row.name, description: row.description, slug: row.slug, sortOrder: row.sortOrder, scope: 'platform' }
}

/**
 * The platform skill category a catalogue write names, resolved or refused.
 *
 * Tenant categories are never addressable here — assigning the fleet's copy to an
 * org's category is a 404, the same shape as a category that never existed.
 */
async function assertPlatformSkillCategory(categoryId: string | null | undefined): Promise<string | null> {
  if (categoryId === undefined || categoryId === null) return null
  const category = await categoryRepository.findPlatformSkillCategory(categoryId)
  if (!category) throw new NotFoundError('Skill category not found.')
  return category.id
}

/**
 * A name is free if no curated skill has it AND no builtin does.
 *
 * The builtin half matters more than it looks. A curated skill sharing a name
 * with the pipeline's machinery would shadow that machinery in the backend
 * resolver for every org that switched the curated one on — silently replacing
 * how deep research writes its report with whatever was typed in the dashboard.
 * The catalogue is the wrong place to discover that, so the name is refused.
 */
async function assertNameIsFree(name: string, exceptId?: string): Promise<void> {
  if (findPlatformSkill(name)) {
    throw new ConflictError(`"${name}" is the name of a built-in skill.`)
  }
  const existing = await repository.findPlatformSkillRowByName(name)
  if (existing && existing.id !== exceptId) {
    throw new ConflictError(`A curated skill named "${name}" already exists.`)
  }
}

/** The whole catalogue, drafts included. Platform owner only (route-gated). */
export async function listPlatformSkills(): Promise<{ skills: PlatformSkillListItem[] }> {
  const rows = await repository.listPlatformSkillRows()
  return { skills: rows.map(toListItem) }
}

/**
 * Add a skill to the catalogue.
 *
 * Created as a DRAFT unless asked otherwise: the dashboard is a writing
 * surface, and a half-written instruction appearing in every organization's
 * Skills tab the moment it is saved would force every edit to be one perfect
 * commit.
 */
export async function createPlatformSkill(
  input: CreatePlatformSkillInput,
  author: { userId: string; email: string | null },
): Promise<{ skill: PlatformSkillListItem }> {
  await assertNameIsFree(input.name)
  const row = await repository.insertPlatformSkillRow({
    name: input.name,
    description: input.description,
    body: input.body,
    metadata: input.metadata ?? {},
    published: input.published ?? false,
    // The only value the column takes since 0088. Still written explicitly
    // rather than left to the column default, so the row a caller gets back is
    // the row this function decided on.
    delivery: input.delivery ?? 'offer',
    categoryId: await assertPlatformSkillCategory(input.categoryId),
    createdBy: author.userId,
    createdByEmail: author.email,
  })
  return { skill: toListItem(row) }
}

/**
 * Edit a curated skill — including publishing it and withdrawing it.
 *
 * An edit reaches every organization that runs the skill immediately and without
 * anyone re-taking it. That is the property the removed clone flow could not
 * have: a copy stops being ours the moment it is made.
 *
 * Nothing here can impose the skill on a tenant. `delivery` used to move a row
 * between `offer` and `standard`, and promoting one took the decision away from
 * every organization on the platform; migration 0088 retired that tier, so the
 * only reachable value is `offer` and an organization always decides. What the
 * platform wants applied to every turn goes in the platform prompt instead.
 */
export async function updatePlatformSkill(
  skillId: string,
  patch: PatchPlatformSkillInput,
): Promise<{ skill: PlatformSkillListItem }> {
  const existing = await repository.findPlatformSkillRow(skillId)
  if (!existing) throw new NotFoundError('Curated skill not found.')

  if (patch.name !== undefined && patch.name !== existing.name) {
    await assertNameIsFree(patch.name, skillId)
  }

  // A named category is resolved or refused; an explicit null removes it; an
  // omitted key leaves the skill where it stands.
  const { categoryId, ...rest } = patch
  const row = await repository.updatePlatformSkillRow(skillId, {
    ...rest,
    ...(categoryId !== undefined ? { categoryId: await assertPlatformSkillCategory(categoryId) } : {}),
    updatedAt: new Date(),
  })
  if (!row) throw new NotFoundError('Curated skill not found.')
  return { skill: toListItem(row) }
}

/**
 * Withdraw a curated skill from the fleet.
 *
 * Organizations that had it switched on stop resolving it. Their activation
 * rows are left alone: they are keyed by name and inert without a skill to
 * refer to, so re-creating the skill under the same name restores the fleet
 * exactly as it was rather than silently switching it on for nobody.
 */
export async function deletePlatformSkill(skillId: string): Promise<{ deleted: true }> {
  const deleted = await repository.deletePlatformSkillRow(skillId)
  if (!deleted) throw new NotFoundError('Curated skill not found.')
  return { deleted: true }
}

// ---------------------------------------------------------------------------
// Skill categories — the fleet catalogue's arrangement
// ---------------------------------------------------------------------------

/**
 * The platform's categories. Platform owner only (route-gated); these functions
 * take no session and make no authorization claim of their own, like every
 * other function in this module.
 */
export async function listPlatformSkillCategories(): Promise<{ categories: SkillCategoryListItem[] }> {
  const rows = await categoryRepository.listPlatformSkillCategories()
  return { categories: rows.map(toCategoryListItem) }
}

/** Add a platform skill category. Names are unique among platform skill categories. */
export async function createPlatformSkillCategory(
  input: CreateCategoryInput,
  author: { userId: string; email: string | null },
): Promise<{ category: SkillCategoryListItem }> {
  const existing = await categoryRepository.findPlatformSkillCategoryByName(input.name)
  if (existing) {
    throw new ConflictError(`A category named "${input.name}" already exists.`)
  }
  // Same cap as the org path: past the list limit, categories silently fall
  // off the catalogue read, so the overflowing create is refused instead.
  const visible = await categoryRepository.listPlatformSkillCategories(
    categoryRepository.CATEGORIES_LIST_LIMIT + 1,
  )
  // `>=` and not `>`: at exactly the limit the next insert is the one over it,
  // and the reads that render these are bounded at the same number.
  if (visible.length >= categoryRepository.CATEGORIES_LIST_LIMIT) {
    throw new ConflictError(
      `Category limit reached (${categoryRepository.CATEGORIES_LIST_LIMIT}). Remove an unused category before adding another.`
    )
  }
  const row = await categoryRepository.insertCategory({
    organizationId: null,
    name: input.name,
    description: input.description ?? null,
    sortOrder: input.sortOrder ?? 0,
    createdBy: author.userId,
    createdByEmail: author.email,
  })
  return { category: toCategoryListItem(row) }
}

/** Rename, re-describe or re-order a platform skill category. */
export async function updatePlatformSkillCategory(
  categoryId: string,
  patch: PatchCategoryInput,
): Promise<{ category: SkillCategoryListItem }> {
  const existing = await categoryRepository.findPlatformSkillCategory(categoryId)
  if (!existing) throw new NotFoundError('Skill category not found.')

  if (patch.name !== undefined && patch.name !== existing.name) {
    const other = await categoryRepository.findPlatformSkillCategoryByName(patch.name)
    if (other) {
      throw new ConflictError(`A category named "${patch.name}" already exists.`)
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
 * Remove a platform skill category. Skills standing on it fall back to unsorted (the
 * FK is ON DELETE SET NULL) — including the builtin file offers that resolved
 * to it by slug, which read as unsorted until categorized again.
 */
export async function deletePlatformSkillCategory(categoryId: string): Promise<{ deleted: true }> {
  const existing = await categoryRepository.findPlatformSkillCategory(categoryId)
  if (!existing) throw new NotFoundError('Skill category not found.')
  await categoryRepository.deleteCategory(categoryId)
  return { deleted: true }
}
