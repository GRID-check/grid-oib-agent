/**
 * Who holds which folder role, kept in WorkOS (ADR-0096).
 *
 * A folder with its own access list is a WorkOS `folder` resource, registered
 * directly under its project, and access to it is a folder role assigned on it
 * to a person: `folder-reader` reads, `folder-editor` reads and writes. No
 * project role holds a `folder:*` permission, so being in the project grants
 * nothing on such a folder; that is how a folder is narrower than its project
 * without the exclusions WorkOS does not have. The walk over the folder's
 * ancestors, and whether everyone in the project reads it, stay in
 * `folder-access-rule.ts`.
 *
 * Every folder resource sits directly under its project, whatever the folder's
 * depth: WorkOS caps a hierarchy at five levels, refuses a folder type whose
 * parent is a folder (a cycle), and cannot move a resource to another parent.
 * Moving a folder inside its project therefore never touches WorkOS.
 *
 * Reads fail closed: a lookup that did not complete clears nothing, and is
 * never cached. Writes throw, and the caller decides what that means.
 */

import 'server-only'
import { getCached, invalidateCachedPrefix } from '@/lib/cache'
import { getWorkOS } from '@/lib/workos/client'
import { timedWorkOSCall } from '@/lib/workos/instrumentation'
import { authzCacheTtlMs } from './resource-check'
import { FOLDER_PERMISSIONS } from './permissions'
import type { FolderGrantLevel } from './folder-access-rule'

/** The WorkOS resource type of a folder with its own access list. */
export const FOLDER_RESOURCE_TYPE = 'folder'

/** The folder role that gives each level. */
export const FOLDER_ROLE_BY_LEVEL: Readonly<Record<FolderGrantLevel, string>> = {
  read: 'folder-reader',
  write: 'folder-editor',
}

/** One person on a folder's list: whom the folder role is assigned to, and which. */
export interface FolderRoleHolder {
  organizationMembershipId: string
  userId: string
  level: FolderGrantLevel
}

const levelsKey = (organizationId: string, organizationMembershipId: string) =>
  `authz:folder-levels:${organizationId}:${organizationMembershipId}:`

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404
}

async function folderIdsWith(
  organizationMembershipId: string,
  projectId: string,
  permissionSlug: string
): Promise<string[]> {
  const page = await timedWorkOSCall(`authorization.listResourcesForMembership ${permissionSlug}`, () =>
    getWorkOS().authorization.listResourcesForMembership({
      organizationMembershipId,
      permissionSlug,
      parentResourceTypeSlug: 'project',
      parentResourceExternalId: projectId,
    })
  )
  const resources = await page.autoPagination()
  return resources.filter((resource) => resource.resourceTypeSlug === FOLDER_RESOURCE_TYPE).map((resource) => resource.externalId)
}

/**
 * The level a membership holds on each folder of `projectId` that has its own
 * list, by the folder roles assigned to it there: two WorkOS calls, cached for
 * `GRID_AUTHZ_CACHE_TTL_MS` like every other FGA answer, and dropped by
 * {@link replaceFolderRoleHolders} for everyone whose roles it changed. Fails
 * closed: a lookup that did not complete holds nothing, and is not cached.
 */
export async function heldFolderLevels(
  organizationId: string,
  organizationMembershipId: string,
  projectId: string
): Promise<Record<string, FolderGrantLevel>> {
  const load = async (): Promise<Record<string, FolderGrantLevel>> => {
    const [readable, writable] = await Promise.all([
      folderIdsWith(organizationMembershipId, projectId, FOLDER_PERMISSIONS.read),
      folderIdsWith(organizationMembershipId, projectId, FOLDER_PERMISSIONS.write),
    ])
    const levels: Record<string, FolderGrantLevel> = {}
    for (const folderId of readable) levels[folderId] = 'read'
    for (const folderId of writable) levels[folderId] = 'write'
    return levels
  }
  const ttlMs = authzCacheTtlMs()
  try {
    if (ttlMs <= 0) return await load()
    return await getCached(`${levelsKey(organizationId, organizationMembershipId)}${projectId}`, ttlMs, load)
  } catch (error) {
    console.warn(`[authz] folder roles of ${organizationMembershipId} in project ${projectId} could not be read:`, error)
    return {}
  }
}

async function holdersWith(organizationId: string, folderId: string, permissionSlug: string) {
  const page = await timedWorkOSCall(`authorization.listMembershipsForResource ${permissionSlug}`, () =>
    getWorkOS().authorization.listMembershipsForResourceByExternalId({
      organizationId,
      resourceTypeSlug: FOLDER_RESOURCE_TYPE,
      externalId: folderId,
      permissionSlug,
      assignment: 'direct',
    })
  )
  return page.autoPagination()
}

/**
 * The people a folder role is assigned to on `folderId`, each at the level it
 * gives. Empty for a folder that is not registered. Throws when WorkOS cannot
 * be asked: the caller shows a list, and a wrong empty list is worse than an
 * error.
 */
