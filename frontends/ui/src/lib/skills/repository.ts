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
import { skills, type NewSkill, type Skill } from '@/lib/db/schema'

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
