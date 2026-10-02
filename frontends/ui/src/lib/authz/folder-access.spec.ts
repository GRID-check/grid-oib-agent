import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./folder-access-repository', () => ({
  projectHasRestrictedFolders: vi.fn(),
  listProjectFolderTree: vi.fn(),
}))

import type { AuthorizedSession } from '@/lib/auth/types'
import {
  clearanceOf,
  computeFolderAccess,
  getProjectFolderAccess,
  getRestrictedFolderIds,
  isRestrictedCollectionOf,
  restrictedCollectionName,
  type AccessFolder,
} from './folder-access'
import { listProjectFolderTree, projectHasRestrictedFolders } from './folder-access-repository'

const COLLECTION = 'proj_8f2c3b1e-0000-4000-8000-000000000001'
const F = {
  verwaltung: '11111111-aaaa-4bbb-8ccc-000000000001',
  vertraege: '22222222-aaaa-4bbb-8ccc-000000000002',
  honorare: '33333333-aaaa-4bbb-8ccc-000000000003',
  plaene: '44444444-aaaa-4bbb-8ccc-000000000004',
}

/**
 *   Verwaltung/                (open)
 *     Verträge/                (Geschäftsführung, Projektleitung)
 *       Honorare/              (Geschäftsführung)
 *   Pläne/                     (open)
 */
const TREE: AccessFolder[] = [
  { id: F.verwaltung, parentId: null, restrictedRoles: null },
  { id: F.vertraege, parentId: F.verwaltung, restrictedRoles: ['org-geschaeftsfuehrung', 'org-projektleitung'] },
  { id: F.honorare, parentId: F.vertraege, restrictedRoles: ['org-geschaeftsfuehrung'] },
  { id: F.plaene, parentId: null, restrictedRoles: null },
]

const as = (roles: string[], seesEverything = false) => computeFolderAccess(TREE, { roles, seesEverything }, COLLECTION)

describe('computeFolderAccess', () => {
  it('hides a restricted folder and everything below it from a member holding none of its roles', () => {
    const intern = as(['member'])
    expect([...intern.hiddenFolderIds].sort()).toEqual([F.vertraege, F.honorare].sort())
    expect(intern.isVisible(F.verwaltung)).toBe(true)
    expect(intern.isVisible(F.plaene)).toBe(true)
    expect(intern.isVisible(null)).toBe(true)
    expect(intern.clearedRestrictedCollections).toEqual([])
  })

  it('needs a role for EVERY restricted folder on the path: Projektleitung sees Verträge, not Honorare', () => {
    const lead = as(['org-projektleitung'])
    expect(lead.isVisible(F.vertraege)).toBe(true)
    expect(lead.isVisible(F.honorare)).toBe(false)
    expect(lead.clearedRestrictedCollections).toEqual([restrictedCollectionName(COLLECTION, F.vertraege)])
  })

  it('clears a holder of any one named role, from the roles claim', () => {
    const gf = as(['member', 'org-geschaeftsfuehrung'])
    expect(gf.hiddenFolderIds.size).toBe(0)
    expect([...gf.clearedRestrictedCollections].sort()).toEqual(
      [restrictedCollectionName(COLLECTION, F.vertraege), restrictedCollectionName(COLLECTION, F.honorare)].sort()
    )
  })

  it('lets an organization admin see everything, whatever roles the folders name', () => {
    const admin = as(['admin'], true)
    expect(admin.hiddenFolderIds.size).toBe(0)
    expect(admin.clearedRestrictedCollections).toHaveLength(2)
  })

  it('files a document in the collection of its NEAREST restricted folder', () => {
    const access = as([])
    expect(access.collectionFor(null)).toBe(COLLECTION)
    expect(access.collectionFor(F.plaene)).toBe(COLLECTION)
    expect(access.collectionFor(F.vertraege)).toBe(restrictedCollectionName(COLLECTION, F.vertraege))
    expect(access.collectionFor(F.honorare)).toBe(restrictedCollectionName(COLLECTION, F.honorare))
  })

  it('treats a folder the tree does not know as hidden, the safe direction', () => {
    expect(as(['member']).isVisible('99999999-0000-4000-8000-000000000009')).toBe(false)
  })

  it('is the fast, open answer when nothing is restricted', () => {
    const open = computeFolderAccess(
      TREE.map((folder) => ({ ...folder, restrictedRoles: null })),
      { roles: [], seesEverything: false },
      COLLECTION
    )
    expect(open.anyRestricted).toBe(false)
    expect(open.isVisible('anything')).toBe(true)
  })
})

describe('restricted collection names', () => {
  it('is the project collection, _r, and twelve hex digits; recognisable as its own', () => {
    const name = restrictedCollectionName(COLLECTION, F.vertraege)
    expect(name).toBe(`${COLLECTION}_r22222222aaaa`)
    expect(name.length).toBeLessThanOrEqual(63)
    expect(isRestrictedCollectionOf(COLLECTION, name)).toBe(true)
    expect(isRestrictedCollectionOf(COLLECTION, COLLECTION)).toBe(false)
    expect(isRestrictedCollectionOf(COLLECTION, `${COLLECTION}_rnothex000000`)).toBe(false)
  })
})

describe('clearanceOf and the loader', () => {
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

  it('reads every role of the roles claim, and the single role when there is none', () => {
    expect(clearanceOf(session(['member', 'org-geschaeftsfuehrung'])).roles).toEqual(['member', 'org-geschaeftsfuehrung'])
    expect(clearanceOf(session(undefined)).roles).toEqual(['member'])
    expect(clearanceOf(session(undefined, ['org:projects:administer'])).seesEverything).toBe(true)
  })

  it('does not read the tree for a project that restricts nothing', async () => {
    vi.mocked(projectHasRestrictedFolders).mockResolvedValue(false)
    const access = await getProjectFolderAccess(session(['member']), 'proj-1', COLLECTION)
    expect(access.anyRestricted).toBe(false)
    expect(listProjectFolderTree).not.toHaveBeenCalled()
  })

  it('decides over the tree when something is restricted', async () => {
    vi.mocked(projectHasRestrictedFolders).mockResolvedValue(true)
    vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    const access = await getProjectFolderAccess(session(['member']), 'proj-1', COLLECTION)
    expect(access.isVisible(F.vertraege)).toBe(false)
  })
})

describe('getRestrictedFolderIds — the answer for a caller with no session', () => {
  it('is every folder under a restriction, whatever roles anyone holds', async () => {
    vi.mocked(projectHasRestrictedFolders).mockResolvedValue(true)
    vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
    expect((await getRestrictedFolderIds('org-1', 'proj-1')).sort()).toEqual([F.vertraege, F.honorare].sort())
  })

  it('does not read the tree for a project that restricts nothing', async () => {
    vi.mocked(projectHasRestrictedFolders).mockResolvedValue(false)
    expect(await getRestrictedFolderIds('org-1', 'proj-1')).toEqual([])
    expect(listProjectFolderTree).not.toHaveBeenCalled()
  })
})
