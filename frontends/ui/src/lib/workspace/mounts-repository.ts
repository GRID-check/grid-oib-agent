/**
 * The mounts' SQL: read the mounted set, insert one, remove one (ADR-0054,
 * spec MT-5, MT-13).
 *
 * Repository rules apply (ADR-0017): every list is bounded, nothing here
 * decides anything about authorization, and the caller has already opened the
 * tenant scope. The project JOIN is part of the read rather than a second
 * query, because a mount is worth nothing to a reader without the project's
 * NAME — "Im Blick: <name>" is the whole point of the chip — and the collection
 * name it grants access to lives on the same row.
 */

import 'server-only'
import { and, asc, count, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { conversationMounts, projects, type MountActor } from '@/lib/db/schema'

/**
 * The upper bound on one conversation's mount list.
 *
 * Well above `MAX_MAX_MOUNTED_PROJECTS` (20), and deliberately NOT the cap: a
 * deployment that LOWERS the cap must still be able to read — and let a person
 * remove — the rows it already has. The bound is here because a list without
 * one is how a repository ships a table scan, not because this list can
 * realistically grow.
 */
const MOUNT_LIST_LIMIT = 100

/** One mounted project, joined to the facts a reader and a grant both need. */
export interface MountRow {
  projectId: string
  projectName: string
  /** `projects.collection_name` — the collection the grant will name. */
  collectionName: string
  mountedBy: MountActor
  mountedByUserId: string | null
  mountedAt: Date
}

/**
 * Every project mounted into one conversation, oldest first.
 *
 * INNER JOIN on `projects`, so a project that has gone away cannot appear as a
 * nameless mount. The composite foreign key means the row would already have
 * cascaded, but the join is what makes that a fact of the query rather than an
 * assumption about a constraint somewhere else.
 */
export async function listConversationMounts(
  conversationId: string,
  organizationId: string
): Promise<MountRow[]> {
  const db = getDb()
  const rows = await db
    .select({
      projectId: conversationMounts.projectId,
      projectName: projects.name,
      collectionName: projects.collectionName,
      mountedBy: conversationMounts.mountedBy,
      mountedByUserId: conversationMounts.mountedByUserId,
      mountedAt: conversationMounts.mountedAt,
    })
    .from(conversationMounts)
    .innerJoin(
      projects,
      and(
        eq(projects.id, conversationMounts.projectId),
        eq(projects.organizationId, conversationMounts.organizationId)
      )
    )
    .where(
      and(
        eq(conversationMounts.conversationId, conversationId),
        eq(conversationMounts.organizationId, organizationId)
      )
    )
    .orderBy(asc(conversationMounts.mountedAt))
    .limit(MOUNT_LIST_LIMIT)

  return rows.map((row) => ({
    projectId: row.projectId,
    projectName: row.projectName,
    collectionName: row.collectionName,
    mountedBy: row.mountedBy,
    mountedByUserId: row.mountedByUserId,
    // The driver hands back a Date for a timestamptz column; the coercion is
    // free and makes the boundary's promise true whatever it hands back next.
    mountedAt: new Date(row.mountedAt),
  }))
}

/**
 * How many projects one conversation has mounted.
 *
 * The sharing guard asks this and nothing else: whether a Büro thread may be
 * widened turns on whether it reads any project at all, and the count answers
 * that without the project JOIN — the names are only worth fetching once
 * something is going to be refused with them in it (AC-7).
 */
export async function countConversationMounts(
  conversationId: string,
  organizationId: string
): Promise<number> {
  const db = getDb()
  const [row] = await db
    .select({ mounted: count() })
    .from(conversationMounts)
    .where(
      and(
        eq(conversationMounts.conversationId, conversationId),
        eq(conversationMounts.organizationId, organizationId)
      )
    )
  // `count()` is a bigint on the wire; the driver may hand it back as a string.
  return Number(row?.mounted ?? 0)
}

export interface InsertMountValues {
  conversationId: string
  organizationId: string
  projectId: string
  mountedBy: MountActor
  mountedByUserId: string | null
}

/**
 * Insert one mount, or do nothing when it is already there.
 *
 * Returns whether a row was written. `false` is the idempotent case (MT-2's one
 * endpoint reached twice: a double-click, a retried tool call), and the caller
 * reads the existing row back rather than trusting what it tried to write —
 * the stored `mounted_by` is whoever mounted it FIRST, which is the attribution
 * a reader is owed.
 */
export async function insertConversationMount(values: InsertMountValues): Promise<boolean> {
  const db = getDb()
  const written = await db
    .insert(conversationMounts)
    .values(values)
    .onConflictDoNothing({
      target: [conversationMounts.conversationId, conversationMounts.projectId],
    })
    .returning({ id: conversationMounts.id })
  return written.length > 0
}

/**
 * Remove one mount. Returns whether a row was actually removed, so a caller can
 * tell "unmounted" from "was not mounted" — both are a 204 on the wire (MT-13:
 * the outcome the client asked for is the outcome either way), but only one of
 * them is worth a log line.
 */
export async function deleteConversationMount(
  conversationId: string,
  projectId: string,
  organizationId: string
): Promise<boolean> {
  const db = getDb()
  const removed = await db
    .delete(conversationMounts)
    .where(
      and(
        eq(conversationMounts.conversationId, conversationId),
        eq(conversationMounts.projectId, projectId),
        eq(conversationMounts.organizationId, organizationId)
      )
    )
    .returning({ id: conversationMounts.id })
  return removed.length > 0
}
