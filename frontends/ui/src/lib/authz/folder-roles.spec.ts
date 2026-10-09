/**
 * @vitest-environment node
 *
 * Who holds which folder role, kept in WorkOS (ADR-0096): the read fails
 * closed and is never cached when it fails; the write removes before it
 * assigns; and every change of a list in a project starts a new generation of
 * the project's cached levels, failed or not, so no level read before the
 * change (or while it ran) is served after it.
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

/**
 * The cache as a plain map, with `@/lib/cache`'s semantics: a loader that
 * throws stores nothing, and a loader's value is stored when it resolves,
 * under the key it was asked for.
 */
const cached = new Map<string, unknown>()
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (key: string, _ttlMs: number, loader: () => Promise<unknown>) => {
    if (cached.has(key)) return cached.get(key)
    const value = await loader()
    cached.set(key, value)
    return value
  }),
  setCached: vi.fn(async (key: string, value: unknown) => {
    cached.set(key, value)
  }),
}))

import { getCached, setCached } from '@/lib/cache'
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
const GENERATION_KEY = `authz:folder-levels-generation:${ORG}:${PROJECT}`
/** The cached levels entries (not the generations). */
const levelKeys = () => [...cached.keys()].filter((key) => key.startsWith('authz:folder-levels:'))

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

  it('caches the answer per organization, membership and project, under the project’s generation', async () => {
    resourcesFor({ 'folder:read': [folder('f-1')] })

    await heldFolderLevels(ORG, 'om_1', PROJECT)
    await heldFolderLevels(ORG, 'om_1', PROJECT)
    expect(workos.listResourcesForMembership).toHaveBeenCalledTimes(2)
    const generation = cached.get(GENERATION_KEY)
    expect(generation).toEqual(expect.any(String))
    expect(levelKeys()).toEqual([`authz:folder-levels:${ORG}:${PROJECT}:${String(generation)}:om_1`])

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
    expect(levelKeys()).toEqual([])

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
    await replaceFolderRoleHolders(ORG, PROJECT, 'f-1', WANTED)

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
    await replaceFolderRoleHolders(ORG, PROJECT, 'f-1', WANTED)

    const lastRemove = Math.max(...workos.removeRole.mock.invocationCallOrder)
    const firstAssign = Math.min(...workos.assignRole.mock.invocationCallOrder)
    expect(lastRemove).toBeLessThan(firstAssign)
  })

  it('stops before assigning when a removal fails for another reason than not holding the role', async () => {
    workos.removeRole.mockRejectedValueOnce(serverError())

    await expect(replaceFolderRoleHolders(ORG, PROJECT, 'f-1', WANTED)).rejects.toThrow('Internal Server Error')
    expect(workos.assignRole).not.toHaveBeenCalled()
  })

  it('takes a 404 on a removal as a role the membership did not hold', async () => {
    // A folder-reader holds no folder-editor assignment to remove, and the reverse.
    workos.removeRole.mockImplementation(async ({ roleSlug, organizationMembershipId }) => {
      const held = organizationMembershipId === 'om_b' ? 'folder-editor' : 'folder-reader'
      if (roleSlug !== held) throw notFound()
    })

    await expect(replaceFolderRoleHolders(ORG, PROJECT, 'f-1', WANTED)).resolves.toBeUndefined()
    expect(workos.assignRole).toHaveBeenCalledTimes(2)
  })

  it('serves no level cached before the change, to anyone in the project, and leaves other projects’ alone', async () => {
    resourcesFor({ 'folder:read': [folder('f-1')] })
    for (const membership of ['om_a', 'om_b', 'om_c', 'om_e']) await heldFolderLevels(ORG, membership, PROJECT)
    await heldFolderLevels(ORG, 'om_c', 'proj_2')
    const asked = workos.listResourcesForMembership.mock.calls.length
    resourcesFor({})

    await replaceFolderRoleHolders(ORG, PROJECT, 'f-1', WANTED)

    // Unchanged (a), changed (b), removed (c), untouched (e): every one asks WorkOS again.
    for (const membership of ['om_a', 'om_b', 'om_c', 'om_e']) {
      expect(await heldFolderLevels(ORG, membership, PROJECT), membership).toEqual({})
    }
    expect(workos.listResourcesForMembership.mock.calls.length).toBe(asked + 8)
    // Another project's cached level is still served.
    expect(await heldFolderLevels(ORG, 'om_c', 'proj_2')).toEqual({ 'f-1': 'read' })
    expect(workos.listResourcesForMembership.mock.calls.length).toBe(asked + 8)
  })

  it('changes nothing in WorkOS when the list is already what is wanted, and still starts a new generation', async () => {
    await replaceFolderRoleHolders(ORG, PROJECT, 'f-1', [
      { organizationMembershipId: 'om_a', level: 'read' },
      { organizationMembershipId: 'om_b', level: 'write' },
      { organizationMembershipId: 'om_c', level: 'read' },
    ])

    expect(workos.removeRole).not.toHaveBeenCalled()
    expect(workos.assignRole).not.toHaveBeenCalled()
    expect(setCached).toHaveBeenCalledWith(GENERATION_KEY, expect.any(String), expect.any(Number))
  })

  it('assigns the role of each level', async () => {
    holdersFor({})
    await replaceFolderRoleHolders(ORG, PROJECT, 'f-1', [
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
  it('serves no level cached before it, so a new list cannot be overruled by an old level', async () => {
    resourcesFor({ 'folder:write': [folder('f-1')], 'folder:read': [folder('f-1')] })
    expect(await heldFolderLevels(ORG, 'om-a', PROJECT)).toEqual({ 'f-1': 'write' })
    resourcesFor({})
    workos.deleteResourceByExternalId.mockResolvedValue(undefined)

    await removeFolderResource(ORG, PROJECT, 'f-1')

    expect(await heldFolderLevels(ORG, 'om-a', PROJECT)).toEqual({})
  })

  it('deletes the resource and every role on it', async () => {
    workos.deleteResourceByExternalId.mockResolvedValue(undefined)

    await removeFolderResource(ORG, PROJECT, 'f-1')

    expect(workos.deleteResourceByExternalId).toHaveBeenCalledWith({
      organizationId: ORG,
      resourceTypeSlug: 'folder',
      externalId: 'f-1',
      cascadeDelete: true,
    })
  })

  it('tolerates a resource that is already gone', async () => {
    workos.deleteResourceByExternalId.mockRejectedValue(notFound())
    await expect(removeFolderResource(ORG, PROJECT, 'f-1')).resolves.toBeUndefined()
  })

  it('throws any other failure', async () => {
    workos.deleteResourceByExternalId.mockRejectedValue(serverError())
    await expect(removeFolderResource(ORG, PROJECT, 'f-1')).rejects.toThrow('Internal Server Error')
  })
})

/**
 * The races a cache of WorkOS answers has to survive, against a fake WorkOS
 * that keeps its assignments: a level read in flight while a list changes, and
 * a change that fails part-way. Each asks for the right outcome: nobody taken
 * off a list keeps a level from before.
 */
describe('a list change against levels read before or while it ran', () => {
  /** folderId → membership → role slugs. */
  const assignments = new Map<string, Map<string, Set<string>>>()
  const PERMISSIONS: Record<string, string[]> = {
    'folder-reader': ['folder:read'],
    'folder-editor': ['folder:read', 'folder:write'],
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  /** While set, a level read has taken WorkOS's answer and waits here before returning it. */
  let gate: Promise<void> | null = null
  const holds = (roles: Iterable<string>, permissionSlug: string) =>
    [...roles].some((role) => PERMISSIONS[role]?.includes(permissionSlug))

  function assign(folderId: string, membershipId: string, roleSlug: string) {
    const byMembership = assignments.get(folderId) ?? new Map<string, Set<string>>()
    assignments.set(folderId, byMembership)
    byMembership.set(membershipId, new Set([...(byMembership.get(membershipId) ?? []), roleSlug]))
  }

  beforeEach(() => {
    assignments.clear()
    gate = null
    workos.listResourcesForMembership.mockImplementation(
      async ({ organizationMembershipId, permissionSlug }: { organizationMembershipId: string; permissionSlug: string }) => {
        const answer = [...assignments]
          .filter(([, byMembership]) => holds(byMembership.get(organizationMembershipId) ?? [], permissionSlug))
          .map(([externalId]) => folder(externalId))
        if (gate) await gate
        return page(answer)
      }
    )
    workos.listMembershipsForResourceByExternalId.mockImplementation(
      async ({ externalId, permissionSlug }: { externalId: string; permissionSlug: string }) =>
        page(
          [...(assignments.get(externalId) ?? new Map<string, Set<string>>())]
            .filter(([, roles]) => holds(roles, permissionSlug))
            .map(([id]) => ({ id, userId: `user_${id}` }))
        )
    )
    workos.removeRole.mockImplementation(
      async ({ organizationMembershipId, roleSlug, resourceExternalId }: Record<string, string>) => {
        const roles = assignments.get(resourceExternalId)?.get(organizationMembershipId)
        if (!roles?.has(roleSlug)) throw notFound()
        roles.delete(roleSlug)
        if (roles.size === 0) assignments.get(resourceExternalId)?.delete(organizationMembershipId)
      }
    )
    workos.assignRole.mockImplementation(
      async ({ organizationMembershipId, roleSlug, resourceExternalId }: Record<string, string>) => {
        assign(resourceExternalId, organizationMembershipId, roleSlug)
      }
    )
    workos.deleteResourceByExternalId.mockImplementation(async ({ externalId }: { externalId: string }) => {
      assignments.delete(externalId)
    })
  })

  /** Starts A's level read, lets it take WorkOS's answer, and holds it there until released. */
  async function readInFlight() {
    let release!: () => void
    gate = new Promise<void>((resolve) => (release = resolve))
    const reading = heldFolderLevels(ORG, 'om_a', PROJECT)
    await tick()
    return {
      finish: async () => {
        gate = null
        release()
        return reading
      },
    }
  }

  it.each([
    ['a replace that takes them off', () => replaceFolderRoleHolders(ORG, PROJECT, 'F', [{ organizationMembershipId: 'om_b', level: 'write' }])],
    ['the folder going back to inherit', () => removeFolderResource(ORG, PROJECT, 'F')],
  ])('does not serve a level read in flight during %s', async (_label, change) => {
    assign('F', 'om_a', 'folder-editor')
    const read = await readInFlight()

    await change()
    // The read took its answer before the change, and is stored now.
    expect(await read.finish()).toEqual({ F: 'write' })

    const asked = workos.listResourcesForMembership.mock.calls.length
    expect(await heldFolderLevels(ORG, 'om_a', PROJECT)).toEqual({})
    expect(workos.listResourcesForMembership.mock.calls.length).toBe(asked + 2)
  })

  it('serves no removed level after a replace that failed part-way, removal done and assignment refused', async () => {
    assign('F', 'om_a', 'folder-editor')
    expect(await heldFolderLevels(ORG, 'om_a', PROJECT)).toEqual({ F: 'write' })
    workos.assignRole.mockRejectedValueOnce(serverError())

    await expect(
      replaceFolderRoleHolders(ORG, PROJECT, 'F', [{ organizationMembershipId: 'om_b', level: 'write' }])
    ).rejects.toThrow('Internal Server Error')

    // A's roles are gone in WorkOS; the cached `write` from before is not served.
    expect(assignments.get('F')?.has('om_a') ?? false).toBe(false)
    expect(await heldFolderLevels(ORG, 'om_a', PROJECT)).toEqual({})
  })

  it('starts a new generation when the resource could not be removed, too', async () => {
    assign('F', 'om_a', 'folder-editor')
    expect(await heldFolderLevels(ORG, 'om_a', PROJECT)).toEqual({ F: 'write' })
    const before = cached.get(GENERATION_KEY)
    workos.deleteResourceByExternalId.mockRejectedValueOnce(serverError())

    await expect(removeFolderResource(ORG, PROJECT, 'F')).rejects.toThrow('Internal Server Error')

    expect(cached.get(GENERATION_KEY)).not.toEqual(before)
    const asked = workos.listResourcesForMembership.mock.calls.length
    await heldFolderLevels(ORG, 'om_a', PROJECT)
    expect(workos.listResourcesForMembership.mock.calls.length).toBe(asked + 2)
  })
})
