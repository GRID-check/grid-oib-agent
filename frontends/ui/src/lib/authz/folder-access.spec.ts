import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./folder-access-repository', () => ({
  projectHasCustomFolders: vi.fn(async () => true),
  projectHasCustomOrBinnedFolders: vi.fn(),
  listProjectFolderTree: vi.fn(),
  listCustomFolderNames: vi.fn(),
  listProjectsWithCustomOrBinnedFolders: vi.fn(),
}))
vi.mock('./folder-roles', () => ({ heldFolderLevels: vi.fn(async () => ({})) }))
vi.mock('./projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/auth/membership-roles', () => ({ resolveMembershipRoles: vi.fn() }))
vi.mock('./org-role-permissions', () => ({ orgRoleHoldsPermission: vi.fn(async (role: string) => role === 'admin') }))
vi.mock('@/lib/projects/repository', () => ({
  findProjectTenancy: vi.fn(async () => ({ organizationId: 'org-1', deletedAt: null, status: 'active' })),
}))
vi.mock('./resource-check', () => ({ checkResourcePermission: vi.fn(async () => true) }))
vi.mock('./project-membership', () => ({
  resolveSubjectMembership: vi.fn(async (_org: string, userId: string) => ({
    organizationMembershipId: `om-${userId}`,
    role: 'member',
  })),
}))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { resolveMembershipRoles } from '@/lib/auth/membership-roles'
import {
  ANY_MEMBER,
  atLeast,
  EVERY_FOLDER,
  FOLDER_READ_ONLY_REASON,
  canWriteFolder,
  clearanceOf,
  clearanceOfMember,
  computeFolderAccess,
  effectiveFolderLevel,
  filterUsersWhoMayReadFolder,
  folderTree,
  getProjectFolderAccess,
  getRestrictedFolderIds,
  isRestrictedCollectionOf,
  listLevel,
  readRestrictingFoldersOnPath,
  readableByEveryMember,
  readableFolderIdsFor,
  readableFoldersOfRestrictedProjects,
  RESTRICTED_PROJECT_READS_AT_ONCE,
  requireFolderWrite,
  restrictedCollectionName,
  restrictsReading,
  unreadableFolderIds,
  unreadableFoldersBelow,
  withProjectCeiling,
  type AccessFolder,
  type DeletedFolderContentPolicy,
  type FolderClearance,
  type FolderGrantLevel,
  type FolderLevel,
} from './folder-access'
import {
  listProjectFolderTree,
  listProjectsWithCustomOrBinnedFolders,
  projectHasCustomFolders,
  projectHasCustomOrBinnedFolders,
} from './folder-access-repository'
import { heldFolderLevels } from './folder-roles'
import { requireProjectAccess } from './projects'
import { checkResourcePermission } from './resource-check'
import { findProjectTenancy } from '@/lib/projects/repository'

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

/**
 * The people on the lists (ADR-0097): who holds a folder role is WorkOS's, so a
 * person's clearance is the level they hold on each folder with its own list.
 * `gf` the managing director, `pl` the project lead, `bh` the bookkeeper,
 * `member` someone on no list.
 */
type Person = 'gf' | 'pl' | 'bh' | 'member'

/** Each custom folder's people, as WorkOS would report their folder roles. */
const LISTS: Record<string, Partial<Record<Person, FolderGrantLevel>>> = {
  [F.vertraege]: { gf: 'write', pl: 'write', bh: 'read' },
  [F.honorare]: { gf: 'write', pl: 'read', bh: 'write' },
  [F.statik]: { pl: 'write' },
  [F.archiviert]: { gf: 'read' },
}

/** The levels `person` holds, one entry per folder whose list names them. */
const levelsOf = (person: Person, lists = LISTS): Record<string, FolderGrantLevel> =>
  Object.fromEntries(
    Object.entries(lists).flatMap(([folderId, list]) => (list[person] ? [[folderId, list[person]] as const] : []))
  )

const who = (person: Person | null, seesEverything = false): FolderClearance => ({
  levels: person ? levelsOf(person) : {},
  seesEverything,
})
const admin = who(null, true)

const inherit = (id: string, parentId: string | null): AccessFolder => ({
  id,
  parentId,
  accessMode: 'inherit',
  everyoneReads: false,
})
const custom = (id: string, parentId: string | null, everyoneReads = false, deleted = false): AccessFolder => ({
  id,
  parentId,
  accessMode: 'custom',
  everyoneReads,
  deleted,
})

/**
 *   Verwaltung/                inherits the project
 *     Verträge/                gf: write, pl: write, bh: read
 *       Honorare/              gf: write, pl: read, bh: write   (bh's write narrows to read: nesting)
 *   Pläne/                     inherits
 *   Statik/                    everyone reads, pl: write
 *     Statik-Alt/              inherits
 *   Archiviert/  (tombstone)   gf: read
 *   Waise/                     parent missing from the tree
 */
