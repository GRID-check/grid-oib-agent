/**
 * @vitest-environment node
 *
 * Who holds which folder role, kept in WorkOS (ADR-0096): the read fails
 * closed and is never cached when it fails, the write removes before it
 * assigns and drops exactly the cached levels it changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const workos = {
  listResourcesForMembership: vi.fn(),
  listMembershipsForResourceByExternalId: vi.fn(),
  getResourceByExternalId: vi.fn(),
  createResource: vi.fn(),
  removeRole: vi.fn(),
  assignRole: vi.fn(),
  deleteResourceByExternalId: vi.fn(),
}
vi.mock('@/lib/workos/client', () => ({ getWorkOS: () => ({ authorization: workos }) }))

/** The cache as a plain map: a loader that throws stores nothing, as in `@/lib/cache`. */
const cached = new Map<string, unknown>()
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (key: string, _ttlMs: number, loader: () => Promise<unknown>) => {
    if (cached.has(key)) return cached.get(key)
    const value = await loader()
    cached.set(key, value)
    return value
  }),
  invalidateCachedPrefix: vi.fn(async (prefix: string) => {
    for (const key of [...cached.keys()]) if (key.startsWith(prefix)) cached.delete(key)
  }),
}))

import { getCached, invalidateCachedPrefix } from '@/lib/cache'
import {
  ensureFolderResource,
  FOLDER_ROLE_BY_LEVEL,
  heldFolderLevels,
  listFolderRoleHolders,
  removeFolderResource,
  replaceFolderRoleHolders,
} from './folder-roles'

const ORG = 'org_1'
const PROJECT = 'proj_1'

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 })
const serverError = () => Object.assign(new Error('Internal Server Error'), { status: 500 })

/** One page of a WorkOS list, as the SDK hands it back. */
const page = <T>(items: T[]) => ({ autoPagination: async () => items })
const folder = (externalId: string) => ({ externalId, resourceTypeSlug: 'folder' })

/** `listResourcesForMembership` answering per permission slug. */
function resourcesFor(byPermission: Record<string, Array<{ externalId: string; resourceTypeSlug: string }>>) {
  workos.listResourcesForMembership.mockImplementation(async ({ permissionSlug }: { permissionSlug: string }) =>
    page(byPermission[permissionSlug] ?? [])
  )
}

