/**
 * @vitest-environment node
 *
 * Setting a folder's own read/write list (ADR-0088, ADR-0096): people, each
 * with read or write, and optionally everyone reading. Validated against the
 * organization's members, written to WorkOS BEFORE the folder row says
 * `custom` and the row back to `inherit` BEFORE the WorkOS resource goes, so
 * no moment between the old list and the new one is wider than either. All of
 * it inside one transaction that first takes a lock on the folder, so two
 * saves of one folder run one after the other; the folder's old role grants
 * go in the same transaction. Audited in the shape the role-based lists wrote, and refused before anything
 * is written when it would put an IFC model in a folder not every member may
 * read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Every write, in the order it happened: what the ordering tests read. */
const events = vi.hoisted(() => [] as string[])
const state = vi.hoisted(() => ({
  folder: { name: 'Pläne', accessMode: 'inherit', everyoneReads: false } as {
    name: string
    accessMode: 'inherit' | 'custom'
    everyoneReads: boolean
  } | null,
  updatedRows: [{ id: 'plaene' }] as Array<{ id: string }>,
  updates: [] as Array<Record<string, unknown>>,
  /** The params of each grants delete's condition. */
  grantDeletes: [] as string[][],
  grantsTable: null as unknown,
}))

vi.mock('@/lib/authz/folder-access', async () => (await import('@/test-utils/folder-access')).openFolderAccessModule())
vi.mock('@/lib/authz/folder-access-repository', () => ({
  projectHasCustomOrBinnedFolders: vi.fn(async () => false),
  listProjectFolderTree: vi.fn(async () => [
    { id: 'modelle', parentId: null, accessMode: 'inherit', everyoneReads: false },
    { id: 'plaene', parentId: null, accessMode: 'inherit', everyoneReads: false },
  ]),
  countIfcDocumentsInFolders: vi.fn(async () => 0),
}))
vi.mock('@/lib/authz/folder-roles', () => ({
  ensureFolderResource: vi.fn(async () => {
    events.push('workos:ensure')
  }),
  replaceFolderRoleHolders: vi.fn(async () => {
    events.push('workos:replace')
  }),
  removeFolderResource: vi.fn(async () => {
    events.push('workos:remove')
  }),
  listFolderRoleHolders: vi.fn(async () => []),
}))
/** The organization's members: `user-<x>` is membership `om-<x>`; `user-ghost` is nobody. */
vi.mock('@/lib/authz/project-membership', () => ({
  resolveSubjectMembership: vi.fn(async (_org: string, userId: string) =>
    userId === 'user-ghost' ? null : { organizationMembershipId: userId.replace(/^user-/, 'om-'), role: 'member' }
  ),
}))
vi.mock('./ifc-folder-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ifc-folder-guard')>()
  // The real guard, observed: it runs the decision's pure core over the would-be tree.
  return { ...actual, assertRestrictionKeepsIfcOpen: vi.fn(actual.assertRestrictionKeepsIfcOpen) }
})
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn(async () => undefined) }))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(async () => ({ id: 'proj-1', collectionName: 'proj_1' })),
}))
vi.mock('./collection-placement', () => ({
  placeProjectDocuments: vi.fn(async () => {
    events.push('place')
    return { moved: 2, failed: [], pending: 0 }
  }),
}))
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: vi.fn(async () => {
    events.push('audit')
  }),
}))
/**
 * The database: the folder read outside the transaction, and inside it the
 * advisory lock (a real mutex per key, held until the transaction ends), the
 * row update and the grants delete, each recorded in `events`.
 */
