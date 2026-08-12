/**
 * Skills repository — the only module that queries the `skills` table
 * (ADR-0017). Jobs and their runs live next door in `@/lib/jobs/repository`:
 * a job ATTACHES a skill, so the two are separate tables with separate owners.
 *
 * Repository rules: drizzle only; no HTTP, no auth, no WorkOS. Every query that
 * serves tenant data takes `organizationId` and scopes the WHERE clause with it
 * — tenancy is enforced in SQL. List queries are always bounded.
 */

import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  curatedSkillActivations,
  skills,
  type NewSkill,
  type CuratedSkillActivation,
  type Skill,
} from '@/lib/db/schema'

/** Hard cap for an organization's skill list. */
export const SKILLS_LIST_LIMIT = 100

export async function insertSkill(values: NewSkill): Promise<Skill> {
  const db = getDb()
  const [row] = await db.insert(skills).values(values).returning()
  return row
}

export async function listSkillsInOrg(
  organizationId: string,
  limit = SKILLS_LIST_LIMIT,
): Promise<Skill[]> {
  const db = getDb()
  return db
    .select()
    .from(skills)
    .where(eq(skills.organizationId, organizationId))
    .orderBy(desc(skills.createdAt))
    .limit(limit)
}

/** Load a skill scoped to an organization. */
export async function findSkill(skillId: string, organizationId: string): Promise<Skill | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, skillId), eq(skills.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

/** Load a skill by name scoped to an organization (name is unique per org). */
export async function findSkillByName(
  name: string,
  organizationId: string,
): Promise<Skill | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(skills)
    .where(and(eq(skills.name, name), eq(skills.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

/** The columns a service may update on a skill. */
export type SkillUpdate = Partial<
  Pick<
    Skill,
    | 'name'
    | 'description'
    | 'body'
    | 'metadata'
    | 'enabled'
    | 'updatedAt'
  >
>

export async function updateSkill(
  skillId: string,
  organizationId: string,
  patch: SkillUpdate,
): Promise<Skill | null> {
  const db = getDb()
  const [row] = await db
    .update(skills)
    .set(patch)
    .where(and(eq(skills.id, skillId), eq(skills.organizationId, organizationId)))
    .returning()
  return row ?? null
}

export async function deleteSkill(skillId: string, organizationId: string): Promise<boolean> {
  const db = getDb()
  const deleted = await db
    .delete(skills)
    .where(and(eq(skills.id, skillId), eq(skills.organizationId, organizationId)))
    .returning({ id: skills.id })
  return deleted.length > 0
}

// ---------------------------------------------------------------------------
// Platform-curated skill activations
//
// A platform skill is a FILE, so an org's decision about one cannot live on the
// skill. It lives here: one row per curated skill the org has decided about,
// and no row for the ones it has never been asked about.
// ---------------------------------------------------------------------------

/** Hard cap: an org cannot decide about more skills than the platform ships. */
export const ACTIVATIONS_LIST_LIMIT = 200

export async function listCuratedSkillActivations(
  organizationId: string,
  limit = ACTIVATIONS_LIST_LIMIT,
): Promise<CuratedSkillActivation[]> {
  const db = getDb()
  return db
    .select()
    .from(curatedSkillActivations)
    .where(eq(curatedSkillActivations.organizationId, organizationId))
    .limit(limit)
}

/**
 * Record the org's decision about one curated skill.
 *
 * An upsert rather than an insert-or-update pair: a switch is idempotent by
 * nature — flipping it to the state it is already in must be a no-op, not a
 * unique violation the caller has to interpret.
 */
export async function upsertCuratedSkillActivation(values: {
  organizationId: string
  skillName: string
  enabled: boolean
  updatedBy: string
  updatedByEmail?: string | null
}): Promise<CuratedSkillActivation> {
  const db = getDb()
  const [row] = await db
    .insert(curatedSkillActivations)
    .values({
      organizationId: values.organizationId,
      skillName: values.skillName,
      enabled: values.enabled,
      updatedBy: values.updatedBy,
      updatedByEmail: values.updatedByEmail ?? null,
    })
    .onConflictDoUpdate({
      target: [curatedSkillActivations.organizationId, curatedSkillActivations.skillName],
      set: {
        enabled: values.enabled,
        updatedBy: values.updatedBy,
        updatedByEmail: values.updatedByEmail ?? null,
        updatedAt: new Date(),
      },
    })
    .returning()
  return row
}