const TREE: AccessFolder[] = [
  inherit(F.verwaltung, null),
  custom(F.vertraege, F.verwaltung),
  custom(F.honorare, F.vertraege),
  inherit(F.plaene, null),
  custom(F.statik, null, true),
  inherit(F.statikAlt, F.statik),
  custom(F.archiviert, null, false, true),
  inherit(F.waise, '99999999-aaaa-4bbb-8ccc-000000000099'),
]
const tree = folderTree(TREE)

describe('listLevel — what one folder’s own list gives', () => {
  const folder = custom(F.vertraege, null)
  const open = custom(F.statik, null, true)

  it.each([
    ['the folder role held on it', { [F.vertraege]: 'write' }, folder, 'write'],
    ['read held on it', { [F.vertraege]: 'read' }, folder, 'read'],
    ['a role held on another folder only', { [F.honorare]: 'write' }, folder, 'none'],
    ['nothing held, everyone does not read', {}, folder, 'none'],
    ['nothing held, everyone reads', {}, open, 'read'],
    ['write held where everyone reads', { [F.statik]: 'write' }, open, 'write'],
    ['read held where everyone reads', { [F.statik]: 'read' }, open, 'read'],
  ] as const)('%s', (_label, levels, target, expected) => {
    expect(listLevel(target, { levels, seesEverything: false })).toBe(expected)
  })

  it('restrictsReading: a custom folder that everyone does not read, and nothing else', () => {
    expect(restrictsReading(folder)).toBe(true)
    expect(restrictsReading(open)).toBe(false)
    // An inheriting folder ignores a stale flag either way.
    expect(restrictsReading({ ...inherit(F.plaene, null), everyoneReads: true })).toBe(false)
    expect(restrictsReading(inherit(F.plaene, null))).toBe(false)
  })
})

describe('unreadableFoldersBelow — what a move of a subtree may not do blind', () => {
  it.each([
    ['someone on no list sees none of the custom folders below', who('member'), F.verwaltung, [F.vertraege, F.honorare]],
    ['bh reads both (Honorare narrows to read by nesting)', who('bh'), F.verwaltung, []],
    ['gf reads everything below Verwaltung', who('gf'), F.verwaltung, []],
    ['an admin reads everything', admin, F.verwaltung, []],
    ['only what is BELOW the folder, not the folder itself', who('member'), F.vertraege, [F.honorare]],
    ['a folder with no children', who('member'), F.plaene, []],
    ['a tombstone below is not counted', who('member'), F.statik, []],
  ])('%s', (_label, clearance, folderId, expected) => {
    expect(unreadableFoldersBelow(tree, clearance, folderId).sort()).toEqual([...expected].sort())
  })
})

