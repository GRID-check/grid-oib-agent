import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./folder-access-repository', () => ({
  projectHasCustomOrBinnedFolders: vi.fn(),
  listProjectFolderTree: vi.fn(),
  listCustomFolderNames: vi.fn(),
}))
vi.mock('./projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/auth/membership-roles', () => ({ resolveMembershipRoles: vi.fn() }))
vi.mock('./org-role-permissions', () => ({ orgRoleHoldsPermission: vi.fn(async (role: string) => role === 'admin') }))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { resolveMembershipRoles } from '@/lib/auth/membership-roles'
import {
  ANY_MEMBER,
  EVERY_PROJECT_MEMBER,
  FOLDER_READ_ONLY_REASON,
  canWriteFolder,
  clearanceOf,
  clearanceOfMember,
  computeFolderAccess,
  effectiveFolderLevel,
  filterUsersWhoMayReadFolder,
  folderTree,
  foldersWithoutValidRole,
  getProjectFolderAccess,
  getRestrictedFolderIds,
  isRestrictedCollectionOf,
  readRestrictingFoldersOnPath,
  readableByEveryMember,
  readableFolderIdsFor,
  requireFolderWrite,
  restrictedCollectionName,
  unreadableFoldersBelow,
  withProjectCeiling,
  type AccessFolder,
  type DeletedFolderContentPolicy,
  type FolderClearance,
  type FolderGrant,
  type FolderLevel,
} from './folder-access'
import { listProjectFolderTree, projectHasCustomOrBinnedFolders } from './folder-access-repository'
import { requireProjectAccess } from './projects'

const COLLECTION = 'proj_8f2c3b1e-0000-4000-8000-000000000001'
const F = {
  verwaltung: '11111111-aaaa-4bbb-8ccc-000000000001',
  vertraege: '22222222-aaaa-4bbb-8ccc-000000000002',
  honorare: '33333333-aaaa-4bbb-8ccc-000000000003',
  plaene: '44444444-aaaa-4bbb-8ccc-000000000004',
  statik: '55555555-aaaa-4bbb-8ccc-000000000005',
  statikAlt: '66666666-aaaa-4bbb-8ccc-000000000006',
  archiviert: '77777777-aaaa-4bbb-8ccc-000000000007',
  waise: '88888888-aaaa-4bbb-8ccc-000000000008',
}
const GF = 'org-geschaeftsfuehrung'
const PL = 'org-projektleitung'
const BH = 'org-buchhaltung'

const inherit = (id: string, parentId: string | null): AccessFolder => ({ id, parentId, accessMode: 'inherit', grants: [] })
const custom = (id: string, parentId: string | null, grants: FolderGrant[], deleted = false): AccessFolder => ({
  id,
  parentId,
  accessMode: 'custom',
  grants,
  deleted,
})

/**
 *   Verwaltung/                inherits the project
 *     Verträge/                GF: write, PL: write, BH: read
 *       Honorare/              GF: write, PL: read, BH: write   (BH's write narrows to read: nesting)
 *   Pläne/                     inherits
 *   Statik/                    *: read, PL: write
 *     Statik-Alt/              inherits
 *   Archiviert/  (tombstone)   GF: read
 *   Waise/                     parent missing from the tree
 */
const TREE: AccessFolder[] = [
  inherit(F.verwaltung, null),
  custom(F.vertraege, F.verwaltung, [
    { role: GF, level: 'write' },
    { role: PL, level: 'write' },
    { role: BH, level: 'read' },
  ]),
  custom(F.honorare, F.vertraege, [
    { role: GF, level: 'write' },
    { role: PL, level: 'read' },
    { role: BH, level: 'write' },
  ]),
  inherit(F.plaene, null),
  custom(F.statik, null, [
    { role: EVERY_PROJECT_MEMBER, level: 'read' },
    { role: PL, level: 'write' },
  ]),
  inherit(F.statikAlt, F.statik),
  custom(F.archiviert, null, [{ role: GF, level: 'read' }], true),
  inherit(F.waise, '99999999-aaaa-4bbb-8ccc-000000000099'),
]
const tree = folderTree(TREE)

