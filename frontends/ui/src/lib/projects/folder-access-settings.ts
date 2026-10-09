/**
 * Setting who may read and who may write a project folder (ADR-0088, ADR-0096).
 *
 * A folder inherits its parent's access, or has its own list: people, each with
 * `read` or `write`, and optionally „everyone in the project reads". The people
 * are WorkOS's: the folder is a WorkOS `folder` resource and each of them holds
 * a folder role on it (`./../authz/folder-roles`). Nesting only narrows
 * (`effectiveFolderLevel`), so an own list on a subfolder can take access away
 * from what the parent gives and never add to it.
 *
 * Who may change it: whoever manages the project (`project:manage`, which an
 * organization admin holds through `org:projects:administer`) AND may write the
 * folder. Changing its list is the strongest write there is on it: a manager
 * who could do it with only Lesen could give themselves Bearbeiten. One who may
 * not read the folder cannot see it, so cannot change it either. An
 * organization admin writes everywhere, which is what keeps a list whose people
 * have all left from locking a folder away for good.
 *
 * Writing the folder is also what keeps a change from granting the caller more
 * than they hold: the level on a folder is the minimum over its path, so
 * someone who writes it already holds the most any list on it could give.
 *
 * Changing who may READ moves the subtree's documents into the collection the
 * new tree puts them in (`./collection-placement`), so the change holds in
 * retrieval, not only in listings, before the request returns for every
 * document whose move succeeded. Changing who may only WRITE moves nothing.
 *
 * The order of the writes keeps every moment between the old list and the new
 * one no wider than one of them: WorkOS first and the folder row last when a
 * folder gets its own list, the folder row first and WorkOS last when it goes
 * back to inheriting. Folder roles on a folder that inherits are never read.
 */

import 'server-only'
import { and, eq, isNull } from 'drizzle-orm'
import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { folderReadOnlyError, getProjectFolderAccess, type FolderGrantLevel } from '@/lib/authz/folder-access'
import {
  ensureFolderResource,
  listFolderRoleHolders,
  removeFolderResource,
  replaceFolderRoleHolders,
} from '@/lib/authz/folder-roles'
import { resolveSubjectMembership } from '@/lib/authz/project-membership'
import { requireProjectAccess } from '@/lib/authz/projects'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { projectFolders } from '@/lib/db/schema'
import { findProjectInOrg } from '@/lib/projects/repository'
import { placeProjectDocuments, type PlacementResult } from './collection-placement'
import { assertRestrictionKeepsIfcOpen } from './ifc-folder-guard'

/** Most people one folder's own list may name. A list longer than this is a group's job. */
export const FOLDER_ACCESS_MAX_PEOPLE = 50

/** One person on a folder's own list. */
export interface FolderPersonGrant {
  userId: string
  level: FolderGrantLevel
}

/** A folder's access, as it is set. */
export type FolderAccessSetting =
  | { mode: 'inherit' }
  | { mode: 'custom'; everyoneReads: boolean; people: FolderPersonGrant[] }

export interface FolderAccessResult extends PlacementResult {
  folderId: string
  access: FolderAccessSetting
}

/**
 * The audit form of a list: `*:read` when everyone reads, then
 * `user:<id>:<level>` per person, comma-joined and sorted. Kept in the
 * `grants` field the role-based lists wrote, so the trail reads the same
 * across the change and the registered audit schema stays as it is.
 */
export function describeAccess(access: FolderAccessSetting): string {
  if (access.mode === 'inherit') return ''
  const entries = access.people.map((person) => `user:${person.userId}:${person.level}`).sort()
  return [...(access.everyoneReads ? ['*:read'] : []), ...entries].join(',')
}

interface ResolvedPerson {
  userId: string
  organizationMembershipId: string
  level: FolderGrantLevel
}

/**
 * The list as it may be set: each person once, at most
 * {@link FOLDER_ACCESS_MAX_PEOPLE}, each a member of the organization. A list
 * that names nobody and that everyone does not read is refused: only
 * organization admins would read it, and inherit is the way to say "as the
 * parent". A person named twice is refused rather than guessed at.
 */
async function resolvedPeople(
  organizationId: string,
  access: Extract<FolderAccessSetting, { mode: 'custom' }>
): Promise<ResolvedPerson[]> {
  if (access.people.length === 0 && !access.everyoneReads) {
    throw new BadRequestError('A folder with its own access list needs at least one person, or everyone reading it')
  }
  if (access.people.length > FOLDER_ACCESS_MAX_PEOPLE) {
    throw new BadRequestError(`A folder names at most ${FOLDER_ACCESS_MAX_PEOPLE} people`)
  }
  const userIds = access.people.map((person) => person.userId)
  if (new Set(userIds).size !== userIds.length) throw new BadRequestError('A person is listed twice')
  const memberships = await Promise.all(userIds.map((userId) => resolveSubjectMembership(organizationId, userId)))
  const unknown = userIds.filter((_userId, index) => !memberships[index])
  if (unknown.length > 0) throw new BadRequestError(`Not a member of this organization: ${unknown.join(', ')}`)
  return access.people.map((person, index) => ({
    userId: person.userId,
    organizationMembershipId: memberships[index]?.organizationMembershipId ?? '',
    level: person.level,
  }))
}