/** `listMembershipsForResourceByExternalId` answering per permission slug. */
function holdersFor(byPermission: Record<string, Array<{ id: string; userId: string }>>) {
  workos.listMembershipsForResourceByExternalId.mockImplementation(
    async ({ permissionSlug }: { permissionSlug: string }) => page(byPermission[permissionSlug] ?? [])
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const fn of Object.values(workos)) fn.mockReset()
  cached.clear()
  delete process.env.GRID_AUTHZ_CACHE_TTL_MS
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('heldFolderLevels', () => {
  it('maps each folder to the level its folder role gives; write wins over read', async () => {
    resourcesFor({
      'folder:read': [folder('f-read'), folder('f-both')],
      'folder:write': [folder('f-both'), folder('f-write')],
    })

    expect(await heldFolderLevels(ORG, 'om_1', PROJECT)).toEqual({
      'f-read': 'read',
      'f-both': 'write',
      'f-write': 'write',
    })
  })

  it('asks for both permissions, under the project', async () => {
    resourcesFor({})
    await heldFolderLevels(ORG, 'om_1', PROJECT)

    expect(workos.listResourcesForMembership).toHaveBeenCalledTimes(2)
    for (const permissionSlug of ['folder:read', 'folder:write']) {
      expect(workos.listResourcesForMembership).toHaveBeenCalledWith({
        organizationMembershipId: 'om_1',
        permissionSlug,
        parentResourceTypeSlug: 'project',
        parentResourceExternalId: PROJECT,
      })
    }
  })

  it('ignores a resource that is not a folder', async () => {
    resourcesFor({
      'folder:read': [folder('f-1'), { externalId: 'skill-1', resourceTypeSlug: 'skill' }],
      'folder:write': [{ externalId: PROJECT, resourceTypeSlug: 'project' }],
    })

    expect(await heldFolderLevels(ORG, 'om_1', PROJECT)).toEqual({ 'f-1': 'read' })
  })

  it('caches the answer per organization, membership and project', async () => {
    resourcesFor({ 'folder:read': [folder('f-1')] })

    await heldFolderLevels(ORG, 'om_1', PROJECT)
    await heldFolderLevels(ORG, 'om_1', PROJECT)
    expect(workos.listResourcesForMembership).toHaveBeenCalledTimes(2)
    expect([...cached.keys()]).toEqual([`authz:folder-levels:${ORG}:om_1:${PROJECT}`])

    await heldFolderLevels(ORG, 'om_1', 'proj_2')
    await heldFolderLevels(ORG, 'om_2', PROJECT)
    await heldFolderLevels('org_2', 'om_1', PROJECT)
    expect(workos.listResourcesForMembership).toHaveBeenCalledTimes(8)
  })

  it('asks WorkOS every time when the authz cache is switched off', async () => {
    process.env.GRID_AUTHZ_CACHE_TTL_MS = '0'
    resourcesFor({ 'folder:read': [folder('f-1')] })

    await heldFolderLevels(ORG, 'om_1', PROJECT)
    await heldFolderLevels(ORG, 'om_1', PROJECT)

    expect(getCached).not.toHaveBeenCalled()
    expect(workos.listResourcesForMembership).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['the call is refused', () => workos.listResourcesForMembership.mockRejectedValueOnce(serverError())],
    [
      'a later page fails',
      () =>
        workos.listResourcesForMembership.mockResolvedValueOnce({
          autoPagination: async () => {
            throw new Error('socket hang up')
          },
        }),
    ],
  ])('fails closed to no level when %s, and does not cache it', async (_label, fail) => {
    resourcesFor({ 'folder:read': [folder('f-1')], 'folder:write': [folder('f-2')] })
    fail()

    expect(await heldFolderLevels(ORG, 'om_1', PROJECT)).toEqual({})
    expect(cached.size).toBe(0)

    // The next request asks again, and gets the real answer.
    expect(await heldFolderLevels(ORG, 'om_1', PROJECT)).toEqual({ 'f-1': 'read', 'f-2': 'write' })
  })
})

describe('listFolderRoleHolders', () => {
  it('lists each person once, at the level their folder role gives', async () => {
    holdersFor({
      'folder:read': [
        { id: 'om_a', userId: 'user_a' },
        { id: 'om_b', userId: 'user_b' },
      ],
      'folder:write': [{ id: 'om_b', userId: 'user_b' }],
    })

    expect(await listFolderRoleHolders(ORG, 'f-1')).toEqual([
      { organizationMembershipId: 'om_a', userId: 'user_a', level: 'read' },
      { organizationMembershipId: 'om_b', userId: 'user_b', level: 'write' },
    ])
    expect(workos.listMembershipsForResourceByExternalId).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, resourceTypeSlug: 'folder', externalId: 'f-1', assignment: 'direct' })
    )
  })

  it('is empty for a folder that is not registered, and throws when WorkOS cannot be asked', async () => {
    workos.listMembershipsForResourceByExternalId.mockRejectedValue(notFound())
    expect(await listFolderRoleHolders(ORG, 'f-1')).toEqual([])

    workos.listMembershipsForResourceByExternalId.mockRejectedValue(serverError())
    await expect(listFolderRoleHolders(ORG, 'f-1')).rejects.toThrow('Internal Server Error')
  })
})