const who = (roles: string[], seesEverything = false): FolderClearance => ({ roles, seesEverything })

describe('unreadableFoldersBelow — what a move of a subtree may not do blind', () => {
  it.each([
    ['a role the lists do not name sees none of the custom folders below', who(['member']), F.verwaltung, [F.vertraege, F.honorare]],
    ['BH reads both (Honorare narrows to read by nesting)', who([BH]), F.verwaltung, []],
    ['GF reads everything below Verwaltung', who([GF]), F.verwaltung, []],
    ['an admin reads everything', who([], true), F.verwaltung, []],
    ['only what is BELOW the folder, not the folder itself', who(['member']), F.vertraege, [F.honorare]],
    ['a folder with no children', who(['member']), F.plaene, []],
    ['a tombstone below is not counted', who(['member']), F.statik, []],
  ])('%s', (_label, clearance, folderId, expected) => {
    expect(unreadableFoldersBelow(tree, clearance, folderId).sort()).toEqual([...expected].sort())
  })
})

describe('effectiveFolderLevel — the one rule (ADR-0085)', () => {
  // [who, folder, expected level]
  const cases: Array<[string, FolderClearance, string | null, FolderLevel]> = [
    // The project root and inheriting folders: the project decides.
    ['anyone at the root', who([]), null, 'write'],
    ['a member with no role in an inheriting folder', who([]), F.verwaltung, 'write'],
    ['a member with no role in Pläne', who(['member']), F.plaene, 'write'],
    // An own list: listed roles only, at their level.
    ['GF in Verträge', who([GF]), F.vertraege, 'write'],
    ['PL in Verträge', who([PL]), F.vertraege, 'write'],
    ['BH in Verträge', who([BH]), F.vertraege, 'read'],
    ['an unlisted role in Verträge', who(['member']), F.vertraege, 'none'],
    ['no role in Verträge', who([]), F.vertraege, 'none'],
    // Several roles: the best entry of the list.
    ['BH and PL in Verträge', who([BH, PL]), F.vertraege, 'write'],
    // Nesting narrows: the minimum over the folder and every ancestor with a list.
    ['GF in Honorare', who([GF]), F.honorare, 'write'],
    ['PL in Honorare (write above, read here)', who([PL]), F.honorare, 'read'],
    ['BH in Honorare (read above, write here: never wider)', who([BH]), F.honorare, 'read'],
    ['an unlisted role in Honorare', who(['member']), F.honorare, 'none'],
    // `*`: every member, at its level; a role's own entry may raise it.
    ['a member with no role in Statik', who([]), F.statik, 'read'],
    ['PL in Statik', who([PL]), F.statik, 'write'],
    ['a member with no role in Statik-Alt (inherits Statik)', who([]), F.statikAlt, 'read'],
    ['PL in Statik-Alt', who([PL]), F.statikAlt, 'write'],
    // Organization admins write everywhere the folder exists.
    ['an admin in Honorare', who([], true), F.honorare, 'write'],
    ['an admin in Verträge', who(['member'], true), F.vertraege, 'write'],
    // A tombstone keeps answering from its stored list.
    ['GF in a deleted folder', who([GF]), F.archiviert, 'read'],
    ['PL in a deleted folder', who([PL]), F.archiviert, 'none'],
    // Fail closed: an unknown id, a broken path.
    ['anyone in an unknown folder', who([GF]), '99999999-0000-4000-8000-000000000000', 'none'],
    ['an admin in an unknown folder', who([], true), '99999999-0000-4000-8000-000000000000', 'none'],
    ['anyone below a parent the tree lacks', who([GF]), F.waise, 'none'],
  ]

  it.each(cases)('%s', (_label, clearance, folderId, expected) => {
    expect(effectiveFolderLevel(tree, clearance, folderId)).toBe(expected)
  })

  it('never answers wider for a subfolder than for its parent, for any clearance in the table', () => {
    const clearances = [who([]), who([GF]), who([PL]), who([BH]), who([BH, PL]), who(['member'])]
    const rank = { none: 0, read: 1, write: 2 }
    for (const clearance of clearances) {
      for (const folder of TREE) {
        if (!folder.parentId || !tree.has(folder.parentId)) continue
        expect(rank[effectiveFolderLevel(tree, clearance, folder.id)]).toBeLessThanOrEqual(
          rank[effectiveFolderLevel(tree, clearance, folder.parentId)]
        )
      }
    }
  })

  it('guards a cycle instead of hanging', () => {
    const cyclic = folderTree([inherit('a', 'b'), custom('b', 'a', [{ role: GF, level: 'write' }])])
    expect(effectiveFolderLevel(cyclic, who([GF]), 'a')).toBe('none')
  })
})

