/**
 * Platform skills repository — the only module that queries `platform_skills`,
 * the fleet-wide curated catalogue written in Platform → Skills (ADR-0016).
 *
 * Deliberately separate from `./repository`, which owns the org-scoped `skills`
 * table. Every query there takes an `organizationId` and scopes its WHERE
 * clause with it; NONE of these do, because this table holds no tenant data —
 * one row is offered to every organization at once. Keeping the two apart means
 * the missing org predicate is a property of the module rather than something a
 * reader has to check per function.
 *
 * Writes run only under the platform bypass (`platformApiRoute`); the tenant
 * role has SELECT and nothing else, enforced in SQL by
 * `grid_secure_platform_table` (0031).
 */

import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  platformSkills,
  type NewPlatformSkillRow,
  type PlatformSkillRow,
} from '@/lib/db/schema'

/** Hard cap for the curated catalogue. */
export const PLATFORM_SKILLS_LIST_LIMIT = 200

/**
 * Every curated skill, drafts included — the platform dashboard's list.
 *
 * Ordered by name rather than by creation date: this is a catalogue somebody
 * scans for a name they half-remember, not a feed.
 */
export async function listPlatformSkillRows(
  limit = PLATFORM_SKILLS_LIST_LIMIT,
): Promise<PlatformSkillRow[]> {
  const db = getDb()
  return db.select().from(platformSkills).orderBy(asc(platformSkills.name)).limit(limit)
}

/**
 * Every LIVE row, whichever way it is delivered — the published ones.
 *
 * Deliberately one query rather than one per `delivery`. Both kinds are needed
 * together on the hot path (`resolveSkillsForAgent` wants the offers this org
 * took up AND the fleet's standard set in the same resolution), and the
 * catalogue is capped at 200 rows, so splitting it would buy a second round trip
 * and nothing else. The service partitions what comes back.
 */
export async function listPublishedPlatformSkillRows(
  limit = PLATFORM_SKILLS_LIST_LIMIT,
): Promise<PlatformSkillRow[]> {
  const db = getDb()
  return db
    .select()
    .from(platformSkills)
    .where(eq(platformSkills.published, true))
    .orderBy(asc(platformSkills.name))
    .limit(limit)
}

/**
 * The names the platform has reserved fleet-wide: published `standard` rows.
 *
 * Its own query, and a narrow one, because it serves the ORG write path — a
 * tenant naming a skill the platform already standardised. That row would never
 * resolve (standard wins the merge, by design), so authoring it has to be
 * refused at the boundary rather than accepted and quietly ignored. Reading the
 * whole catalogue to answer "is this one name taken" would put a 200-row read on
 * every skill save in the fleet; the partial index `idx_platform_skills_standard`
 * makes this a point lookup instead.
 */
export async function findStandardPlatformSkillRowByName(
  name: string,
): Promise<PlatformSkillRow | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(platformSkills)
    .where(
      and(
        eq(platformSkills.name, name),
        eq(platformSkills.delivery, 'standard'),
        eq(platformSkills.published, true),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function findPlatformSkillRow(skillId: string): Promise<PlatformSkillRow | null> {
  const db = getDb()
  const [row] = await db.select().from(platformSkills).where(eq(platformSkills.id, skillId)).limit(1)
  return row ?? null
}

/** By name — the fleet-wide unique key an activation decision refers to. */
export async function findPlatformSkillRowByName(name: string): Promise<PlatformSkillRow | null> {
  const db = getDb()
  const [row] = await db.select().from(platformSkills).where(eq(platformSkills.name, name)).limit(1)
  return row ?? null
}

export async function insertPlatformSkillRow(
  values: NewPlatformSkillRow,
): Promise<PlatformSkillRow> {
  const db = getDb()
  const [row] = await db.insert(platformSkills).values(values).returning()
  return row
}

/** The columns a service may update on a curated skill. */
export type PlatformSkillUpdate = Partial<
  Pick<
    PlatformSkillRow,
    'name' | 'description' | 'body' | 'metadata' | 'published' | 'delivery' | 'updatedAt'
  >
>

export async function updatePlatformSkillRow(
  skillId: string,
  patch: PlatformSkillUpdate,
): Promise<PlatformSkillRow | null> {
  const db = getDb()
  const [row] = await db
    .update(platformSkills)
    .set(patch)
    .where(eq(platformSkills.id, skillId))
    .returning()
  return row ?? null
}

export async function deletePlatformSkillRow(skillId: string): Promise<boolean> {
  const db = getDb()
  const deleted = await db
    .delete(platformSkills)
    .where(eq(platformSkills.id, skillId))
    .returning({ id: platformSkills.id })
  return deleted.length > 0
}
