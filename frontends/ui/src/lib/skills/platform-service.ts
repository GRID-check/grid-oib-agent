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
import type { PlatformSkillRow } from '@/lib/db/schema'
import * as repository from './platform-repository'
import { findPlatformSkill } from './platform-skills'
import type { CreatePlatformSkillInput, PatchPlatformSkillInput } from './types'

/** A curated skill as the platform dashboard sees it — drafts included. */
export type PlatformSkillListItem = {
  id: string
  name: string
  description: string
  body: string
  metadata: Record<string, string>
  published: boolean
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
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
    createdBy: author.userId,
    createdByEmail: author.email,
  })
  return { skill: toListItem(row) }
}

/**
 * Edit a curated skill — including publishing and withdrawing it.
 *
 * An edit reaches every organization that switched the skill on, immediately
 * and without anyone re-taking it. That is the property the removed clone flow
 * could not have: a copy stops being ours the moment it is made.
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

  const row = await repository.updatePlatformSkillRow(skillId, { ...patch, updatedAt: new Date() })
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