describe('replaceFolderRoleHolders', () => {
  beforeEach(() => {
    // Now: a reads, b writes, c reads.
    holdersFor({
      'folder:read': [
        { id: 'om_a', userId: 'user_a' },
        { id: 'om_b', userId: 'user_b' },
        { id: 'om_c', userId: 'user_c' },
      ],
      'folder:write': [{ id: 'om_b', userId: 'user_b' }],
    })
    workos.removeRole.mockResolvedValue(undefined)
    workos.assignRole.mockResolvedValue(undefined)
  })

  const WANTED = [
    { organizationMembershipId: 'om_a', level: 'read' as const }, // unchanged
    { organizationMembershipId: 'om_b', level: 'read' as const }, // write → read
    { organizationMembershipId: 'om_d', level: 'write' as const }, // new
  ] // c leaves

  it('removes the unwanted and the changed, assigns the changed and the new, and leaves the rest alone', async () => {
    await replaceFolderRoleHolders(ORG, 'f-1', WANTED)

    const removed = workos.removeRole.mock.calls.map(([call]) => `${call.organizationMembershipId}:${call.roleSlug}`)
    expect(removed.sort()).toEqual(
      ['om_b:folder-reader', 'om_b:folder-editor', 'om_c:folder-reader', 'om_c:folder-editor'].sort()
    )
    expect(workos.assignRole.mock.calls.map(([call]) => call)).toEqual([
      { organizationMembershipId: 'om_b', roleSlug: 'folder-reader', resourceExternalId: 'f-1', resourceTypeSlug: 'folder' },
      { organizationMembershipId: 'om_d', roleSlug: 'folder-editor', resourceExternalId: 'f-1', resourceTypeSlug: 'folder' },
    ])
    for (const [call] of workos.removeRole.mock.calls) {
      expect(call).toMatchObject({ resourceExternalId: 'f-1', resourceTypeSlug: 'folder' })
    }
  })

  it('removes every role before it assigns any: a failure part-way is never wider than either list', async () => {
    await replaceFolderRoleHolders(ORG, 'f-1', WANTED)

    const lastRemove = Math.max(...workos.removeRole.mock.invocationCallOrder)
    const firstAssign = Math.min(...workos.assignRole.mock.invocationCallOrder)
    expect(lastRemove).toBeLessThan(firstAssign)
  })

  it('stops before assigning when a removal fails for another reason than not holding the role', async () => {
    workos.removeRole.mockRejectedValueOnce(serverError())

    await expect(replaceFolderRoleHolders(ORG, 'f-1', WANTED)).rejects.toThrow('Internal Server Error')
    expect(workos.assignRole).not.toHaveBeenCalled()
  })

  it('takes a 404 on a removal as a role the membership did not hold', async () => {
    // A folder-reader holds no folder-editor assignment to remove, and the reverse.
    workos.removeRole.mockImplementation(async ({ roleSlug, organizationMembershipId }) => {
      const held = organizationMembershipId === 'om_b' ? 'folder-editor' : 'folder-reader'
      if (roleSlug !== held) throw notFound()
    })

    await expect(replaceFolderRoleHolders(ORG, 'f-1', WANTED)).resolves.toBeUndefined()
    expect(workos.assignRole).toHaveBeenCalledTimes(2)
  })

  it('drops the cached levels of exactly the memberships it changed', async () => {
    for (const membership of ['om_a', 'om_b', 'om_c', 'om_d', 'om_e']) {
      cached.set(`authz:folder-levels:${ORG}:${membership}:${PROJECT}`, {})
    }
    cached.set(`authz:folder-levels:org_2:om_b:${PROJECT}`, {})

    await replaceFolderRoleHolders(ORG, 'f-1', WANTED)

    expect(vi.mocked(invalidateCachedPrefix).mock.calls.map(([prefix]) => prefix).sort()).toEqual([
      `authz:folder-levels:${ORG}:om_b:`,
      `authz:folder-levels:${ORG}:om_c:`,
      `authz:folder-levels:${ORG}:om_d:`,
    ])
    expect([...cached.keys()].sort()).toEqual(
      [
        `authz:folder-levels:${ORG}:om_a:${PROJECT}`,
        `authz:folder-levels:${ORG}:om_e:${PROJECT}`,
        `authz:folder-levels:org_2:om_b:${PROJECT}`,
      ].sort()
    )
  })

  it('changes nothing, and drops nothing, when the list is already what is wanted', async () => {
    await replaceFolderRoleHolders(ORG, 'f-1', [
      { organizationMembershipId: 'om_a', level: 'read' },
      { organizationMembershipId: 'om_b', level: 'write' },
      { organizationMembershipId: 'om_c', level: 'read' },
    ])

    expect(workos.removeRole).not.toHaveBeenCalled()
    expect(workos.assignRole).not.toHaveBeenCalled()
    expect(invalidateCachedPrefix).not.toHaveBeenCalled()
  })

  it('assigns the role of each level', async () => {
    holdersFor({})
    await replaceFolderRoleHolders(ORG, 'f-1', [
      { organizationMembershipId: 'om_r', level: 'read' },
      { organizationMembershipId: 'om_w', level: 'write' },
    ])

    expect(workos.assignRole.mock.calls.map(([call]) => call.roleSlug)).toEqual([
      FOLDER_ROLE_BY_LEVEL.read,
      FOLDER_ROLE_BY_LEVEL.write,
    ])
    expect(FOLDER_ROLE_BY_LEVEL).toEqual({ read: 'folder-reader', write: 'folder-editor' })
  })
})

