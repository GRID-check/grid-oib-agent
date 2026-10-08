/**
 * @vitest-environment node
 */
/**
 * The per-person rule for restricted folders (ADR-0086, ADR-0087; product owner
 * 2026-10-02: "only when actually used … being restricted is unique to one
 * person"), driven with the stores mocked and the folder rule real. The record
 * names SOURCE FOLDERS and is judged against the folders' access at read time.
 * The SQL, the lock and the races are `restricted-use.integration.spec.ts`,
 * against Postgres.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { AccessFolder, FolderClearance } from '@/lib/authz/folder-access'
import type { ConversationAudienceRow } from './restricted-use-repository'

vi.mock('server-only', () => ({}))

const COLLECTION = 'proj_alpha'
/** Verträge: Geschäftsführung writes, „Verträge" reads. Personal: Geschäftsführung only. */
const VERTRAEGE_ID = '01234567-89ab-4cde-8f01-23456789abcd'
const PERSONAL_ID = 'ba987654-3210-4cde-8f01-23456789abcd'
/** Once restricted, since opened to everyone. */
const OPENED_ID = 'c0ffee00-0000-4000-8000-000000000001'
/** A deleted folder's tombstone, Geschäftsführung only. */
const DELETED_ID = 'dead0000-0000-4000-8000-000000000001'
const VERTRAEGE = `${COLLECTION}_r0123456789ab`
const PERSONAL = `${COLLECTION}_rba9876543210`
const GF: FolderClearance = { roles: ['org-gf'], seesEverything: false }
const NOBODY: FolderClearance = { roles: [], seesEverything: false }

const TREE: AccessFolder[] = [
  {
    id: VERTRAEGE_ID,
    parentId: null,
    accessMode: 'custom',
    grants: [
      { role: 'org-gf', level: 'write' },
      { role: 'org-vertraege', level: 'read' },
    ],
  },
  { id: PERSONAL_ID, parentId: null, accessMode: 'custom', grants: [{ role: 'org-gf', level: 'write' }] },
  { id: OPENED_ID, parentId: null, accessMode: 'inherit', grants: [] },
  { id: DELETED_ID, parentId: null, accessMode: 'custom', grants: [{ role: 'org-gf', level: 'read' }], deleted: true },
]

const state = vi.hoisted(() => ({
  /** The audience the first read sees, and the one read under the lock. */
  audiences: [] as ConversationAudienceRow[],
  recorded: [] as string[],
  written: [] as string[][],
  members: new Map<string, FolderClearance>(),
  tree: [] as AccessFolder[],
  tx: { tx: true },
}))

vi.mock('@/lib/db', () => ({
  getDb: () => ({ transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(state.tx) }),
}))
vi.mock('./restricted-use-repository', () => ({
  lockConversationAudience: vi.fn(async () => undefined),
  listRecordedSourceFolders: vi.fn(async () => [...state.recorded]),
  recordSourceFolders: vi.fn(async (_executor: unknown, _org: string, _id: string, folders: string[]) => {
    state.written.push([...folders])
    state.recorded = [...new Set([...state.recorded, ...folders])]
  }),
  readConversationAudience: vi.fn(async () => (state.audiences.length > 1 ? state.audiences.shift()! : state.audiences[0])),
}))
vi.mock('@/lib/authz/folder-access-repository', () => ({
  listProjectFolderTree: vi.fn(async () => state.tree),
  projectHasCustomFolders: vi.fn(async () => state.tree.some((folder) => folder.accessMode === 'custom')),
}))
vi.mock('@/lib/projects/repository', () => ({ findProjectCollectionName: vi.fn(async () => COLLECTION) }))
vi.mock('@/lib/sharing/directory', () => ({
  loadOrganizationDirectory: vi.fn(async () => new Map([['user_ina', { userId: 'user_ina', email: null, name: 'Ina', profilePictureUrl: null }]])),
}))
vi.mock('@/lib/authz/folder-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/authz/folder-access')>()),
  clearanceOfMember: vi.fn(async (_org: string, userId: string) => state.members.get(userId) ?? NOBODY),
  customFolderNames: vi.fn(
    async () =>
      new Map([
        [VERTRAEGE_ID, 'Verträge'],
        [PERSONAL_ID, 'Personal'],
      ])
  ),
}))

import {
  admitRestrictedUse,
  admitSourceFolders,
  assertMayWidenConversation,
  drawableRestrictedCollections,
  foldersEveryoneMayRead,
  recordedRestrictedFolders,
  widenConversationAudience,
} from './restricted-use'
import { folderTree } from '@/lib/authz/folder-access'

const ORG = 'org_1'
const PROJECT = 'project_1'
const CONV = 's_conv_1'
const OWNER = 'user_owner'