vi.mock('@/lib/db', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core')
  const dialect = new PgDialect()
  const held = new Map<string, Promise<void>>()
  const render = (query: unknown) => dialect.sqlToQuery(query as Parameters<typeof dialect.sqlToQuery>[0])
  return {
    getDb: () => ({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => (state.folder ? [state.folder] : []) }) }),
      }),
      transaction: async <T,>(run: (tx: unknown) => Promise<T>): Promise<T> => {
        const releases: Array<() => void> = []
        const tx = {
          execute: async (query: unknown) => {
            const { sql: text, params } = render(query)
            if (!text.includes('pg_advisory_xact_lock')) throw new Error(`unexpected statement: ${text}`)
            const key = String(params[0])
            while (held.has(key)) await held.get(key)
            let release!: () => void
            held.set(key, new Promise<void>((resolve) => (release = resolve)))
            releases.push(() => {
              held.delete(key)
              release()
            })
            events.push(`lock:${key}`)
          },
          update: () => ({
            set: (values: Record<string, unknown>) => ({
              where: () => ({
                returning: async () => {
                  events.push(`row:${String(values.accessMode)}`)
                  state.updates.push(values)
                  return state.updatedRows
                },
              }),
            }),
          }),
          delete: (table: unknown) => ({
            where: async (condition: unknown) => {
              if (table !== state.grantsTable) throw new Error('unexpected delete')
              events.push('grants:deleted')
              state.grantDeletes.push(render(condition).params.map(String))
            },
          }),
        }
        try {
          return await run(tx)
        } finally {
          events.push('tx:end')
          for (const release of releases) release()
        }
      },
    }),
  }
})
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: (_scope: unknown, run: () => unknown) => run(),
}))
vi.mock('@/lib/db/schema', () => ({
  projectFolders: {
    id: 'folders.id',
    projectId: 'folders.project_id',
    deletedAt: 'folders.deleted_at',
    name: 'folders.name',
    accessMode: 'folders.access_mode',
    everyoneReads: 'folders.everyone_reads',
  },
  projectFolderGrants: { folderId: 'grants.folder_id' },
}))

import { BadRequestError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import {
  computeFolderAccess,
  getProjectFolderAccess,
  type AccessFolder,
  type FolderGrantLevel,
} from '@/lib/authz/folder-access'
import { countIfcDocumentsInFolders } from '@/lib/authz/folder-access-repository'
import {
  ensureFolderResource,
  listFolderRoleHolders,
  removeFolderResource,
  replaceFolderRoleHolders,
} from '@/lib/authz/folder-roles'
import { requireProjectAccess } from '@/lib/authz/projects'
import { placeProjectDocuments } from './collection-placement'
import {
  describeAccess,
  FOLDER_ACCESS_MAX_PEOPLE,
  getFolderAccess,
  setFolderAccess,
  type FolderAccessSetting,
} from './folder-access-settings'
import { assertRestrictionKeepsIfcOpen } from './ifc-folder-guard'
import { projectFolderGrants } from '@/lib/db/schema'

const LOCK = 'lock:folder_access:org-1:plaene'

const SESSION = { organizationId: 'org-1', userId: 'user-1', email: 'a@b.c' } as never
const request = () => new Request('http://x')

const custom = (people: Array<{ userId: string; level: FolderGrantLevel }>, everyoneReads = false) => ({
  projectId: 'proj-1',
  folderId: 'plaene',
  access: { mode: 'custom' as const, everyoneReads, people },
})
const inherit = { projectId: 'proj-1', folderId: 'plaene', access: { mode: 'inherit' as const } }

beforeEach(() => {
  vi.clearAllMocks()
  events.length = 0
  state.folder = { name: 'Pläne', accessMode: 'inherit', everyoneReads: false }
  state.updatedRows = [{ id: 'plaene' }]
  state.updates = []
  state.grantDeletes = []
  state.grantsTable = projectFolderGrants
})

/** Nothing was written anywhere: not WorkOS, not the row, not the audit trail. */
function writesNothing() {
  expect(events).toEqual([])
  expect(ensureFolderResource).not.toHaveBeenCalled()
  expect(replaceFolderRoleHolders).not.toHaveBeenCalled()
  expect(removeFolderResource).not.toHaveBeenCalled()
  expect(state.updates).toEqual([])
  expect(state.grantDeletes).toEqual([])
  expect(recordAuditEvent).not.toHaveBeenCalled()
  expect(placeProjectDocuments).not.toHaveBeenCalled()
}

/** Plaene has a list of its own, on which the manager holds `level` (or nothing). */
function asManager(level: FolderGrantLevel | null, seesEverything = false) {
  const tree: AccessFolder[] = [
    { id: 'plaene', parentId: null, accessMode: 'custom', everyoneReads: false },
    { id: 'modelle', parentId: null, accessMode: 'inherit', everyoneReads: false },
  ]
  const levels: Record<string, FolderGrantLevel> = level ? { plaene: level } : {}
  vi.mocked(getProjectFolderAccess).mockResolvedValueOnce(computeFolderAccess(tree, { levels, seesEverything }, 'proj_1'))
}

describe('setFolderAccess: who may change a list', () => {
  it('needs project:manage before it reads anything', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError('Project not found'))

    await expect(setFolderAccess(SESSION, custom([{ userId: 'user-a', level: 'read' }]), request())).rejects.toBeInstanceOf(
      NotFoundError
    )
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, 'proj-1', 'project:manage')
    expect(getProjectFolderAccess).not.toHaveBeenCalled()
    writesNothing()
  })

  it('answers a folder the manager may not read like a missing one, and writes nothing', async () => {
    asManager(null)

    await expect(setFolderAccess(SESSION, inherit, request())).rejects.toBeInstanceOf(NotFoundError)
    writesNothing()
  })

  it('refuses a project manager who may only read the folder, with a typed 403, and writes nothing', async () => {
    asManager('read')

    const error = await setFolderAccess(SESSION, custom([{ userId: 'user-1', level: 'write' }]), request()).catch(
      (caught: unknown) => caught
    )

    expect(error).toMatchObject({ status: 403, details: { reason: 'folder-read-only' } })
    writesNothing()
  })

  it('lets a manager who may write the folder change it', async () => {
    asManager('write')
    await setFolderAccess(SESSION, custom([{ userId: 'user-1', level: 'write' }]), request())
    expect(state.updates[0]).toMatchObject({ accessMode: 'custom' })
  })

  it('lets an organization admin change it, whoever is on its list', async () => {
    asManager(null, true)
    await setFolderAccess(SESSION, custom([{ userId: 'user-a', level: 'write' }]), request())
    expect(state.updates[0]).toMatchObject({ accessMode: 'custom' })
  })

  it('answers a folder in the bin, or of another project, as not found, and writes nothing', async () => {
    state.folder = null
    await expect(setFolderAccess(SESSION, custom([{ userId: 'user-a', level: 'read' }]), request())).rejects.toBeInstanceOf(
      NotFoundError
    )
    writesNothing()
  })
})