describe('withProjectCeiling — the project permission caps write', () => {
  it.each([
    ['write', true, 'write'],
    ['write', false, 'read'],
    ['read', true, 'read'],
    ['read', false, 'read'],
    ['none', true, 'none'],
    ['none', false, 'none'],
  ] as const)('%s with project write %s is %s', (level, projectWrite, expected) => {
    expect(withProjectCeiling(level, projectWrite)).toBe(expected)
  })
})

describe('computeFolderAccess — listings and retrieval', () => {
  const as = (roles: string[], seesEverything = false) => computeFolderAccess(TREE, who(roles, seesEverything), COLLECTION)

  it('hides a folder the clearance may not read, and everything below it; a deleted folder from everyone', () => {
    const intern = as(['member'])
    expect([...intern.hiddenFolderIds].sort()).toEqual([F.vertraege, F.honorare, F.waise, F.archiviert].sort())
    // What is filed in a deleted folder is hidden from an admin too: the
    // Papierkorb is the one place it is seen.
    expect([...as([], true).hiddenFolderIds]).toEqual([F.archiviert])
    expect(intern.isVisible(F.verwaltung)).toBe(true)
    expect(intern.isVisible(F.statik)).toBe(true)
    expect(intern.isVisible(null)).toBe(true)
    expect(as([GF]).isVisible(F.archiviert)).toBe(false)
  })

  it('keys retrieval on READ: a list without `*` is its own collection, a list with `*` is not', () => {
    const access = as([])
    expect(access.collectionFor(null)).toBe(COLLECTION)
    expect(access.collectionFor(F.plaene)).toBe(COLLECTION)
    expect(access.collectionFor(F.statik)).toBe(COLLECTION)
    expect(access.collectionFor(F.statikAlt)).toBe(COLLECTION)
    expect(access.collectionFor(F.vertraege)).toBe(restrictedCollectionName(COLLECTION, F.vertraege))
    expect(access.collectionFor(F.honorare)).toBe(restrictedCollectionName(COLLECTION, F.honorare))
  })

  it('clears a read-only member for a collection exactly as it clears a writer', () => {
    const vertraege = restrictedCollectionName(COLLECTION, F.vertraege)
    const honorare = restrictedCollectionName(COLLECTION, F.honorare)
    expect(as([BH]).clearedRestrictedCollections).toEqual([vertraege, honorare])
    expect(as([GF]).clearedRestrictedCollections).toEqual([vertraege, honorare])
    expect(as(['member']).clearedRestrictedCollections).toEqual([])
  })

  it('names the source folder of each restricted collection, and nothing else', () => {
    const access = as([])
    expect(access.sourceFolderOf(restrictedCollectionName(COLLECTION, F.honorare))).toBe(F.honorare)
    expect(access.sourceFolderOf(COLLECTION)).toBeNull()
    expect(access.sourceFolderOf(restrictedCollectionName(COLLECTION, F.statik))).toBeNull()
  })

  it('is the fast, open answer when no folder has its own list', () => {
    const open = computeFolderAccess(
      TREE.map((folder) => ({ ...folder, accessMode: 'inherit' as const, grants: [], deleted: false })),
      who([]),
      COLLECTION
    )
    expect(open.anyRestricted).toBe(false)
    expect(open.isVisible(F.vertraege)).toBe(true)
    expect(open.levelOf(F.vertraege)).toBe('write')
  })

  it('hides a folder in the bin and what is in it even when no folder has its own list', () => {
    const tree = TREE.map((folder) => ({ ...folder, accessMode: 'inherit' as const, grants: [] }))
    const access = computeFolderAccess(tree, who([], true), COLLECTION)
    expect(access.anyRestricted).toBe(true)
    expect(access.isVisible(F.archiviert)).toBe(false)
    expect([...access.hiddenFolderIds]).toEqual([F.archiviert])
    // A purged tombstone holds nothing: it still never lists, but is no reason to load the tree.
    const purged = tree.map((folder) => (folder.deleted ? { ...folder, purgedAt: new Date() } : folder))
    expect(computeFolderAccess(purged, who([]), COLLECTION).anyRestricted).toBe(false)
    expect(computeFolderAccess(purged, who([]), COLLECTION).isVisible(F.archiviert)).toBe(false)
  })
})

