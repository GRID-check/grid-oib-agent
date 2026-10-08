/**
 * The Steckbrief's own rows (ADR-0089): a project's period on `projects`, and
 * its people in `project_people`. Every query names the organization and runs
 * in its tenant context; the people list of one project is bounded.
 */

import 'server-only'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { projectPeople, projects, type ProjectPersonRow } from '@/lib/db/schema'

/** Most people one project lists. Far above any real project team; a bound, not a quota. */
export const PROJECT_PEOPLE_LIMIT = 500

export interface ProjectPeriodRow {
  startedOn: string | null
  endedOn: string | null
}

export async function findProjectPeriod(projectId: string, organizationId: string): Promise<ProjectPeriodRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select({ startedOn: projects.startedOn, endedOn: projects.endedOn })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId), isNull(projects.deletedAt)))
      .limit(1)
  )
  return row ?? null
}

export async function updateProjectPeriod(
  projectId: string,
  organizationId: string,
  period: ProjectPeriodRow
): Promise<ProjectPeriodRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(projects)
      .set({ startedOn: period.startedOn, endedOn: period.endedOn })
      .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId), isNull(projects.deletedAt)))
      .returning({ startedOn: projects.startedOn, endedOn: projects.endedOn })
  )
  return row ?? null
}

export async function listProjectPeople(projectId: string, organizationId: string): Promise<ProjectPersonRow[]> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(projectPeople)
      .where(and(eq(projectPeople.projectId, projectId), eq(projectPeople.organizationId, organizationId)))
      .orderBy(asc(projectPeople.startedOn), asc(projectPeople.name), asc(projectPeople.id))
      .limit(PROJECT_PEOPLE_LIMIT)
  )
}

export interface ProjectPersonValues {
  name: string
  function: string | null
  company: string | null
  startedOn: string | null
  endedOn: string | null
  userId: string | null
}

export async function insertProjectPerson(
  projectId: string,
  organizationId: string,
  createdBy: string,
  values: ProjectPersonValues
): Promise<ProjectPersonRow> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .insert(projectPeople)
      .values({ ...values, projectId, organizationId, createdBy })
      .returning()
  )
  return row
}

export async function updateProjectPersonRow(
  projectId: string,
  organizationId: string,
  personId: string,
  values: ProjectPersonValues
): Promise<ProjectPersonRow | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .update(projectPeople)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(projectPeople.id, personId),
          eq(projectPeople.projectId, projectId),
          eq(projectPeople.organizationId, organizationId)
        )
      )
      .returning()
  )
  return row ?? null
}

/** Deletes the row outright: the erasure. True when a row went. */
export async function deleteProjectPersonRow(projectId: string, organizationId: string, personId: string): Promise<boolean> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .delete(projectPeople)
      .where(
        and(
          eq(projectPeople.id, personId),
          eq(projectPeople.projectId, projectId),
          eq(projectPeople.organizationId, organizationId)
        )
      )
      .returning({ id: projectPeople.id })
  )
  return rows.length > 0
}
