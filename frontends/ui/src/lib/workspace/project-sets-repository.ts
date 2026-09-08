/**
 * The Sammlungen's SQL: the sets of one organization, the projects of one set,
 * and the four writes that change either (ADR-0054, spec GR-2).
 *
 * Repository rules apply (ADR-0017): every list is bounded, nothing here
 * decides anything about authorization, and the caller has already opened the
 * tenant scope. In particular the member reads return EVERY membership row —
 * filtering them down to what the caller may actually see is a decision, and it
 * belongs to `./project-sets-service` beside the rest of them.
 *
 * The project JOIN is part of the member read rather than a second query, for
 * the same reason `mounts-repository` joins it: a membership is worth nothing
 * to a reader without the project's NAME, and the INNER JOIN is what makes
 * "a purged project is not a nameless member" a fact of the query rather than
 * an assumption about a constraint somewhere else.
 */

import 'server-only'
import { and, asc, eq, inArray, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { projects, projectSetMembers, projectSets } from '@/lib/db/schema'

/**
 * The upper bound on one organization's Sammlungen list.
 *
 * A firm naming two hundred sets has a different problem than pagination; the
 * bound is here because a list without one is how a repository ships a table
 * scan, not because this list is expected to reach it.
 */
const SET_LIST_LIMIT = 200

/**
 * The upper bound on the memberships one read returns.
 *
 * Deliberately far above the mount cap (at most 20): a Sammlung of forty
 * projects is a legitimate thing to own — only MOUNTING it is refused — so this
 * bound must not be the cap in disguise. It bounds the LIST view too, where one
 * query covers every set in the organization.
 */
const MEMBER_LIST_LIMIT = 2000

/** One Sammlung, as the service and the wire both see it. */
export interface ProjectSetRow {
  id: string
  name: string
  description: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

/** One membership, joined to the project name every reader of it needs. */
export interface ProjectSetMemberRow {
  setId: string
  projectId: string
  projectName: string
  addedAt: Date
}

function toSetRow(row: typeof projectSets.$inferSelect): ProjectSetRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    // The driver hands back a Date for a timestamptz column; the coercion is
    // free and makes the boundary's promise true whatever it hands back next.
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }
}

/** Every Sammlung of one organization, by name. */
export async function listProjectSetsInOrg(organizationId: string): Promise<ProjectSetRow[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(projectSets)
    .where(eq(projectSets.organizationId, organizationId))
    .orderBy(asc(projectSets.name))
    .limit(SET_LIST_LIMIT)
  return rows.map(toSetRow)
}

/** One Sammlung, or null when this organization has no such set. */
export async function findProjectSetInOrg(
  setId: string,
  organizationId: string
): Promise<ProjectSetRow | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(projectSets)
    .where(and(eq(projectSets.id, setId), eq(projectSets.organizationId, organizationId)))
    .limit(1)
  return row ? toSetRow(row) : null
}

export interface InsertProjectSetValues {
  organizationId: string
  name: string
  description: string | null
  createdBy: string
}

/**
 * Create one Sammlung.
 *
 * Lets the unique violation (23505 on `uniq_project_sets_org_name`) out
 * unchanged: the service turns it into the conflict a person can act on, and a
 * repository that swallowed it would have to guess which of the two names the
 * caller meant.
 */
export async function insertProjectSet(values: InsertProjectSetValues): Promise<ProjectSetRow> {
  const db = getDb()
  const [row] = await db.insert(projectSets).values(values).returning()
  return toSetRow(row)
}

export interface UpdateProjectSetValues {
  name?: string
  description?: string | null
}

/**
 * Rename or re-describe one Sammlung, stamping `updated_at`.
 *
 * Returns null when nothing matched, which is the same "no such set in this
 * organization" the finder reports — the caller has already established that it
 * existed, so this is the concurrent-delete case rather than an authorization
 * one.
 */
export async function updateProjectSetRow(
  setId: string,
  organizationId: string,
  values: UpdateProjectSetValues
): Promise<ProjectSetRow | null> {
  const db = getDb()
  const [row] = await db
    .update(projectSets)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(projectSets.id, setId), eq(projectSets.organizationId, organizationId)))
    .returning()
  return row ? toSetRow(row) : null
}

/** Remove one Sammlung. Its memberships go with it, by cascade. */
export async function deleteProjectSetRow(setId: string, organizationId: string): Promise<boolean> {
  const db = getDb()
  const removed = await db
    .delete(projectSets)
    .where(and(eq(projectSets.id, setId), eq(projectSets.organizationId, organizationId)))
    .returning({ id: projectSets.id })
  return removed.length > 0
}

/** Every project one Sammlung names, oldest membership first. */
export async function listProjectSetMembers(
  setId: string,
  organizationId: string
): Promise<ProjectSetMemberRow[]> {
  return selectMembers(organizationId, eq(projectSetMembers.setId, setId))
}

/**
 * The memberships of several Sammlungen in one query — what the LIST view needs
 * so that a page of sets costs one member read rather than one per set.
 */
export async function listMembersOfProjectSets(
  setIds: readonly string[],
  organizationId: string
): Promise<ProjectSetMemberRow[]> {
  if (setIds.length === 0) return []
  return selectMembers(organizationId, inArray(projectSetMembers.setId, [...setIds]))
}

async function selectMembers(
  organizationId: string,
  scope: SQL | undefined
): Promise<ProjectSetMemberRow[]> {
  const db = getDb()
  const rows = await db
    .select({
      setId: projectSetMembers.setId,
      projectId: projectSetMembers.projectId,
      projectName: projects.name,
      addedAt: projectSetMembers.addedAt,
    })
    .from(projectSetMembers)
    .innerJoin(
      projects,
      and(
        eq(projects.id, projectSetMembers.projectId),
        eq(projects.organizationId, projectSetMembers.organizationId)
      )
    )
    .where(and(eq(projectSetMembers.organizationId, organizationId), scope))
    .orderBy(asc(projectSetMembers.addedAt))
    .limit(MEMBER_LIST_LIMIT)

  return rows.map((row) => ({
    setId: row.setId,
    projectId: row.projectId,
    projectName: row.projectName,
    addedAt: new Date(row.addedAt),
  }))
}

/**
 * Add projects to a Sammlung, ignoring the ones already in it.
 *
 * Returns how many memberships were actually written, so a caller can tell
 * "added" from "was already there" — both are the same outcome on the wire, and
 * only one of them is worth a log line. `ON CONFLICT DO NOTHING` on the
 * primary key is what makes adding twice the same membership.
 */
export async function insertProjectSetMembers(
  setId: string,
  organizationId: string,
  projectIds: readonly string[]
): Promise<number> {
  if (projectIds.length === 0) return 0
  const db = getDb()
  const written = await db
    .insert(projectSetMembers)
    .values(projectIds.map((projectId) => ({ setId, organizationId, projectId })))
    .onConflictDoNothing()
    .returning({ projectId: projectSetMembers.projectId })
  return written.length
}

/** Remove projects from a Sammlung. Returns how many memberships went. */
export async function deleteProjectSetMembers(
  setId: string,
  organizationId: string,
  projectIds: readonly string[]
): Promise<number> {
  if (projectIds.length === 0) return 0
  const db = getDb()
  const removed = await db
    .delete(projectSetMembers)
    .where(
      and(
        eq(projectSetMembers.setId, setId),
        eq(projectSetMembers.organizationId, organizationId),
        inArray(projectSetMembers.projectId, [...projectIds])
      )
    )
    .returning({ projectId: projectSetMembers.projectId })
  return removed.length
}