describe('effectiveFolderLevel — the one rule (ADR-0088)', () => {
  // [who, folder, expected level]
  const cases: Array<[string, FolderClearance, string | null, FolderLevel]> = [
    // The project root and inheriting folders: the project decides.
    ['anyone at the root', who(null), null, 'write'],
    ['someone on no list in an inheriting folder', who(null), F.verwaltung, 'write'],
    ['someone on no list in Pläne', who('member'), F.plaene, 'write'],
    // An own list: the people on it only, at the level of their folder role.
    ['gf in Verträge', who('gf'), F.vertraege, 'write'],
    ['pl in Verträge', who('pl'), F.vertraege, 'write'],
    ['bh in Verträge', who('bh'), F.vertraege, 'read'],
    ['someone on no list in Verträge', who('member'), F.vertraege, 'none'],
    ['no level held anywhere in Verträge', who(null), F.vertraege, 'none'],
    // Nesting narrows: the minimum over the folder and every ancestor with a list.
    ['gf in Honorare', who('gf'), F.honorare, 'write'],
    ['pl in Honorare (write above, read here)', who('pl'), F.honorare, 'read'],
    ['bh in Honorare (read above, write here: never wider)', who('bh'), F.honorare, 'read'],
    ['someone on no list in Honorare', who('member'), F.honorare, 'none'],
    // Everyone reads: every member reads, and only a folder role writes.
    ['someone on no list in Statik', who(null), F.statik, 'read'],
    ['pl in Statik', who('pl'), F.statik, 'write'],
    ['gf in Statik (on other lists, not this one)', who('gf'), F.statik, 'read'],
    ['someone on no list in Statik-Alt (inherits Statik)', who(null), F.statikAlt, 'read'],
    ['pl in Statik-Alt', who('pl'), F.statikAlt, 'write'],
    // Organization admins write everywhere the folder exists.
    ['an admin in Honorare', admin, F.honorare, 'write'],
    ['an admin in Verträge', who('member', true), F.vertraege, 'write'],
    ['an admin in Statik', admin, F.statik, 'write'],
    ['an admin in Pläne', admin, F.plaene, 'write'],
    // A tombstone keeps answering from its stored list.
    ['gf in a deleted folder', who('gf'), F.archiviert, 'read'],
    ['pl in a deleted folder', who('pl'), F.archiviert, 'none'],
    // Fail closed: an unknown id, a broken path.
    ['anyone in an unknown folder', who('gf'), '99999999-0000-4000-8000-000000000000', 'none'],
    ['an admin in an unknown folder', admin, '99999999-0000-4000-8000-000000000000', 'none'],
    ['anyone below a parent the tree lacks', who('gf'), F.waise, 'none'],
  ]

  it.each(cases)('%s', (_label, clearance, folderId, expected) => {
    expect(effectiveFolderLevel(tree, clearance, folderId)).toBe(expected)
  })

  it('never answers wider for a subfolder than for its parent, for any clearance in the table', () => {
    const clearances = [who(null), who('gf'), who('pl'), who('bh'), who('member'), admin]
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

  it('a person’s write on a child stays read under a parent they only read: nesting narrows', () => {
    // bh holds folder-editor on Honorare and only folder-reader on Verträge above it.
    expect(who('bh').levels[F.honorare]).toBe('write')
    expect(effectiveFolderLevel(tree, who('bh'), F.honorare)).toBe('read')
    // Without the parent's list, the same folder role writes.
    const flat = folderTree([inherit(F.vertraege, null), custom(F.honorare, F.vertraege)])
    expect(effectiveFolderLevel(flat, who('bh'), F.honorare)).toBe('write')
  })

  it('everyone reading gives read, never write', () => {
    for (const clearance of [ANY_MEMBER, who('member'), who('gf'), who('bh')]) {
      expect(effectiveFolderLevel(tree, clearance, F.statik)).toBe('read')
      expect(effectiveFolderLevel(tree, clearance, F.statikAlt)).toBe('read')
    }
  })

  it('ANY_MEMBER reads exactly the folders no list keeps from it: inheriting, or everyone reads', () => {
    const expected: Record<string, FolderLevel> = {
      [F.verwaltung]: 'write',
      [F.vertraege]: 'none',
      [F.honorare]: 'none',
      [F.plaene]: 'write',
      [F.statik]: 'read',
      [F.statikAlt]: 'read',
    }
    for (const [folderId, level] of Object.entries(expected)) {
      expect(effectiveFolderLevel(tree, ANY_MEMBER, folderId), folderId).toBe(level)
    }
    // Of the folders with their own list, exactly the ones everyone reads.
    const own = TREE.filter((folder) => folder.accessMode === 'custom')
    const readable = own.filter((folder) => atLeast(effectiveFolderLevel(tree, ANY_MEMBER, folder.id), 'read'))
    expect(readable.map((folder) => folder.id)).toEqual(own.filter((folder) => folder.everyoneReads).map((folder) => folder.id))
  })

  it('an admin writes every folder the tree holds, tombstones included', () => {
    for (const folder of TREE.filter((folder) => folder.id !== F.waise)) {
      expect(effectiveFolderLevel(tree, EVERY_FOLDER, folder.id), folder.id).toBe('write')
    }
  })

  it('guards a cycle instead of hanging', () => {
    const cyclic = folderTree([inherit('a', 'b'), custom('b', 'a')])
    expect(effectiveFolderLevel(cyclic, { levels: { b: 'write' }, seesEverything: false }, 'a')).toBe('none')
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
  const as = (person: Person | null, seesEverything = false) =>
    computeFolderAccess(TREE, who(person, seesEverything), COLLECTION)

  it('hides a folder the clearance may not read, and everything below it; a deleted folder from everyone', () => {
    const intern = as('member')
    expect([...intern.hiddenFolderIds].sort()).toEqual([F.vertraege, F.honorare, F.waise, F.archiviert].sort())
    // What is filed in a deleted folder is hidden from an admin too: the
    // Papierkorb is the one place it is seen.
    expect([...as(null, true).hiddenFolderIds]).toEqual([F.archiviert])
    expect(intern.isVisible(F.verwaltung)).toBe(true)
    expect(intern.isVisible(F.statik)).toBe(true)
    expect(intern.isVisible(null)).toBe(true)
    expect(as('gf').isVisible(F.archiviert)).toBe(false)
  })

  it('keys retrieval on READ: a list everyone does not read is its own collection, one everyone reads is not', () => {
    const access = as(null)
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
    expect(as('bh').clearedRestrictedCollections).toEqual([vertraege, honorare])
    expect(as('gf').clearedRestrictedCollections).toEqual([vertraege, honorare])
    expect(as('member').clearedRestrictedCollections).toEqual([])
  })

  it('names the source folder of each restricted collection, and nothing else', () => {
    const access = as(null)
    expect(access.sourceFolderOf(restrictedCollectionName(COLLECTION, F.honorare))).toBe(F.honorare)
    expect(access.sourceFolderOf(COLLECTION)).toBeNull()
    expect(access.sourceFolderOf(restrictedCollectionName(COLLECTION, F.statik))).toBeNull()
  })

  it('is the fast, open answer when no folder has its own list', () => {
    const open = computeFolderAccess(
      TREE.map((folder) => ({ ...folder, accessMode: 'inherit' as const, everyoneReads: false, deleted: false })),
      who(null),
      COLLECTION
    )
    expect(open.anyRestricted).toBe(false)
    expect(open.isVisible(F.vertraege)).toBe(true)
    expect(open.levelOf(F.vertraege)).toBe('write')
  })

  it('hides a folder in the bin and what is in it even when no folder has its own list', () => {
    const tree = TREE.map((folder) => ({ ...folder, accessMode: 'inherit' as const, everyoneReads: false }))
    const access = computeFolderAccess(tree, admin, COLLECTION)
    expect(access.anyRestricted).toBe(true)
    expect(access.isVisible(F.archiviert)).toBe(false)
    expect([...access.hiddenFolderIds]).toEqual([F.archiviert])
    // A purged tombstone holds nothing: it still never lists, but is no reason to load the tree.
    const purged = tree.map((folder) => (folder.deleted ? { ...folder, purgedAt: new Date() } : folder))
    expect(computeFolderAccess(purged, who(null), COLLECTION).anyRestricted).toBe(false)
    expect(computeFolderAccess(purged, who(null), COLLECTION).isVisible(F.archiviert)).toBe(false)
  })
})

describe('the helpers derived from the rule', () => {
  it('readableByEveryMember: only folders no list keeps from someone', () => {
    expect(readableByEveryMember(tree, F.plaene)).toBe(true)
    expect(readableByEveryMember(tree, F.statik)).toBe(true)
    expect(readableByEveryMember(tree, F.statikAlt)).toBe(true)
    expect(readableByEveryMember(tree, F.vertraege)).toBe(false)
    expect(readableByEveryMember(tree, F.archiviert)).toBe(false)
    expect(readableByEveryMember(tree, 'unknown')).toBe(false)
  })

  it('readRestrictingFoldersOnPath: nearest first, lists everyone reads excluded', () => {
    expect(readRestrictingFoldersOnPath(tree, F.honorare)).toEqual([F.honorare, F.vertraege])
    expect(readRestrictingFoldersOnPath(tree, F.statikAlt)).toEqual([])
    expect(readRestrictingFoldersOnPath(tree, null)).toEqual([])
  })

  it('unreadableFolderIds: what the clearance may not read, not a folder hidden only by the bin', () => {
    const access = (person: Person | null, seesEverything = false) =>
      unreadableFolderIds(computeFolderAccess(TREE, who(person, seesEverything), COLLECTION)).sort()
    // Archiviert is in the bin and lists gf: hidden from gf, but gf could read it.
    expect(access('gf')).toEqual([F.waise])
    expect(access('member')).toEqual([F.vertraege, F.honorare, F.waise, F.archiviert].sort())
    expect(access(null, true)).toEqual([])
    // A bin with no own list anywhere hides its folder from everyone and keeps it from no one.
    const open = TREE.filter((folder) => folder.id !== F.waise).map((folder) => ({
      ...folder,
      accessMode: 'inherit' as const,
      everyoneReads: false,
    }))
    expect(unreadableFolderIds(computeFolderAccess(open, who('member'), COLLECTION))).toEqual([])
  })

  it('names restricted collections as `_r` and twelve hex digits of the folder id', () => {
    const name = restrictedCollectionName(COLLECTION, F.vertraege)
    expect(name).toBe(`${COLLECTION}_r22222222aaaa`)
    expect(isRestrictedCollectionOf(COLLECTION, name)).toBe(true)
    expect(isRestrictedCollectionOf(COLLECTION, COLLECTION)).toBe(false)
  })
})

const session = (
  userId: Person | 'admin',
  permissions: string[] = [],
  organizationMembershipId = `om-${userId}`
): AuthorizedSession => ({
  userId,
  email: `${userId}@x`,
  name: null,
  accessToken: 't',
  organizationId: 'org-1',
  organizationMembershipId,
  role: 'member',
  roles: ['member'],
  permissions,
  featureFlags: null,
})

/** WorkOS's folder roles for each membership `om-<person>`, read through the mocked `heldFolderLevels`. */
function workosReportsTheLists(lists = LISTS) {
  vi.mocked(heldFolderLevels).mockImplementation(async (_org, membershipId) => {
    const person = membershipId.replace(/^om-/, '') as Person
    return levelsOf(person, lists)
  })
}

describe('the session loaders', () => {
  beforeEach(() => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockReset()
    vi.mocked(listProjectFolderTree).mockReset()
    vi.mocked(projectHasCustomFolders).mockReset()
    vi.mocked(projectHasCustomFolders).mockResolvedValue(true)
    vi.mocked(heldFolderLevels).mockReset()
    workosReportsTheLists()
    vi.mocked(requireProjectAccess).mockReset()
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor', closed: false, readsBecauseClosed: false })
    // WorkOS cannot be asked unless a test says what it answers: the token decides.
    vi.mocked(resolveMembershipRoles).mockResolvedValue(null)
  })

  it('clearanceOf: the levels WorkOS reports for the session’s membership in this project', async () => {
    expect(await clearanceOf(session('bh'), 'proj-1')).toEqual({ levels: levelsOf('bh'), seesEverything: false })
    expect(heldFolderLevels).toHaveBeenCalledWith('org-1', 'om-bh', 'proj-1')
  })

  it("with WorkOS unreachable the admin bypass is the token's permission", async () => {
    vi.mocked(resolveMembershipRoles).mockResolvedValue(null)
    expect(await clearanceOf(session('member', ['org:projects:administer']), 'proj-1')).toEqual(EVERY_FOLDER)
    expect((await clearanceOf(session('member'), 'proj-1')).seesEverything).toBe(false)
  })

  it('asks WorkOS for no folder role in a project where no folder has its own list', async () => {
    vi.mocked(projectHasCustomFolders).mockResolvedValue(false)
    expect(await clearanceOf(session('gf'), 'proj-1')).toEqual(ANY_MEMBER)
    expect(heldFolderLevels).not.toHaveBeenCalled()
  })

  it('asks WorkOS nothing for a session without a membership id, and clears no list', async () => {
    expect(await clearanceOf(session('gf', [], ''), 'proj-1')).toEqual(ANY_MEMBER)
    expect(heldFolderLevels).not.toHaveBeenCalled()
  })

  it('an admin is EVERY_FOLDER without a folder-role lookup', async () => {
    vi.mocked(resolveMembershipRoles).mockResolvedValue(['admin'])
    expect(await clearanceOf(session('admin'), 'proj-1')).toEqual(EVERY_FOLDER)
    expect(heldFolderLevels).not.toHaveBeenCalled()
  })

  it('takes the admin bypass from the membership as it is now, not from a token that outlives a demotion', async () => {
    // The token still lists org:projects:administer; WorkOS says the person now holds only `member`.
    vi.mocked(resolveMembershipRoles).mockResolvedValue(['member'])
    expect((await clearanceOf(session('member', ['org:projects:administer']), 'proj-1')).seesEverything).toBe(false)
  })

  it('grants the bypass to a promoted admin before the token is refreshed', async () => {
    vi.mocked(resolveMembershipRoles).mockResolvedValue(['admin'])
    expect((await clearanceOf(session('admin', []), 'proj-1')).seesEverything).toBe(true)
  })

  it('a demoted admin no longer reads or writes a folder whose list does not name them', async () => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(true)
    vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    vi.mocked(resolveMembershipRoles).mockResolvedValue(['member'])
    const demoted = session('member', ['org:projects:administer'])

    await expect(requireFolderWrite(demoted, 'proj-1', [F.honorare])).rejects.toBeInstanceOf(NotFoundError)
    expect((await getProjectFolderAccess(demoted, 'proj-1', COLLECTION)).isVisible(F.honorare)).toBe(false)
  })

  it('does not read the tree for a project where no folder has its own list', async () => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(false)
    const access = await getProjectFolderAccess(session('member'), 'proj-1', COLLECTION)
    expect(access.anyRestricted).toBe(false)
    expect(listProjectFolderTree).not.toHaveBeenCalled()
    expect(heldFolderLevels).not.toHaveBeenCalled()
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
    expect((await readableFolderIdsFor('org-1', 'proj-1', who('gf'))).sort()).toEqual(
      [F.verwaltung, F.vertraege, F.honorare, F.plaene, F.statik, F.statikAlt, F.archiviert].sort()
    )
    expect(await readableFolderIdsFor('org-1', 'proj-1', ANY_MEMBER)).not.toContain(F.vertraege)
  })

  it('filterUsersWhoMayReadFolder: each person by the folder roles WorkOS reports for them, the tree read once', async () => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(true)
    vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    const rolesOf: Record<string, string[] | null> = {
      gf: ['member'],
      bh: ['member'],
      member: ['member'],
      admin: ['admin'],
      down: null,
    }
    vi.mocked(resolveMembershipRoles).mockImplementation(async (_org, userId) => rolesOf[userId])

    const readers = await filterUsersWhoMayReadFolder('org-1', 'proj-1', F.vertraege, ['gf', 'bh', 'member', 'admin', 'down'])

    expect([...readers].sort()).toEqual(['admin', 'bh', 'gf'])
    expect(listProjectFolderTree).toHaveBeenCalledTimes(1)
  })

  it('filterUsersWhoMayReadFolder: asks nobody for the root or a project with no own list', async () => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(false)
    vi.mocked(resolveMembershipRoles).mockClear()

    expect([...(await filterUsersWhoMayReadFolder('org-1', 'proj-1', F.vertraege, ['a', 'b']))]).toEqual(['a', 'b'])
    expect([...(await filterUsersWhoMayReadFolder('org-1', 'proj-1', null, ['a']))]).toEqual(['a'])
    expect(resolveMembershipRoles).not.toHaveBeenCalled()
    expect(heldFolderLevels).not.toHaveBeenCalled()
  })

  it('clearanceOfMember: admin from any WorkOS role, else the folder roles of their membership', async () => {
    vi.mocked(resolveMembershipRoles).mockResolvedValue(['member', 'admin'])
    expect(await clearanceOfMember('org-1', 'bh', 'proj-1')).toEqual(EVERY_FOLDER)
    expect(heldFolderLevels).not.toHaveBeenCalled()

    vi.mocked(resolveMembershipRoles).mockResolvedValue(['member'])
    expect(await clearanceOfMember('org-1', 'bh', 'proj-1')).toEqual({ levels: levelsOf('bh'), seesEverything: false })
    expect(heldFolderLevels).toHaveBeenCalledWith('org-1', 'om-bh', 'proj-1')
  })

  it('clearanceOfMember: fails closed when the roles or the membership cannot be read', async () => {
    vi.mocked(resolveMembershipRoles).mockResolvedValue(null)
    expect(await clearanceOfMember('org-1', 'gf', 'proj-1')).toEqual(ANY_MEMBER)
    vi.mocked(resolveMembershipRoles).mockResolvedValue([])
    expect(await clearanceOfMember('org-1', 'gf', 'proj-1')).toEqual(ANY_MEMBER)

    const { resolveSubjectMembership } = await import('./project-membership')
    vi.mocked(resolveMembershipRoles).mockResolvedValue(['member'])
    vi.mocked(resolveSubjectMembership).mockResolvedValueOnce(null)
    expect(await clearanceOfMember('org-1', 'gf', 'proj-1')).toEqual(ANY_MEMBER)
    expect(heldFolderLevels).not.toHaveBeenCalled()
  })

  it('clearanceOfMember: no WorkOS folder-role call in a project where no folder has its own list', async () => {
    vi.mocked(resolveMembershipRoles).mockResolvedValue(['member'])
    vi.mocked(projectHasCustomFolders).mockResolvedValue(false)
    expect(await clearanceOfMember('org-1', 'gf', 'proj-1')).toEqual(ANY_MEMBER)
    expect(heldFolderLevels).not.toHaveBeenCalled()
  })
})