describe('ensureFolderResource', () => {
  it('creates nothing when the folder is already registered', async () => {
    workos.getResourceByExternalId.mockResolvedValue({ id: 'res_1' })

    await ensureFolderResource(ORG, PROJECT, 'f-1', 'Verträge')

    expect(workos.getResourceByExternalId).toHaveBeenCalledWith({
      organizationId: ORG,
      resourceTypeSlug: 'folder',
      externalId: 'f-1',
    })
    expect(workos.createResource).not.toHaveBeenCalled()
  })

  it('creates it under its project on a 404', async () => {
    workos.getResourceByExternalId.mockRejectedValue(notFound())

    await ensureFolderResource(ORG, PROJECT, 'f-1', 'Verträge')

    expect(workos.createResource).toHaveBeenCalledWith({
      resourceTypeSlug: 'folder',
      externalId: 'f-1',
      organizationId: ORG,
      name: 'Verträge',
      parentResourceTypeSlug: 'project',
      parentResourceExternalId: PROJECT,
    })
  })

  it('creates nothing, and throws, when the lookup fails for another reason', async () => {
    workos.getResourceByExternalId.mockRejectedValue(serverError())

    await expect(ensureFolderResource(ORG, PROJECT, 'f-1', 'Verträge')).rejects.toThrow('Internal Server Error')
    expect(workos.createResource).not.toHaveBeenCalled()
  })
})

describe('removeFolderResource', () => {
  beforeEach(() => holdersFor({}))

  it('drops the cached levels of everyone who held a role on it, so a new list cannot be overruled by an old level', async () => {
    holdersFor({ 'folder:read': [{ id: 'om-a', userId: 'u-a' }], 'folder:write': [{ id: 'om-a', userId: 'u-a' }] })
    cached.set(`authz:folder-levels:${ORG}:om-a:${PROJECT}`, { 'f-1': 'write' })
    cached.set(`authz:folder-levels:${ORG}:om-b:${PROJECT}`, { 'f-2': 'read' })
    workos.deleteResourceByExternalId.mockResolvedValue(undefined)

    await removeFolderResource(ORG, 'f-1')

    expect(cached.has(`authz:folder-levels:${ORG}:om-a:${PROJECT}`)).toBe(false)
    expect(cached.has(`authz:folder-levels:${ORG}:om-b:${PROJECT}`)).toBe(true)
  })

  it('deletes the resource and every role on it', async () => {
    workos.deleteResourceByExternalId.mockResolvedValue(undefined)

    await removeFolderResource(ORG, 'f-1')

    expect(workos.deleteResourceByExternalId).toHaveBeenCalledWith({
      organizationId: ORG,
      resourceTypeSlug: 'folder',
      externalId: 'f-1',
      cascadeDelete: true,
    })
  })

  it('tolerates a resource that is already gone', async () => {
    workos.deleteResourceByExternalId.mockRejectedValue(notFound())
    await expect(removeFolderResource(ORG, 'f-1')).resolves.toBeUndefined()
  })

  it('throws any other failure', async () => {
    workos.deleteResourceByExternalId.mockRejectedValue(serverError())
    await expect(removeFolderResource(ORG, 'f-1')).rejects.toThrow('Internal Server Error')
  })
})
