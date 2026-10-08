/**
 * @vitest-environment node
 *
 * Folders not every member may read do not hold IFC models (ADR-0086, ADR-0087). The folder tree is the
 * decision's own core, run for real; only the two reads are stubbed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/authz/folder-access-repository', () => ({
  projectHasCustomFolders: vi.fn(),
  listProjectFolderTree: vi.fn(),
  countIfcDocumentsInFolders: vi.fn(),
}))

import { ConflictError } from '@/lib/api/errors'
import type { AccessFolder } from '@/lib/authz/folder-access'
import {
  countIfcDocumentsInFolders,
  listProjectFolderTree,
  projectHasCustomFolders,
} from '@/lib/authz/folder-access-repository'
import {
  assertFolderMoveKeepsIfcOpen,
  assertIfcMayBeFiledIn,
  assertRestrictionKeepsIfcOpen,
  subtreeOf,
} from './ifc-folder-guard'

/**
 *   Modelle/              (open)
 *     Archiv/             (open)
 *   Verwaltung/           (Geschäftsführung)
 *   Pläne/                (open)
 */
const GF = [{ role: 'org-geschaeftsfuehrung', level: 'write' as const }]
const TREE: AccessFolder[] = [
  { id: 'modelle', parentId: null, accessMode: 'inherit', grants: [] },
  { id: 'modelle-archiv', parentId: 'modelle', accessMode: 'inherit', grants: [] },
  { id: 'verwaltung', parentId: null, accessMode: 'custom', grants: GF },
  { id: 'plaene', parentId: null, accessMode: 'inherit', grants: [] },
  // A list that narrows only who writes: every member still reads, so it is no restriction here.
  { id: 'freigaben', parentId: null, accessMode: 'custom', grants: [{ role: '*', level: 'read' }, ...GF] },
]

beforeEach(() => {
  vi.mocked(listProjectFolderTree).mockResolvedValue(TREE)
  vi.mocked(projectHasCustomFolders).mockResolvedValue(true)
  vi.mocked(countIfcDocumentsInFolders).mockResolvedValue(0)
})

describe('assertIfcMayBeFiledIn', () => {
  it('refuses an IFC model bound for a restricted collection, with a 409 naming why', () => {
    expect(() => assertIfcMayBeFiledIn('Haus.ifc', 'proj_1_r0123456789ab', 'proj_1')).toThrow(ConflictError)
    expect(() => assertIfcMayBeFiledIn(' Haus.IFCZIP ', 'proj_1_r0123456789ab', 'proj_1')).toThrow(
      /IFC models cannot be filed in a restricted folder yet/
    )
  })

  it('lets an IFC model into the project collection, and anything else anywhere', () => {
    expect(() => assertIfcMayBeFiledIn('Haus.ifc', 'proj_1', 'proj_1')).not.toThrow()
    expect(() => assertIfcMayBeFiledIn('Vertrag.pdf', 'proj_1_r0123456789ab', 'proj_1')).not.toThrow()
  })
})

describe('assertRestrictionKeepsIfcOpen', () => {
  it('refuses restricting a folder whose subtree holds IFC models, and counts them', async () => {
    vi.mocked(countIfcDocumentsInFolders).mockResolvedValue(2)

    const error = await assertRestrictionKeepsIfcOpen('org-1', 'proj-1', 'modelle', GF).catch(
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(ConflictError)
    expect(error).toMatchObject({
      status: 409,
      message: expect.stringContaining('hold 2 IFC models'),
      details: { code: 'IFC_IN_RESTRICTED_FOLDER', models: 2 },
    })
    // The folder and everything below it is what the restriction would cover.
    const [, , folderIds] = vi.mocked(countIfcDocumentsInFolders).mock.calls[0]
    expect([...folderIds].sort()).toEqual(['modelle', 'modelle-archiv'])
  })

  it('allows the restriction when the subtree holds no IFC model', async () => {
    await expect(
      assertRestrictionKeepsIfcOpen('org-1', 'proj-1', 'plaene', GF)
    ).resolves.toBeUndefined()
    expect(countIfcDocumentsInFolders).toHaveBeenCalledWith('org-1', 'proj-1', ['plaene'])
  })

  it('never refuses opening a folder, and reads nothing to decide that', async () => {
    await expect(assertRestrictionKeepsIfcOpen('org-1', 'proj-1', 'verwaltung', null)).resolves.toBeUndefined()
    await expect(assertRestrictionKeepsIfcOpen('org-1', 'proj-1', 'verwaltung', [])).resolves.toBeUndefined()
    expect(listProjectFolderTree).not.toHaveBeenCalled()
    expect(countIfcDocumentsInFolders).not.toHaveBeenCalled()
  })
})

describe('assertFolderMoveKeepsIfcOpen', () => {
  it('refuses moving a folder holding an IFC model under a restricted one', async () => {
    vi.mocked(countIfcDocumentsInFolders).mockResolvedValue(1)

    await expect(assertFolderMoveKeepsIfcOpen('org-1', 'proj-1', 'modelle', 'verwaltung')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('hold 1 IFC model,'),
      details: { code: 'IFC_IN_RESTRICTED_FOLDER', models: 1 },
    })
    const [, , folderIds] = vi.mocked(countIfcDocumentsInFolders).mock.calls[0]
    expect([...folderIds].sort()).toEqual(['modelle', 'modelle-archiv'])
  })

  it('asks about no folder when the destination narrows only who writes (`*` reads)', async () => {
    await expect(assertFolderMoveKeepsIfcOpen('org-1', 'proj-1', 'modelle', 'freigaben')).resolves.toBeUndefined()
    expect(countIfcDocumentsInFolders).toHaveBeenCalledWith('org-1', 'proj-1', [])
  })

  it('asks about no folder when the destination is open', async () => {
    await expect(assertFolderMoveKeepsIfcOpen('org-1', 'proj-1', 'modelle', 'plaene')).resolves.toBeUndefined()
    expect(countIfcDocumentsInFolders).toHaveBeenCalledWith('org-1', 'proj-1', [])
  })

  it('reads nothing more for a project that restricts nothing', async () => {
    vi.mocked(projectHasCustomFolders).mockResolvedValue(false)
    await expect(assertFolderMoveKeepsIfcOpen('org-1', 'proj-1', 'modelle', 'plaene')).resolves.toBeUndefined()
    expect(listProjectFolderTree).not.toHaveBeenCalled()
  })
})

describe('subtreeOf', () => {
  it('is the folder and everything below it', () => {
    expect(subtreeOf(TREE, 'modelle').sort()).toEqual(['modelle', 'modelle-archiv'])
    expect(subtreeOf(TREE, 'plaene')).toEqual(['plaene'])
  })
})