export async function listFolderRoleHolders(organizationId: string, folderId: string): Promise<FolderRoleHolder[]> {
  try {
    const [readers, writers] = await Promise.all([
      holdersWith(organizationId, folderId, FOLDER_PERMISSIONS.read),
      holdersWith(organizationId, folderId, FOLDER_PERMISSIONS.write),
    ])
    const holders = new Map<string, FolderRoleHolder>()
    for (const membership of readers) {
      holders.set(membership.id, { organizationMembershipId: membership.id, userId: membership.userId, level: 'read' })
    }
    for (const membership of writers) {
      holders.set(membership.id, { organizationMembershipId: membership.id, userId: membership.userId, level: 'write' })
    }
    return [...holders.values()]
  } catch (error) {
    if (isNotFound(error)) return []
    throw error
  }
}

/** Registers `folderId` as a folder resource under its project, unless it already is. */
export async function ensureFolderResource(
  organizationId: string,
  projectId: string,
  folderId: string,
  name: string
): Promise<void> {
  const workos = getWorkOS()
  try {
    await timedWorkOSCall('authorization.getResourceByExternalId folder', () =>
      workos.authorization.getResourceByExternalId({ organizationId, resourceTypeSlug: FOLDER_RESOURCE_TYPE, externalId: folderId })
    )
    return
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  await timedWorkOSCall('authorization.createResource folder', () =>
    workos.authorization.createResource({
      resourceTypeSlug: FOLDER_RESOURCE_TYPE,
      externalId: folderId,
      organizationId,
      name,
      parentResourceTypeSlug: 'project',
      parentResourceExternalId: projectId,
    })
  )
}

/**
 * Makes the folder roles on `folderId` exactly `wanted`: removes every folder
 * role assignment not wanted (a changed level is a removal and an assignment),
 * then assigns what is missing. Removes first, so a failure part-way leaves a
 * list narrower than either the old or the new one, never wider. Drops the
 * cached levels of everyone it changed.
 */
export async function replaceFolderRoleHolders(
  organizationId: string,
  folderId: string,
  wanted: readonly { organizationMembershipId: string; level: FolderGrantLevel }[]
): Promise<void> {
  const workos = getWorkOS()
  const resource = { resourceExternalId: folderId, resourceTypeSlug: FOLDER_RESOURCE_TYPE }
  const current = await listFolderRoleHolders(organizationId, folderId)
  const wantedLevel = new Map(wanted.map((holder) => [holder.organizationMembershipId, holder.level]))
  const currentLevel = new Map(current.map((holder) => [holder.organizationMembershipId, holder.level]))
  const changed = new Set<string>()

  for (const holder of current) {
    if (wantedLevel.get(holder.organizationMembershipId) === holder.level) continue
    // A folder-editor also holds folder:read, so remove both roles' assignments
    // the membership may carry; removing one it does not hold is a 404.
    for (const roleSlug of Object.values(FOLDER_ROLE_BY_LEVEL)) {
      try {
        await timedWorkOSCall('authorization.removeRole folder', () =>
          workos.authorization.removeRole({ organizationMembershipId: holder.organizationMembershipId, roleSlug, ...resource })
        )
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    }
    changed.add(holder.organizationMembershipId)
  }
  for (const holder of wanted) {
    if (currentLevel.get(holder.organizationMembershipId) === holder.level) continue
    await timedWorkOSCall('authorization.assignRole folder', () =>
      workos.authorization.assignRole({
        organizationMembershipId: holder.organizationMembershipId,
        roleSlug: FOLDER_ROLE_BY_LEVEL[holder.level],
        ...resource,
      })
    )
    changed.add(holder.organizationMembershipId)
  }
  await Promise.all([...changed].map((membershipId) => invalidateCachedPrefix(levelsKey(organizationId, membershipId))))
}

/**
 * Removes `folderId`'s folder resource and every folder role on it: the folder
 * no longer has its own list. Already gone is not an error. Drops the cached
 * levels of everyone who held a role on it: the folder may get its own list
 * again within the cache period, and a level cached from the old list would
 * otherwise open it to someone the new list leaves out.
 */
export async function removeFolderResource(organizationId: string, folderId: string): Promise<void> {
  const holders = await listFolderRoleHolders(organizationId, folderId)
  try {
    await timedWorkOSCall('authorization.deleteResourceByExternalId folder', () =>
      getWorkOS().authorization.deleteResourceByExternalId({
        organizationId,
        resourceTypeSlug: FOLDER_RESOURCE_TYPE,
        externalId: folderId,
        cascadeDelete: true,
      })
    )
  } catch (error) {
    if (!isNotFound(error)) throw error
  }
  await Promise.all(
    holders.map((holder) => invalidateCachedPrefix(levelsKey(organizationId, holder.organizationMembershipId)))
  )
}