describe('a closed project (ADR-0090): closing opens no restricted folder', () => {
  const closed = { organizationId: 'org-1', deletedAt: null, status: 'closed' as const }

  beforeEach(() => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(true)
    vi.mocked(projectHasCustomFolders).mockResolvedValue(true)
    vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    vi.mocked(findProjectTenancy).mockResolvedValue(closed)
    vi.mocked(checkResourcePermission).mockReset()
    vi.mocked(heldFolderLevels).mockReset()
    workosReportsTheLists()
    vi.mocked(resolveMembershipRoles).mockImplementation(async (_org, userId) => (userId === 'admin' ? ['admin'] : ['member']))
  })

  afterEach(() => {
    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org-1', deletedAt: null, status: 'active' })
    vi.mocked(checkResourcePermission).mockResolvedValue(true)
  })

  it('someone who reads it only because it is closed clears what someone on no list clears, whatever WorkOS reports', async () => {
    vi.mocked(checkResourcePermission).mockResolvedValue(false)
    // gf holds folder-editor on Verträge and Honorare, but was never a member of the project.
    expect(await heldFolderLevels('org-1', 'om-gf', 'proj-1')).toEqual(levelsOf('gf'))
    expect(await clearanceOf(session('gf'), 'proj-1')).toEqual(ANY_MEMBER)
    const access = await getProjectFolderAccess(session('gf'), 'proj-1', COLLECTION)
    expect(access.isVisible(F.vertraege)).toBe(false)
    expect(access.isVisible(F.honorare)).toBe(false)
    expect(access.isVisible(F.verwaltung)).toBe(true)
    expect(access.clearedRestrictedCollections).toEqual([])
    expect(await clearanceOfMember('org-1', 'gf', 'proj-1')).toEqual(ANY_MEMBER)
  })

  it('a member of the project keeps exactly the folders their folder roles gave them', async () => {
    vi.mocked(checkResourcePermission).mockResolvedValue(true)
    expect((await clearanceOf(session('gf'), 'proj-1')).levels).toEqual(levelsOf('gf'))
    expect((await getProjectFolderAccess(session('gf'), 'proj-1', COLLECTION)).isVisible(F.honorare)).toBe(true)
    expect((await clearanceOfMember('org-1', 'gf', 'proj-1')).levels).toEqual(levelsOf('gf'))
  })

  it('an organization admin keeps the bypass, and asks no project grant for it', async () => {
    vi.mocked(resolveMembershipRoles).mockResolvedValue(['admin'])
    expect((await clearanceOf(session('admin'), 'proj-1')).seesEverything).toBe(true)
    expect((await clearanceOfMember('org-1', 'admin', 'proj-1')).seesEverything).toBe(true)
    expect(checkResourcePermission).not.toHaveBeenCalled()
  })

  it('the folders a name filter may match are decided per project: a closed one clears an outsider by no list', async () => {
    const active = { organizationId: 'org-1', deletedAt: null, status: 'active' as const }
    const shut = { vertraege: 'c1111111-aaaa-4bbb-8ccc-000000000001', plaene: 'c2222222-aaaa-4bbb-8ccc-000000000002' }
    vi.mocked(listProjectsWithCustomOrBinnedFolders).mockResolvedValue(['proj-active', 'proj-closed'])
    vi.mocked(findProjectTenancy).mockImplementation(async (projectId) => (projectId === 'proj-closed' ? closed : active))
    vi.mocked(listProjectFolderTree).mockImplementation(async (_org, projectId) =>
      projectId === 'proj-closed' ? [custom(shut.vertraege, null), inherit(shut.plaene, null)] : TREE
    )
    // WorkOS reports gf on the closed project's Verträge as well.
    workosReportsTheLists({ ...LISTS, [shut.vertraege]: { gf: 'write' } })
    vi.mocked(checkResourcePermission).mockResolvedValue(false)

    const readable = await readableFoldersOfRestrictedProjects(session('gf'))

    // gf reads Verträge where the folder role was matched before, and in the closed project only what every member reads.
    expect(readable).toContain(F.vertraege)
    expect(readable).toContain(shut.plaene)
    expect(readable).not.toContain(shut.vertraege)
  })

  it('reads the restricted projects a few at a time, never one by one nor all at once, and answers in their order', async () => {
    const projectIds = Array.from({ length: 10 }, (_, index) => `proj-${index}`)
    vi.mocked(listProjectsWithCustomOrBinnedFolders).mockResolvedValue(projectIds)
    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org-1', deletedAt: null, status: 'active' })
    let inFlight = 0
    let mostInFlight = 0
    vi.mocked(listProjectFolderTree).mockImplementation(async (_org, projectId) => {
      inFlight += 1
      mostInFlight = Math.max(mostInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5 - (Number(projectId.slice(5)) % 3)))
      inFlight -= 1
      return [inherit(`folder-of-${projectId}`, null)]
    })

    const readable = await readableFoldersOfRestrictedProjects(session('gf'))

    expect(mostInFlight).toBe(RESTRICTED_PROJECT_READS_AT_ONCE)
    expect(readable).toEqual(projectIds.map((projectId) => `folder-of-${projectId}`))
  })

  it('an active project never asks whether someone is a member: the folder roles decide as before', async () => {
    vi.mocked(findProjectTenancy).mockResolvedValue({ organizationId: 'org-1', deletedAt: null, status: 'active' })
    vi.mocked(checkResourcePermission).mockResolvedValue(false)
    expect((await clearanceOf(session('gf'), 'proj-1')).levels).toEqual(levelsOf('gf'))
    expect(checkResourcePermission).not.toHaveBeenCalled()
  })
})