describe('the helpers derived from the rule', () => {
  it('readableByEveryMember: only folders no list keeps from someone', () => {
    expect(readableByEveryMember(tree, F.plaene)).toBe(true)
    expect(readableByEveryMember(tree, F.statikAlt)).toBe(true)
    expect(readableByEveryMember(tree, F.vertraege)).toBe(false)
    expect(readableByEveryMember(tree, F.archiviert)).toBe(false)
    expect(readableByEveryMember(tree, 'unknown')).toBe(false)
  })

  it('readRestrictingFoldersOnPath: nearest first, `*` lists excluded', () => {
    expect(readRestrictingFoldersOnPath(tree, F.honorare)).toEqual([F.honorare, F.vertraege])
    expect(readRestrictingFoldersOnPath(tree, F.statikAlt)).toEqual([])
    expect(readRestrictingFoldersOnPath(tree, null)).toEqual([])
  })

  it('names restricted collections as `_r` and twelve hex digits of the folder id', () => {
    const name = restrictedCollectionName(COLLECTION, F.vertraege)
    expect(name).toBe(`${COLLECTION}_r22222222aaaa`)
    expect(isRestrictedCollectionOf(COLLECTION, name)).toBe(true)
    expect(isRestrictedCollectionOf(COLLECTION, COLLECTION)).toBe(false)
  })
})

const session = (roles: string[] | undefined, permissions: string[] = []): AuthorizedSession => ({
  userId: 'u',
  email: 'u@x',
  name: null,
  accessToken: 't',
  organizationId: 'org-1',
  organizationMembershipId: 'om',
  role: 'member',
  roles,
  permissions,
  featureFlags: null,
})

