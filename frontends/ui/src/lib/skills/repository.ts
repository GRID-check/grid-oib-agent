/**
 * Skills repository — the only module that queries the `skills`,
 * `skill_schedules` and `skill_runs` tables (ADR-0017).
 *
 * Repository rules: drizzle only; no HTTP, no auth, no WorkOS. Every query that
 * serves tenant data takes `organizationId` and scopes the WHERE clause with it
 * — tenancy is enforced in SQL. List queries are always bounded.
 */

import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  skills,
  skillSchedules,
  skillRuns,
  type NewSkill,
  type NewSkillRun,
  type NewSkillSchedule,
  type Skill,
  type SkillRun,
  type SkillSchedule,
} from '@/lib/db/schema'

/** Hard cap for an organization's skill list. */
export const SKILLS_LIST_LIMIT = 100
/** Hard cap for a project's schedule list. */
export const SKILL_SCHEDULES_LIST_LIMIT = 100
/** Default page size for run history. */
export const SKILL_RUNS_DEFAULT_LIMIT = 50
/** Hard cap for run history pages. */
export const SKILL_RUNS_MAX_LIMIT = 200

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

export async function insertSkillSchedule(values: NewSkillSchedule): Promise<SkillSchedule> {
  const db = getDb()
  const [row] = await db.insert(skillSchedules).values(values).returning()
  return row
}

export async function listSkillSchedulesInProject(
  projectId: string,
  organizationId: string,
  limit = SKILL_SCHEDULES_LIST_LIMIT,
): Promise<SkillSchedule[]> {
  const db = getDb()
  return db
    .select()
    .from(skillSchedules)
    .where(
      and(
        eq(skillSchedules.projectId, projectId),
        eq(skillSchedules.organizationId, organizationId),
      ),
    )
    .orderBy(desc(skillSchedules.createdAt))
    .limit(limit)
}

/** Load a schedule scoped to an organization (double-filtered by org). */
export async function findSkillSchedule(
  scheduleId: string,
  organizationId: string,
): Promise<SkillSchedule | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(skillSchedules)
    .where(and(eq(skillSchedules.id, scheduleId), eq(skillSchedules.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

/**
 * Load a schedule by id WITHOUT an org filter — for the internal fire path,
 * which has no session. The caller uses the row's own `organizationId` for all
 * subsequent tenant-scoped work.
 */
export async function findSkillScheduleById(scheduleId: string): Promise<SkillSchedule | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(skillSchedules)
    .where(eq(skillSchedules.id, scheduleId))
    .limit(1)
  return row ?? null
}

/** The columns a service may update on a skill schedule. */
export type SkillScheduleUpdate = Partial<
  Pick<
    SkillSchedule,
    | 'name'
    | 'skillName'
    | 'skillSnapshot'
    | 'execution'
    | 'dataSources'
    | 'enabled'
    | 'scheduleCron'
    | 'scheduleTimezone'
    | 'nextRunAt'
    | 'updatedAt'
  >
>

export async function updateSkillSchedule(
  scheduleId: string,
  organizationId: string,
  patch: SkillScheduleUpdate,
): Promise<SkillSchedule | null> {
  const db = getDb()
  const [row] = await db
    .update(skillSchedules)
    .set(patch)
    .where(
      and(
        eq(skillSchedules.id, scheduleId),
        eq(skillSchedules.organizationId, organizationId),
      ),
    )
    .returning()
  return row ?? null
}

export async function deleteSkillSchedule(
  scheduleId: string,
  organizationId: string,
): Promise<boolean> {
  const db = getDb()
  const deleted = await db
    .delete(skillSchedules)
    .where(
      and(
        eq(skillSchedules.id, scheduleId),
        eq(skillSchedules.organizationId, organizationId),
      ),
    )
    .returning({ id: skillSchedules.id })
  return deleted.length > 0
}

/** Advance `last_run_at` after a fire attempt (submitted/skipped/error). */
export async function touchSkillScheduleLastRun(scheduleId: string, at: Date): Promise<void> {
  const db = getDb()
  await db.update(skillSchedules).set({ lastRunAt: at }).where(eq(skillSchedules.id, scheduleId))
}

export async function insertSkillRun(values: NewSkillRun): Promise<SkillRun> {
  const db = getDb()
  const [row] = await db.insert(skillRuns).values(values).returning()
  return row
}

export async function listSkillRuns(
  scheduleId: string,
  organizationId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<SkillRun[]> {
  const db = getDb()
  const limit = Math.min(options.limit ?? SKILL_RUNS_DEFAULT_LIMIT, SKILL_RUNS_MAX_LIMIT)
  const offset = options.offset ?? 0
  return db
    .select()
    .from(skillRuns)
    .where(
      and(
        eq(skillRuns.scheduleId, scheduleId),
        eq(skillRuns.organizationId, organizationId),
      ),
    )
    .orderBy(desc(skillRuns.createdAt))
    .limit(limit)
    .offset(offset)
}