describe('requireFolderWrite — the one write check', () => {
  beforeEach(() => {
    vi.mocked(projectHasCustomOrBinnedFolders).mockResolvedValue(true)
    vi.mocked(projectHasCustomFolders).mockResolvedValue(true)
    vi.mocked(listProjectFolderTree).mockClear()
    vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    vi.mocked(heldFolderLevels).mockReset()
    workosReportsTheLists()
    vi.mocked(requireProjectAccess).mockReset()
    vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor', closed: false, readsBecauseClosed: false })
    vi.mocked(resolveMembershipRoles).mockResolvedValue(null)
  })

  it('lets a writer write', async () => {
    await expect(requireFolderWrite(session('pl'), 'proj-1', [F.vertraege])).resolves.toBeUndefined()
    expect(requireProjectAccess).toHaveBeenCalledWith(expect.anything(), 'proj-1', ['project:documents:write', 'project:edit'])
  })

  it('refuses a read-only member with a typed 403', async () => {
    const refusal = await requireFolderWrite(session('bh'), 'proj-1', [F.vertraege]).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(ForbiddenError)
    expect((refusal as ForbiddenError).details).toEqual({ reason: FOLDER_READ_ONLY_REASON })
  })

  it('refuses someone on no list a write where everyone reads, with a typed 403', async () => {
    const refusal = await requireFolderWrite(session('member'), 'proj-1', [F.statik]).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(ForbiddenError)
  })

  it('answers not found for a folder the member may not read', async () => {
    await expect(requireFolderWrite(session('member'), 'proj-1', [F.vertraege])).rejects.toBeInstanceOf(NotFoundError)
  })

  it('refuses when any one of the folders touched is read-only (a move out of one)', async () => {
    await expect(requireFolderWrite(session('pl'), 'proj-1', [F.statik, F.honorare])).rejects.toBeInstanceOf(ForbiddenError)
  })

  it('keeps the project permission the ceiling: a granted writer without project write is refused before the folder', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    await expect(requireFolderWrite(session('gf'), 'proj-1', [F.vertraege])).rejects.toBeInstanceOf(NotFoundError)
    expect(await canWriteFolder(session('gf'), 'proj-1', F.vertraege)).toBe(false)
  })

  it('lets an organization admin write in a folder whose list does not name them', async () => {
    await expect(
      requireFolderWrite(session('member', ['org:projects:administer']), 'proj-1', [F.honorare])
    ).resolves.toBeUndefined()
  })

  it('refuses to write into a deleted folder', async () => {
    await expect(requireFolderWrite(session('gf'), 'proj-1', [F.archiviert])).rejects.toBeInstanceOf(NotFoundError)
  })

  it('needs only the project permission at the root', async () => {
    await expect(requireFolderWrite(session('member'), 'proj-1', [null])).resolves.toBeUndefined()
    expect(listProjectFolderTree).not.toHaveBeenCalled()
  })
})

