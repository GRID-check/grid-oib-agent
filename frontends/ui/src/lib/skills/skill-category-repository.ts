/**
 * Skill category repository — the only module that queries `skill_categories`
 * (ADR-0017).
 *
 * ONE table, two owners: a NULL `organization_id` is a platform shelf, a set
 * one that org's own. Reads therefore always span both (platform shelves
 * first), while writes are scoped by who is asking — an org path that touches
 * a platform row, or vice versa, is a 404 at the service, never a row here.
 *
 * Repository rules: drizzle only; no HTTP, no auth, no WorkOS. Every query
 * that serves tenant data takes `organizationId` and scopes the WHERE clause
 * with it — tenancy is enforced in SQL. List queries are always bounded.
 */

import 'server-only'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  skillCategories,
  type NewSkillCategoryRow,
  type SkillCategoryRow,
} from '@/lib/db/schema'

/** Hard cap for a shelf list — platform shelves plus one org's own. */
export const CATEGORIES_LIST_LIMIT = 100

/**
 * Every shelf an organization sees: the platform's, then its own.
 *
 * Ordered the way the toolbox reads them — platform shelves first (NULLS
 * FIRST), then by sort order, ties by name. Bounded, like every list.
 */
export async function listCategoriesForOrg(
  organizationId: string,
  limit = CATEGORIES_LIST_LIMIT,
): Promise<SkillCategoryRow[]> {
  const db = getDb()
  return db
    .select()
    .from(skillCategories)
    .where(or(isNull(skillCategories.organizationId), eq(skillCategories.organizationId, organizationId)))
    .orderBy(
      sql`${skillCategories.organizationId} NULLS FIRST`,
      asc(skillCategories.sortOrder),
      asc(skillCategories.name),
    )
    .limit(limit)
}

/** The platform's shelves only — the curation surface. */
export async function listPlatformCategories(
  limit = CATEGORIES_LIST_LIMIT,
): Promise<SkillCategoryRow[]> {
  const db = getDb()
  return db
    .select()
    .from(skillCategories)
    .where(isNull(skillCategories.organizationId))
    .orderBy(asc(skillCategories.sortOrder), asc(skillCategories.name))
    .limit(limit)
}

/**
 * Load a shelf an organization may stand a skill on: its own, or a platform
 * one. Anything else is null — the service reads that as "no such shelf"
 * without learning which half missed.
 */
export async function findCategoryInScope(
  categoryId: string,
  organizationId: string,
): Promise<SkillCategoryRow | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(skillCategories)
    .where(
      and(
        eq(skillCategories.id, categoryId),
        or(isNull(skillCategories.organizationId), eq(skillCategories.organizationId, organizationId)),
      ),
    )
    .limit(1)
  return row ?? null
}

/** Load a platform shelf by id — the platform write path's ownership check. */
export async function findPlatformCategory(categoryId: string): Promise<SkillCategoryRow | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(skillCategories)
    .where(and(eq(skillCategories.id, categoryId), isNull(skillCategories.organizationId)))
    .limit(1)
  return row ?? null
}

/** An org's own shelf by name — the conflict check before create/rename. */
export async function findOrgCategoryByName(
  name: string,
  organizationId: string,
): Promise<SkillCategoryRow | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(skillCategories)
    .where(
      and(eq(skillCategories.name, name), eq(skillCategories.organizationId, organizationId)),
    )
    .limit(1)
  return row ?? null
}

/** A platform shelf by name — the platform conflict check. */
export async function findPlatformCategoryByName(name: string): Promise<SkillCategoryRow | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(skillCategories)
    .where(and(eq(skillCategories.name, name), isNull(skillCategories.organizationId)))
    .limit(1)
  return row ?? null
}

/** An org's OWN shelf by id — update/delete must never touch a platform row. */
export async function findOrgCategory(
  categoryId: string,
  organizationId: string,
): Promise<SkillCategoryRow | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(skillCategories)
    .where(
      and(
        eq(skillCategories.id, categoryId),
        eq(skillCategories.organizationId, organizationId),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function insertCategory(values: NewSkillCategoryRow): Promise<SkillCategoryRow> {
  const db = getDb()
  const [row] = await db.insert(skillCategories).values(values).returning()
  return row
}

/** The columns a curator may change on a shelf. */
export type CategoryUpdate = Partial<
  Pick<SkillCategoryRow, 'name' | 'description' | 'sortOrder' | 'updatedAt'>
>

export async function updateCategory(
  categoryId: string,
  patch: CategoryUpdate,
): Promise<SkillCategoryRow | null> {
  const db = getDb()
  const [row] = await db
    .update(skillCategories)
    .set(patch)
    .where(eq(skillCategories.id, categoryId))
    .returning()
  return row ?? null
}

/**
 * Remove a shelf. Skills standing on it are NOT removed — both skill tables
 * reference it ON DELETE SET NULL, so they fall back to unsorted, which is
 * exactly what "remove the shelf, keep the books" means.
 */
export async function deleteCategory(categoryId: string): Promise<boolean> {
  const db = getDb()
  const deleted = await db
    .delete(skillCategories)
    .where(eq(skillCategories.id, categoryId))
    .returning({ id: skillCategories.id })
  return deleted.length > 0
}

/** Org shelves must carry their org — the one thing the type cannot say. */
export function orgCategoryValues(
  organizationId: string,
  values: Omit<NewSkillCategoryRow, 'organizationId'>,
): NewSkillCategoryRow {
  return { ...values, organizationId }
}