describe('the session loaders', () => {
  beforeEach(() => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockReset()
    vi.mocked(listProjectFolderTree).mockReset()
    vi.mocked(requireProjectAccess).mockReset()
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' })
    // WorkOS cannot be asked unless a test says what it answers: the token decides.
    vi.mocked(resolveMembershipRoles).mockResolvedValue(null)
  })

  it("reads every role the session holds; with WorkOS unreachable the admin bypass is the token's permission", async () => {
    vi.mocked(resolveMembershipRoles).mockResolvedValue(null)
    expect((await clearanceOf(session([GF, 'member']))).roles).toEqual([GF, 'member'])
    expect((await clearanceOf(session(undefined))).roles).toEqual(['member'])
    expect((await clearanceOf(session(undefined, ['org:projects:administer']))).seesEverything).toBe(true)
    expect((await clearanceOf(session(undefined))).seesEverything).toBe(false)
  })

  it('takes the admin bypass from the membership as it is now, not from a token that outlives a demotion', async () => {
    // The token still lists org:projects:administer; WorkOS says the person now holds only `member`.
    vi.mocked(resolveMembershipRoles).mockResolvedValue(['member'])
    expect((await clearanceOf(session(['member'], ['org:projects:administer']))).seesEverything).toBe(false)
  })

  it('grants the bypass to a promoted admin before the token is refreshed', async () => {
    vi.mocked(resolveMembershipRoles).mockResolvedValue(['admin'])
    expect((await clearanceOf(session(['admin'], []))).seesEverything).toBe(true)
  })

  it('a demoted admin no longer reads or writes a folder whose list names none of their roles', async () => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(true)
    vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    vi.mocked(resolveMembershipRoles).mockResolvedValue(['member'])
    const demoted = session(['member'], ['org:projects:administer'])

    await expect(requireFolderWrite(demoted, 'proj-1', [F.honorare])).rejects.toBeInstanceOf(NotFoundError)
    expect((await getProjectFolderAccess(demoted, 'proj-1', COLLECTION)).isVisible(F.honorare)).toBe(false)
  })

  it('does not read the tree for a project where no folder has its own list', async () => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(false)
    const access = await getProjectFolderAccess(session(['member']), 'proj-1', COLLECTION)
    expect(access.anyRestricted).toBe(false)
    expect(listProjectFolderTree).not.toHaveBeenCalled()
  })

  it('getRestrictedFolderIds: what a caller with no session must hide is what not every member may read', async () => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(true)
    vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    expect((await getRestrictedFolderIds('org-1', 'proj-1')).sort()).toEqual(
      [F.vertraege, F.honorare, F.waise, F.archiviert].sort()
    )
  })

  it('readableFolderIdsFor: every folder, tombstones included, the clearance may read now', async () => {
    vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    expect((await readableFolderIdsFor('org-1', 'proj-1', who([GF]))).sort()).toEqual(
      [F.verwaltung, F.vertraege, F.honorare, F.plaene, F.statik, F.statikAlt, F.archiviert].sort()
    )
    expect(await readableFolderIdsFor('org-1', 'proj-1', ANY_MEMBER)).not.toContain(F.vertraege)
  })

  it('filterUsersWhoMayReadFolder: each person by the roles WorkOS reports for them, the tree read once', async () => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(true)
    vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    const rolesOf: Record<string, string[] | null> = { gf: [GF], bh: [BH], nobody: ['member'], admin: ['admin'], down: null }
    vi.mocked(resolveMembershipRoles).mockImplementation(async (_org, userId) => rolesOf[userId])

    const readers = await filterUsersWhoMayReadFolder('org-1', 'proj-1', F.vertraege, ['gf', 'bh', 'nobody', 'admin', 'down'])

    expect([...readers].sort()).toEqual(['admin', 'bh', 'gf'])
    expect(listProjectFolderTree).toHaveBeenCalledTimes(1)
  })

  it('filterUsersWhoMayReadFolder: asks nobody for the root or a project with no own list', async () => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(false)
    vi.mocked(resolveMembershipRoles).mockClear()

    expect([...(await filterUsersWhoMayReadFolder('org-1', 'proj-1', F.vertraege, ['a', 'b']))]).toEqual(['a', 'b'])
    expect([...(await filterUsersWhoMayReadFolder('org-1', 'proj-1', null, ['a']))]).toEqual(['a'])
    expect(resolveMembershipRoles).not.toHaveBeenCalled()
  })

  it('clearanceOfMember: WorkOS roles, every one of them, and admin from any', async () => {
    vi.mocked(resolveMembershipRoles).mockResolvedValue([BH, 'admin'])
    expect(await clearanceOfMember('org-1', 'user-2')).toEqual({ roles: [BH, 'admin'], seesEverything: true })
    vi.mocked(resolveMembershipRoles).mockResolvedValue(null)
    expect(await clearanceOfMember('org-1', 'user-2')).toEqual({ roles: [], seesEverything: false })
  })
})