describe('a list whose people have all left leaves its folder to the admins', () => {
  // Was „a role deleted in WorkOS" (ADR-0088). Lists name people now (ADR-0097),
  // so the flagging of folders naming a deleted role is gone; what the rule
  // does with a list that matches nobody is unchanged.
  const DEAD = '99999999-aaaa-4bbb-8ccc-0000000000a1'
  const CHILD_OF_DEAD = '99999999-aaaa-4bbb-8ccc-0000000000a5'
  const folders: AccessFolder[] = [custom(DEAD, null), inherit(CHILD_OF_DEAD, DEAD), inherit(F.plaene, null)]

  it('is readable by organization admins only: nobody holding no folder role on it reads or writes it', () => {
    const t = folderTree(folders)
    for (const person of [null, 'gf', 'pl', 'bh', 'member'] as const) {
      expect(effectiveFolderLevel(t, who(person), DEAD)).toBe('none')
    }
    expect(effectiveFolderLevel(t, admin, DEAD)).toBe('write')
    // What inherits from it is just as closed.
    expect(effectiveFolderLevel(t, who('pl'), CHILD_OF_DEAD)).toBe('none')
    expect(effectiveFolderLevel(t, admin, CHILD_OF_DEAD)).toBe('write')
  })

  it('hides it from a project listing for a non-admin and shows it to an admin', () => {
    expect(computeFolderAccess(folders, who('pl'), COLLECTION).hiddenFolderIds.has(DEAD)).toBe(true)
    expect(computeFolderAccess(folders, admin, COLLECTION).hiddenFolderIds.has(DEAD)).toBe(false)
  })
})