describe('setFolderAccess: what a list may hold', () => {
  const people = (count: number) => Array.from({ length: count }, (_, i) => ({ userId: `user-${i}`, level: 'read' as const }))

  it.each([
    ['a list naming nobody that everyone does not read', custom([])],
    [`more than ${FOLDER_ACCESS_MAX_PEOPLE} people`, custom(people(FOLDER_ACCESS_MAX_PEOPLE + 1))],
    [
      'a person twice',
      custom([
        { userId: 'user-a', level: 'read' },
        { userId: 'user-a', level: 'write' },
      ]),
    ],
    [
      'someone who is not a member of the organization',
      custom([
        { userId: 'user-a', level: 'read' },
        { userId: 'user-ghost', level: 'read' },
      ]),
    ],
  ])('refuses %s with a 400, and writes nothing', async (_case, input) => {
    await expect(setFolderAccess(SESSION, input, request())).rejects.toBeInstanceOf(BadRequestError)
    writesNothing()
  })

  it('names the unknown member in the refusal', async () => {
    await expect(setFolderAccess(SESSION, custom([{ userId: 'user-ghost', level: 'read' }]), request())).rejects.toThrow(
      /user-ghost/
    )
  })

  it(`takes ${FOLDER_ACCESS_MAX_PEOPLE} people`, async () => {
    await setFolderAccess(SESSION, custom(people(FOLDER_ACCESS_MAX_PEOPLE)), request())
    expect(vi.mocked(replaceFolderRoleHolders).mock.calls[0][3]).toHaveLength(FOLDER_ACCESS_MAX_PEOPLE)
  })

  it('takes a list of nobody when everyone reads: every member reads, only admins write', async () => {
    const result = await setFolderAccess(SESSION, custom([], true), request())

    expect(replaceFolderRoleHolders).toHaveBeenCalledWith('org-1', 'proj-1', 'plaene', [])
    expect(state.updates[0]).toMatchObject({ accessMode: 'custom', everyoneReads: true })
    expect(result.access).toEqual({ mode: 'custom', everyoneReads: true, people: [] })
  })
})