describe('requireFolderWrite — the one write check', () => {
  beforeEach(() => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(true)
    vi.mocked(listProjectFolderTree).mockClear()
    vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    vi.mocked(requireProjectAccess).mockReset()
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' })
    vi.mocked(resolveMembershipRoles).mockResolvedValue(null)
  })

  it('lets a writer write', async () => {
    await expect(requireFolderWrite(session([PL]), 'proj-1', [F.vertraege])).resolves.toBeUndefined()
    expect(requireProjectAccess).toHaveBeenCalledWith(expect.anything(), 'proj-1', ['project:documents:write', 'project:edit'])
  })

  it('refuses a read-only member with a typed 403', async () => {
    const refusal = await requireFolderWrite(session([BH]), 'proj-1', [F.vertraege]).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(ForbiddenError)
    expect((refusal as ForbiddenError).details).toEqual({ reason: FOLDER_READ_ONLY_REASON })
  })

  it('answers not found for a folder the member may not read', async () => {
    await expect(requireFolderWrite(session(['member']), 'proj-1', [F.vertraege])).rejects.toBeInstanceOf(NotFoundError)
  })

  it('refuses when any one of the folders touched is read-only (a move out of one)', async () => {
    await expect(requireFolderWrite(session([PL]), 'proj-1', [F.statik, F.honorare])).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('keeps the project permission the ceiling: a granted writer without project write is refused before the folder', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    await expect(requireFolderWrite(session([GF]), 'proj-1', [F.vertraege])).rejects.toBeInstanceOf(NotFoundError)
    expect(await canWriteFolder(session([GF]), 'proj-1', F.vertraege)).toBe(false)
  })

  it('lets an organization admin write in a folder whose list names none of their roles', async () => {
    await expect(
      requireFolderWrite(session([], ['org:projects:administer']), 'proj-1', [F.honorare])
    ).resolves.toBeUndefined()
  })

  it('refuses to write into a deleted folder', async () => {
    await expect(requireFolderWrite(session([GF]), 'proj-1', [F.archiviert])).rejects.toBeInstanceOf(NotFoundError)
  })

  it('needs only the project permission at the root', async () => {
    await expect(requireFolderWrite(session([]), 'proj-1', [null])).resolves.toBeUndefined()
    expect(listProjectFolderTree).not.toHaveBeenCalled()
  })
})