describe('a purged folder: the organization decides who sees what was derived from it', () => {
  // Archiviert (gf: read) after its purge, under each of the four settings.
  const purgedUnder = (policy: DeletedFolderContentPolicy) =>
    folderTree(
      TREE.map((folder) =>
        folder.id === F.archiviert ? { ...folder, purgedAt: new Date('2026-10-20T00:00:00Z'), purgedContent: policy } : folder
      )
    )

  it.each([
    ['unchanged', 'gf', 'read'],
    ['unchanged', 'pl', 'none'],
    ['project', 'pl', 'read'],
    ['project', null, 'read'],
    ['admins', 'gf', 'none'],
    ['remove', 'gf', 'none'],
  ] as const)('%s: %s reads it as %s', (policy, person, expected) => {
    expect(effectiveFolderLevel(purgedUnder(policy), who(person), F.archiviert)).toBe(expected)
  })

  it.each(['unchanged', 'project', 'admins', 'remove'] as const)('%s: an organization admin still reads it', (policy) => {
    expect(effectiveFolderLevel(purgedUnder(policy), admin, F.archiviert)).toBe('write')
  })

  it('leaves a folder in the bin (not purged) to its own list, whatever the setting', () => {
    const tree = folderTree(
      TREE.map((folder) => (folder.id === F.archiviert ? { ...folder, purgedContent: 'admins' as const } : folder))
    )
    expect(effectiveFolderLevel(tree, who('gf'), F.archiviert)).toBe('read')
  })
})