describe('setFolderAccess: the order of the writes', () => {
  it('gives a folder its own list: the lock, WorkOS, the row, the old grants, then placement and the audit', async () => {
    const result = await setFolderAccess(
      SESSION,
      custom([
        { userId: 'user-a', level: 'write' },
        { userId: 'user-b', level: 'read' },
      ]),
      request()
    )

    expect(events).toEqual([LOCK, 'workos:ensure', 'workos:replace', 'row:custom', 'grants:deleted', 'tx:end', 'place', 'audit'])
    expect(state.grantDeletes).toEqual([[expect.any(String), 'plaene']])
    expect(ensureFolderResource).toHaveBeenCalledWith('org-1', 'proj-1', 'plaene', 'Pläne')
    expect(replaceFolderRoleHolders).toHaveBeenCalledWith('org-1', 'proj-1', 'plaene', [
      { userId: 'user-a', organizationMembershipId: 'om-a', level: 'write' },
      { userId: 'user-b', organizationMembershipId: 'om-b', level: 'read' },
    ])
    expect(state.updates[0]).toMatchObject({ accessMode: 'custom', everyoneReads: false, accessChangedBy: 'user-1' })
    expect(removeFolderResource).not.toHaveBeenCalled()
    expect(placeProjectDocuments).toHaveBeenCalledWith('org-1', 'proj-1')
    expect(result).toMatchObject({
      folderId: 'plaene',
      access: {
        mode: 'custom',
        everyoneReads: false,
        people: [
          { userId: 'user-a', level: 'write' },
          { userId: 'user-b', level: 'read' },
        ],
      },
      moved: 2,
    })
  })

  it('leaves the row as it was when WorkOS cannot be written: the folder never says custom over a list WorkOS lacks', async () => {
    vi.mocked(replaceFolderRoleHolders).mockRejectedValueOnce(new Error('WorkOS unavailable'))

    await expect(setFolderAccess(SESSION, custom([{ userId: 'user-a', level: 'read' }]), request())).rejects.toThrow(
      'WorkOS unavailable'
    )
    expect(events).toEqual([LOCK, 'workos:ensure', 'tx:end'])
    expect(state.updates).toEqual([])
    expect(state.grantDeletes).toEqual([])
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('registers the resource before it assigns a role on it', async () => {
    vi.mocked(ensureFolderResource).mockRejectedValueOnce(new Error('WorkOS unavailable'))

    await expect(setFolderAccess(SESSION, custom([{ userId: 'user-a', level: 'read' }]), request())).rejects.toThrow()
    expect(replaceFolderRoleHolders).not.toHaveBeenCalled()
    expect(state.updates).toEqual([])
  })

  it('changes a folder that already has its own list the same way: WorkOS, then the row', async () => {
    state.folder = { name: 'Pläne', accessMode: 'custom', everyoneReads: true }

    await setFolderAccess(SESSION, custom([{ userId: 'user-a', level: 'read' }]), request())

    expect(events).toEqual([LOCK, 'workos:ensure', 'workos:replace', 'row:custom', 'grants:deleted', 'tx:end', 'place', 'audit'])
    expect(state.updates[0]).toMatchObject({ everyoneReads: false })
  })

  it('makes a folder inherit again: the lock, the row, the old grants, then the WorkOS resource goes', async () => {
    state.folder = { name: 'Pläne', accessMode: 'custom', everyoneReads: false }

    const result = await setFolderAccess(SESSION, inherit, request())

    expect(events).toEqual([LOCK, 'row:inherit', 'grants:deleted', 'workos:remove', 'tx:end', 'place', 'audit'])
    expect(state.grantDeletes).toEqual([[expect.any(String), 'plaene']])
    expect(removeFolderResource).toHaveBeenCalledWith('org-1', 'proj-1', 'plaene')
    expect(ensureFolderResource).not.toHaveBeenCalled()
    expect(replaceFolderRoleHolders).not.toHaveBeenCalled()
    expect(state.updates[0]).toMatchObject({ accessMode: 'inherit', everyoneReads: false })
    expect(result.access).toEqual({ mode: 'inherit' })
  })

  it('keeps the inherit when the resource cannot be removed: a leftover resource is never read', async () => {
    state.folder = { name: 'Pläne', accessMode: 'custom', everyoneReads: false }
    vi.mocked(removeFolderResource).mockRejectedValueOnce(new Error('WorkOS unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await setFolderAccess(SESSION, inherit, request())

    expect(result.access).toEqual({ mode: 'inherit' })
    expect(events).toEqual([LOCK, 'row:inherit', 'grants:deleted', 'tx:end', 'place', 'audit'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('asks WorkOS nothing when a folder that already inherits is set to inherit', async () => {
    await setFolderAccess(SESSION, inherit, request())

    expect(events).toEqual([LOCK, 'row:inherit', 'grants:deleted', 'tx:end', 'place', 'audit'])
  })

  it('removes nothing in WorkOS when the row was not found to flip', async () => {
    state.folder = { name: 'Pläne', accessMode: 'custom', everyoneReads: false }
    state.updatedRows = []

    await expect(setFolderAccess(SESSION, inherit, request())).rejects.toBeInstanceOf(NotFoundError)
    expect(removeFolderResource).not.toHaveBeenCalled()
    expect(state.grantDeletes).toEqual([])
  })
})

describe('setFolderAccess: one change of a folder’s list at a time', () => {
  it('takes the lock on this folder, by organization and folder, before any WorkOS write', async () => {
    await setFolderAccess(SESSION, custom([{ userId: 'user-a', level: 'read' }]), request())

    expect(events[0]).toBe(LOCK)
    expect(events.indexOf(LOCK)).toBeLessThan(events.indexOf('workos:ensure'))
  })

  it('runs a second save of the same folder only after the first one’s transaction has ended', async () => {
    let release!: () => void
    const firstHeld = new Promise<void>((resolve) => (release = resolve))
    const trace: string[] = []
    vi.mocked(replaceFolderRoleHolders)
      .mockImplementationOnce(async (_org, _project, _folder, people) => {
        trace.push(`replace:${people.map((person) => person.organizationMembershipId).join(',')}:start`)
        await firstHeld
        trace.push(`replace:${people.map((person) => person.organizationMembershipId).join(',')}:end`)
      })
      .mockImplementationOnce(async (_org, _project, _folder, people) => {
        trace.push(`replace:${people.map((person) => person.organizationMembershipId).join(',')}:start`)
      })

    const first = setFolderAccess(SESSION, custom([{ userId: 'user-a', level: 'write' }]), request())
    const second = setFolderAccess(SESSION, custom([{ userId: 'user-b', level: 'read' }]), request())
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The first holds the lock in its WorkOS write; the second waits for the lock, not in WorkOS.
    expect(trace).toEqual(['replace:om-a:start'])
    release()
    await Promise.all([first, second])

    expect(trace).toEqual(['replace:om-a:start', 'replace:om-a:end', 'replace:om-b:start'])
    // The second's lock comes after the first transaction ended.
    const firstEnd = events.indexOf('tx:end')
    expect(events.indexOf(LOCK, 1)).toBeGreaterThan(firstEnd)
  })

})

describe('setFolderAccess: the IFC guard', () => {
  it('hands the guard whether everyone reads: false for a list that restricts reading', async () => {
    await setFolderAccess(SESSION, custom([{ userId: 'user-a', level: 'read' }]), request())
    expect(assertRestrictionKeepsIfcOpen).toHaveBeenCalledWith('org-1', 'proj-1', 'plaene', false)
  })

  it('hands the guard true for a list everyone reads, and null for inherit', async () => {
    await setFolderAccess(SESSION, custom([{ userId: 'user-a', level: 'write' }], true), request())
    expect(assertRestrictionKeepsIfcOpen).toHaveBeenLastCalledWith('org-1', 'proj-1', 'plaene', true)

    await setFolderAccess(SESSION, inherit, request())
    expect(assertRestrictionKeepsIfcOpen).toHaveBeenLastCalledWith('org-1', 'proj-1', 'plaene', null)
  })

  it('refuses a list that keeps a member from reading a folder holding IFC models, and writes nothing', async () => {
    vi.mocked(countIfcDocumentsInFolders).mockResolvedValueOnce(3)

    const error = await setFolderAccess(
      SESSION,
      { ...custom([{ userId: 'user-a', level: 'write' }]), folderId: 'modelle' },
      request()
    ).catch((caught: unknown) => caught)

    expect(error).toMatchObject({
      status: 409,
      message: expect.stringMatching(/hold 3 IFC models\. IFC models cannot be filed in a restricted folder yet/),
      details: { code: 'IFC_IN_RESTRICTED_FOLDER', models: 3 },
    })
    expect(countIfcDocumentsInFolders).toHaveBeenCalledWith('org-1', 'proj-1', ['modelle'])
    writesNothing()
  })

  it('lets a folder with models narrow who WRITES while every member still reads', async () => {
    // Three models in whatever folders the guard asks about; it asks about none.
    vi.mocked(countIfcDocumentsInFolders).mockImplementation(async (_org, _project, folderIds) =>
      folderIds.length > 0 ? 3 : 0
    )
    await setFolderAccess(SESSION, { ...custom([{ userId: 'user-a', level: 'write' }], true), folderId: 'modelle' }, request())

    expect(state.updates[0]).toMatchObject({ accessMode: 'custom', everyoneReads: true })
    expect(countIfcDocumentsInFolders).not.toHaveBeenCalledWith('org-1', 'proj-1', ['modelle'])
  })
})

describe('setFolderAccess: the audit trail', () => {
  it('keeps the keys the role-based lists wrote, `grants` in the describeAccess form', async () => {
    await setFolderAccess(
      SESSION,
      custom(
        [
          { userId: 'user-b', level: 'read' },
          { userId: 'user-a', level: 'write' },
        ],
        true
      ),
      request()
    )

    const event = vi.mocked(recordAuditEvent).mock.calls[0][0]
    expect(event).toMatchObject({
      organizationId: 'org-1',
      action: 'project.folder.access_changed',
      targetType: 'project',
      targetId: 'proj-1',
    })
    expect(event.metadata).toEqual({
      folderId: 'plaene',
      mode: 'custom',
      grants: '*:read,user:user-a:write,user:user-b:read',
      roles: '',
      documentsMoved: 2,
    })
  })

  it('audits an inherit with an empty list', async () => {
    await setFolderAccess(SESSION, inherit, request())

    expect(vi.mocked(recordAuditEvent).mock.calls[0][0].metadata).toEqual({
      folderId: 'plaene',
      mode: 'inherit',
      grants: '',
      roles: '',
      documentsMoved: 2,
    })
  })
})

describe('describeAccess', () => {
  it.each<[string, FolderAccessSetting, string]>([
    ['inherit', { mode: 'inherit' }, ''],
    ['a list of nobody everyone reads', { mode: 'custom', everyoneReads: true, people: [] }, '*:read'],
    [
      'people, sorted, after `*:read`',
      {
        mode: 'custom',
        everyoneReads: true,
        people: [
          { userId: 'user_z', level: 'read' },
          { userId: 'user_a', level: 'write' },
        ],
      },
      '*:read,user:user_a:write,user:user_z:read',
    ],
    ['people only', { mode: 'custom', everyoneReads: false, people: [{ userId: 'user_a', level: 'read' }] }, 'user:user_a:read'],
  ])('%s', (_label, access, expected) => {
    expect(describeAccess(access)).toBe(expected)
  })
})

describe('getFolderAccess', () => {
  it('reads the people from WorkOS and whether everyone reads from the row', async () => {
    state.folder = { name: 'Pläne', accessMode: 'custom', everyoneReads: true }
    vi.mocked(listFolderRoleHolders).mockResolvedValueOnce([
      { organizationMembershipId: 'om-a', userId: 'user-a', level: 'write' },
      { organizationMembershipId: 'om-b', userId: 'user-b', level: 'read' },
    ])

    expect(await getFolderAccess(SESSION, { projectId: 'proj-1', folderId: 'plaene' })).toEqual({
      mode: 'custom',
      everyoneReads: true,
      people: [
        { userId: 'user-a', level: 'write' },
        { userId: 'user-b', level: 'read' },
      ],
    })
    expect(listFolderRoleHolders).toHaveBeenCalledWith('org-1', 'plaene')
  })

  it('answers inherit without asking WorkOS', async () => {
    expect(await getFolderAccess(SESSION, { projectId: 'proj-1', folderId: 'plaene' })).toEqual({ mode: 'inherit' })
    expect(listFolderRoleHolders).not.toHaveBeenCalled()
  })

  it('is for whoever may change the list: project:manage, and write on the folder', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new NotFoundError('Project not found'))
    await expect(getFolderAccess(SESSION, { projectId: 'proj-1', folderId: 'plaene' })).rejects.toBeInstanceOf(NotFoundError)
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, 'proj-1', 'project:manage')

    asManager(null)
    await expect(getFolderAccess(SESSION, { projectId: 'proj-1', folderId: 'plaene' })).rejects.toBeInstanceOf(NotFoundError)

    asManager('read')
    await expect(getFolderAccess(SESSION, { projectId: 'proj-1', folderId: 'plaene' })).rejects.toMatchObject({
      status: 403,
      details: { reason: 'folder-read-only' },
    })
    expect(listFolderRoleHolders).not.toHaveBeenCalled()
  })
})