describe('a role deleted in WorkOS leaves its folders to the admins (ADR-0085)', () => {
  /** Honorare named only „Geschäftsführung" (`GF`), which was deleted; `PL` still exists. */
  const GONE = 'org-gone'
  const DEAD = '99999999-aaaa-4bbb-8ccc-0000000000a1'
  const MIXED = '99999999-aaaa-4bbb-8ccc-0000000000a2'
  const OPEN_LIST = '99999999-aaaa-4bbb-8ccc-0000000000a3'
  const TOMB = '99999999-aaaa-4bbb-8ccc-0000000000a4'
  const CHILD_OF_DEAD = '99999999-aaaa-4bbb-8ccc-0000000000a5'
  const folders: AccessFolder[] = [
    custom(DEAD, null, [{ role: GONE, level: 'write' }]),
    custom(MIXED, null, [
      { role: GONE, level: 'write' },
      { role: PL, level: 'read' },
    ]),
    custom(OPEN_LIST, null, [{ role: EVERY_PROJECT_MEMBER, level: 'read' }]),
    custom(TOMB, null, [{ role: GONE, level: 'read' }], true),
    inherit(CHILD_OF_DEAD, DEAD),
    inherit(F.plaene, null),
  ]
  const existing = new Set([PL, GF, 'admin', 'member'])

  it('flags a folder whose own list names only roles that no longer exist', () => {
    expect(foldersWithoutValidRole(folders, existing)).toEqual([DEAD])
  })

  it('does not flag a list that still names a role that exists, a `*` list, an inheriting folder or a tombstone', () => {
    const flagged = foldersWithoutValidRole(folders, existing)
    for (const id of [MIXED, OPEN_LIST, TOMB, CHILD_OF_DEAD, F.plaene]) expect(flagged).not.toContain(id)
  })

  it('flags nothing once the role exists again (the slug is back, the grants match again)', () => {
    expect(foldersWithoutValidRole(folders, new Set([...existing, GONE]))).toEqual([])
  })

  it('is readable by organization admins only: no member and no existing role reads or writes it', () => {
    const t = folderTree(folders)
    for (const roles of [[], [PL], [GF], ['member'], [BH]]) {
      expect(effectiveFolderLevel(t, who(roles), DEAD)).toBe('none')
    }
    expect(effectiveFolderLevel(t, who([], true), DEAD)).toBe('write')
    // What inherits from it is just as closed, and is not flagged: its parent is.
    expect(effectiveFolderLevel(t, who([PL]), CHILD_OF_DEAD)).toBe('none')
    expect(effectiveFolderLevel(t, who([], true), CHILD_OF_DEAD)).toBe('write')
  })

  it('hides it from a project listing for a non-admin and shows it to an admin', () => {
    expect(computeFolderAccess(folders, who([PL]), COLLECTION).hiddenFolderIds.has(DEAD)).toBe(true)
    expect(computeFolderAccess(folders, who([], true), COLLECTION).hiddenFolderIds.has(DEAD)).toBe(false)
  })

  it('keeps matching after a rename: grants name the slug, and a rename leaves the slug', () => {
    // WorkOS renames change `name`, never `slug` (UpdateOrganizationRoleOptions has no slug).
    const beforeRename = new Set(['org-geschaeftsfuehrung'])
    const afterRename = new Set(['org-geschaeftsfuehrung'])
    const named: AccessFolder[] = [custom(DEAD, null, [{ role: 'org-geschaeftsfuehrung', level: 'write' }])]

    expect(foldersWithoutValidRole(named, beforeRename)).toEqual([])
    expect(foldersWithoutValidRole(named, afterRename)).toEqual([])
    expect(effectiveFolderLevel(folderTree(named), who(['org-geschaeftsfuehrung']), DEAD)).toBe('write')
  })
})

describe('a purged folder: the organization decides who sees what was derived from it', () => {
  // Archiviert (GF: read) after its purge, under each of the four settings.
  const purgedUnder = (policy: DeletedFolderContentPolicy) =>
    folderTree(
      TREE.map((folder) =>
        folder.id === F.archiviert ? { ...folder, purgedAt: new Date('2026-10-20T00:00:00Z'), purgedContent: policy } : folder
      )
    )

  it.each([
    ['unchanged', [GF], 'read'],
    ['unchanged', [PL], 'none'],
    ['project', [PL], 'read'],
    ['project', [], 'read'],
    ['admins', [GF], 'none'],
    ['remove', [GF], 'none'],
  ] as const)('%s: roles %j read it as %s', (policy, roles, expected) => {
    expect(effectiveFolderLevel(purgedUnder(policy), who([...roles]), F.archiviert)).toBe(expected)
  })

  it.each(['unchanged', 'project', 'admins', 'remove'] as const)('%s: an organization admin still reads it', (policy) => {
    expect(effectiveFolderLevel(purgedUnder(policy), who([], true), F.archiviert)).toBe('write')
  })

  it('leaves a folder in the bin (not purged) to its own grants, whatever the setting', () => {
    const tree = folderTree(
      TREE.map((folder) => (folder.id === F.archiviert ? { ...folder, purgedContent: 'admins' as const } : folder))
    )
    expect(effectiveFolderLevel(tree, who([GF]), F.archiviert)).toBe('read')
  })
})