/**
 * Authorizes a change to `folderId`'s list and returns the project: needs
 * `project:manage` and write on the folder (404 when the folder is not
 * readable, a typed 403 when it is only readable).
 */
async function requireListManager(session: AuthorizedSession, projectId: string, folderId: string) {
  await requireProjectAccess(session, projectId, 'project:manage')
  const project = await findProjectInOrg(projectId, session.organizationId)
  if (!project) throw new NotFoundError('Project not found')
  const current = await getProjectFolderAccess(session, projectId, project.collectionName)
  if (!current.isVisible(folderId)) throw new NotFoundError('Folder not found')
  // The level before the project ceiling: `project:manage` was asked above, and
  // a manager is who this change is for.
  if (current.levelOf(folderId) !== 'write') throw folderReadOnlyError()
  return project
}

async function livingFolder(organizationId: string, projectId: string, folderId: string) {
  const db = getDb()
  const [folder] = await withTenant({ organizationId }, () =>
    db
      .select({ name: projectFolders.name, accessMode: projectFolders.accessMode, everyoneReads: projectFolders.everyoneReads })
      .from(projectFolders)
      .where(and(eq(projectFolders.id, folderId), eq(projectFolders.projectId, projectId), isNull(projectFolders.deletedAt)))
      .limit(1)
  )
  if (!folder) throw new NotFoundError('Folder not found')
  return folder
}

/**
 * A folder's list as it is now, for whoever may change it: who holds a folder
 * role on it, read from WorkOS. Same authorization as {@link setFolderAccess}:
 * the names on a list are not for everyone who may open the folder.
 */
export async function getFolderAccess(
  session: AuthorizedSession,
  input: { projectId: string; folderId: string }
): Promise<FolderAccessSetting> {
  await requireListManager(session, input.projectId, input.folderId)
  const folder = await livingFolder(session.organizationId, input.projectId, input.folderId)
  if (folder.accessMode !== 'custom') return { mode: 'inherit' }
  const holders = await listFolderRoleHolders(session.organizationId, input.folderId)
  return {
    mode: 'custom',
    everyoneReads: folder.everyoneReads,
    people: holders.map((holder) => ({ userId: holder.userId, level: holder.level })),
  }
}

/**
 * Set a folder's access: inherit, or its own list. Needs `project:manage` and
 * write on the folder. Refuses someone not in the organization, a list that
 * names nobody and that everyone does not read, and a list that would put an
 * IFC model in a folder not every member may read.
 */
export async function setFolderAccess(
  session: AuthorizedSession,
  input: { projectId: string; folderId: string; access: FolderAccessSetting },
  request: Request
): Promise<FolderAccessResult> {
  const { organizationId } = session
  await requireListManager(session, input.projectId, input.folderId)
  const folder = await livingFolder(organizationId, input.projectId, input.folderId)
  const access = input.access
  const people = access.mode === 'custom' ? await resolvedPeople(organizationId, access) : null
  // Folders not every member may read do not hold IFC models until their
  // building data is partitioned (ADR-0087): refused before anything changes.
  await assertRestrictionKeepsIfcOpen(
    organizationId,
    input.projectId,
    input.folderId,
    access.mode === 'custom' ? access.everyoneReads : null
  )

  if (access.mode === 'custom' && people) {
    await ensureFolderResource(organizationId, input.projectId, input.folderId, folder.name)
    await replaceFolderRoleHolders(organizationId, input.folderId, people)
  }
  const db = getDb()
  const updated = await withTenant({ organizationId }, () =>
    db
      .update(projectFolders)
      .set({
        accessMode: access.mode,
        everyoneReads: access.mode === 'custom' && access.everyoneReads,
        accessChangedBy: session.userId,
        accessChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(projectFolders.id, input.folderId),
          eq(projectFolders.projectId, input.projectId),
          isNull(projectFolders.deletedAt)
        )
      )
      .returning({ id: projectFolders.id })
  )
  if (updated.length === 0) throw new NotFoundError('Folder not found')
  if (access.mode === 'inherit' && folder.accessMode === 'custom') {
    // The row already inherits, so nothing reads the folder roles any more; a
    // resource left behind by a failure here is harmless and is replaced the
    // next time the folder gets its own list.
    await removeFolderResource(organizationId, input.folderId).catch((error: unknown) => {
      console.warn(`[folder-access] folder ${input.folderId} inherits again; its WorkOS resource stays:`, error)
    })
  }

  const placement = await placeProjectDocuments(organizationId, input.projectId)
  const stored: FolderAccessSetting =
    access.mode === 'custom' && people
      ? { mode: 'custom', everyoneReads: access.everyoneReads, people: people.map(({ userId, level }) => ({ userId, level })) }
      : { mode: 'inherit' }
  await recordAuditEvent({
    organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'project.folder.access_changed',
    targetType: 'project',
    targetId: input.projectId,
    metadata: {
      folderId: input.folderId,
      mode: stored.mode,
      grants: describeAccess(stored),
      // Role-based lists named roles here; a list of people names none.
      roles: '',
      documentsMoved: placement.moved,
    },
    request,
  })
  return { folderId: input.folderId, access: stored, ...placement }
}