const session = {
  userId: OWNER,
  organizationId: ORG,
  role: 'org-gf',
  roles: ['org-gf'],
  permissions: [],
} as unknown as AuthorizedSession

const audience = (grantees: string[] = [], visibility: 'private' | 'project' = 'private'): ConversationAudienceRow => ({
  exists: true,
  projectId: PROJECT,
  createdBy: OWNER,
  visibility,
  grantees,
})

const request = { organizationId: ORG, conversationId: CONV, userId: OWNER, projectId: PROJECT }

beforeEach(() => {
  vi.clearAllMocks()
  state.audiences = [audience()]
  state.recorded = []
  state.written = []
  state.tree = TREE
  state.members = new Map([
    [OWNER, GF],
    ['user_vertraege', { roles: ['org-vertraege'], seesEverything: false }],
  ])
})

describe('foldersEveryoneMayRead', () => {
  const tree = folderTree(TREE)
  const clearances = new Map<string, FolderClearance>([
    ['a', GF],
    ['b', { roles: ['org-vertraege'], seesEverything: false }],
  ])

  it('keeps what every reader of a private conversation may read — read is enough', () => {
    expect(foldersEveryoneMayRead(tree, [VERTRAEGE_ID, PERSONAL_ID], { visibility: 'private' }, ['a', 'b'], clearances)).toEqual([
      VERTRAEGE_ID,
    ])
  })

  it('keeps nothing for a project-visible conversation, whose readers cannot be enumerated', () => {
    expect(foldersEveryoneMayRead(tree, [VERTRAEGE_ID], { visibility: 'project' }, ['a'], clearances)).toEqual([])
  })

  it('counts a reader nobody asked about as reading nothing restricted', () => {
    expect(foldersEveryoneMayRead(tree, [VERTRAEGE_ID], { visibility: 'private' }, ['a', 'stranger'], clearances)).toEqual([])
  })
})

describe('drawableRestrictedCollections — what a turn may search', () => {
  it('is everything the asker of an unshared chat may read', async () => {
    expect(await drawableRestrictedCollections(request, [VERTRAEGE, PERSONAL])).toEqual([VERTRAEGE, PERSONAL])
  })

  it('narrows to what everyone the chat is shared with may read, a read-only colleague included', async () => {
    state.audiences = [audience(['user_vertraege'])]
    expect(await drawableRestrictedCollections(request, [VERTRAEGE, PERSONAL])).toEqual([VERTRAEGE])
  })

  it('records nothing: listing a folder in the scope is not use', async () => {
    await drawableRestrictedCollections(request, [VERTRAEGE])
    expect(state.written).toEqual([])
  })
})

describe('admitRestrictedUse — the record of use, by source folder', () => {
  it('records the source folder of what the asker and every reader may read, and refuses the rest', async () => {
    state.audiences = [audience(['user_vertraege'])]

    const result = await admitRestrictedUse(request, [VERTRAEGE, PERSONAL])

    expect(result).toEqual({ admitted: [VERTRAEGE], refused: [PERSONAL], recorded: [VERTRAEGE_ID] })
    expect(state.written).toEqual([[VERTRAEGE_ID]])
  })

  it('refuses when someone joined between the clearance lookup and the lock', async () => {
    // First read: the owner alone. Under the lock: a reader nobody asked about.
    state.audiences = [audience(), audience(['user_ina'])]

    const result = await admitRestrictedUse(request, [VERTRAEGE])

    expect(result.admitted).toEqual([])
    expect(result.refused).toEqual([VERTRAEGE])
    expect(state.written).toEqual([[]])
  })

  it('refuses a name that is not a current restricted collection of the project', async () => {
    const result = await admitRestrictedUse(request, ['proj_other_r0123456789ab'])
    expect(result.refused).toEqual(['proj_other_r0123456789ab'])
  })

  it('admits the first turn of a chat that does not exist yet, in the stated project', async () => {
    state.audiences = [{ exists: false, projectId: null, createdBy: null, visibility: 'private', grantees: [] }]
    expect((await admitRestrictedUse(request, [VERTRAEGE])).admitted).toEqual([VERTRAEGE])
  })

  it('admits a folder every member may read without recording it, and refuses an unknown one', async () => {
    const result = await admitSourceFolders(request, [OPENED_ID, '99999999-0000-4000-8000-000000000000'])
    expect(result.admitted).toEqual([OPENED_ID])
    expect(result.refused).toEqual(['99999999-0000-4000-8000-000000000000'])
    expect(state.written).toEqual([[]])
  })
})

describe('recordedRestrictedFolders — judged at read time', () => {
  it('is empty for a chat that drew on nothing', async () => {
    expect(await recordedRestrictedFolders(CONV, ORG)).toEqual([])
  })

  it('drops a folder since opened to every member: loosening opens what was derived from it', async () => {
    state.recorded = [VERTRAEGE_ID, OPENED_ID]
    expect(await recordedRestrictedFolders(CONV, ORG)).toEqual([VERTRAEGE_ID])
  })

  it('keeps a deleted folder, judged by its tombstone, and an id the tree does not know', async () => {
    state.recorded = [DELETED_ID, '99999999-0000-4000-8000-000000000000']
    expect(await recordedRestrictedFolders(CONV, ORG)).toEqual([DELETED_ID, '99999999-0000-4000-8000-000000000000'])
  })

  it('picks up a tightening with no rewrite: a folder that gained a list counts from then on', async () => {
    state.recorded = [OPENED_ID]
    expect(await recordedRestrictedFolders(CONV, ORG)).toEqual([])
    state.tree = TREE.map((folder) =>
      folder.id === OPENED_ID ? { ...folder, accessMode: 'custom' as const, grants: [{ role: 'org-gf', level: 'read' as const }] } : folder
    )
    expect(await recordedRestrictedFolders(CONV, ORG)).toEqual([OPENED_ID])
  })
})

describe('widening a conversation — per person', () => {
  const toIna = { kind: 'person', userId: 'user_ina', self: false } as const

  async function refusalOf(promise: Promise<unknown>) {
    return promise.then(
      () => null,
      (error: { details?: unknown }) => error.details
    )
  }

  it('lets anyone in while the chat recorded nothing', async () => {
    const write = vi.fn(async () => 'granted')
    await assertMayWidenConversation(session, CONV, toIna)
    expect(await widenConversationAudience(session, CONV, toIna, write)).toBe('granted')
    expect(write).toHaveBeenCalledWith(state.tx)
  })

  it('refuses a person who may not read a recorded folder, naming them and — to a sharer who may — the folder', async () => {
    state.recorded = [VERTRAEGE_ID]
    const write = vi.fn()

    expect(await refusalOf(assertMayWidenConversation(session, CONV, toIna))).toEqual({
      reason: 'restricted-content',
      person: 'Ina',
      folders: ['Verträge'],
    })
    expect(await refusalOf(widenConversationAudience(session, CONV, toIna, write))).toMatchObject({
      reason: 'restricted-content',
    })
    expect(write).not.toHaveBeenCalled()
  })

  it('does not name a folder the sharer may not read', async () => {
    state.recorded = [PERSONAL_ID]
    const sharer = { ...session, roles: ['org-vertraege'], role: 'org-vertraege' } as AuthorizedSession
    expect(await refusalOf(assertMayWidenConversation(sharer, CONV, toIna))).toEqual({
      reason: 'restricted-content',
      person: 'Ina',
    })
  })

  it('lets in a person who may READ every recorded folder, and refuses one who may read only some', async () => {
    state.recorded = [VERTRAEGE_ID]
    const toVertraege = { kind: 'person', userId: 'user_vertraege', self: false } as const
    await expect(assertMayWidenConversation(session, CONV, toVertraege)).resolves.toBeUndefined()

    state.recorded = [VERTRAEGE_ID, PERSONAL_ID]
    expect(await refusalOf(assertMayWidenConversation(session, CONV, toVertraege))).toMatchObject({
      reason: 'restricted-content',
    })
  })

  it('lets anyone in once the recorded folder was opened to every member', async () => {
    state.recorded = [OPENED_ID]
    await expect(assertMayWidenConversation(session, CONV, toIna)).resolves.toBeUndefined()
    await expect(assertMayWidenConversation(session, CONV, { kind: 'visibility' })).resolves.toBeUndefined()
  })

  it('refuses the project-wide visibility while anything recorded restricts someone, and only then', async () => {
    await expect(assertMayWidenConversation(session, CONV, { kind: 'visibility' })).resolves.toBeUndefined()
    state.recorded = [VERTRAEGE_ID]
    expect(await refusalOf(assertMayWidenConversation(session, CONV, { kind: 'visibility' }))).toEqual({
      reason: 'restricted-content-project',
    })
  })

  it('refuses an escalating admin who may not read a recorded folder, without naming it', async () => {
    state.recorded = [PERSONAL_ID]
    const admin = { ...session, userId: 'user_admin', roles: ['org-vertraege'], role: 'org-vertraege' } as AuthorizedSession
    expect(
      await refusalOf(assertMayWidenConversation(admin, CONV, { kind: 'person', userId: 'user_admin', self: true }))
    ).toEqual({ reason: 'restricted-content-self' })
  })

  it('checks the record again under the lock: a use admitted after the pre-check refuses the write', async () => {
    const write = vi.fn()
    await assertMayWidenConversation(session, CONV, toIna)
    state.recorded = [VERTRAEGE_ID]
    expect(await refusalOf(widenConversationAudience(session, CONV, toIna, write))).toMatchObject({
      reason: 'restricted-content',
    })
    expect(write).not.toHaveBeenCalled()
  })
})
