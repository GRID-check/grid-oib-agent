/**
 * @vitest-environment node
 */
/**
 * Who may be served a permit record, judged from the document's live folder
 * against the project's folder tree, never from the restriction stored on the
 * record (`live-access.ts`).
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/folder-access', async () => ({
  ...(await vi.importActual<typeof import('@/lib/authz/folder-access-rule')>('@/lib/authz/folder-access-rule')),
  loadCustomFolderTree: vi.fn(),
}))
vi.mock('@/lib/projects/memory-service', () => ({
  canonicalRestriction: (ids: readonly string[] | null | undefined) => {
    const unique = [...new Set(ids ?? [])].sort()
    return unique.length > 0 ? unique : null
  },
}))

import type { AccessFolder } from '@/lib/authz/folder-access-rule'
import { liveFolderAccessOf } from './live-access'

const folder = (id: string, extra: Partial<AccessFolder> = {}): AccessFolder => ({
  id,
  parentId: null,
  accessMode: 'inherit',
  everyoneReads: false,
  ...extra,
})
const custom = (id: string, parentId: string | null = null): AccessFolder =>
  folder(id, { parentId, accessMode: 'custom', everyoneReads: false })

describe('liveFolderAccessOf', () => {
  it('serves every folder of a project with no restricted and no binned folder', () => {
    const access = liveFolderAccessOf(null, [])
    expect(access.visibleFolderIds).toBeNull()
    expect(access.restrictionOf('anything')).toBeNull()
  })

  it('serves an open folder, and a restricted one only to a reader cleared for every folder restricting it', () => {
    const tree = [folder('open'), custom('outer'), custom('inner', 'outer'), folder('below', { parentId: 'inner' })]

    expect(liveFolderAccessOf(tree, []).visibleFolderIds).toEqual(['open'])
    expect(liveFolderAccessOf(tree, ['outer']).visibleFolderIds).toEqual(['open', 'outer'])
    expect(liveFolderAccessOf(tree, ['outer', 'inner']).visibleFolderIds).toEqual(['open', 'outer', 'inner', 'below'])
    expect(liveFolderAccessOf(tree, []).restrictionOf('below')).toEqual(['inner', 'outer'])
    expect(liveFolderAccessOf(tree, []).restrictionOf('open')).toBeNull()
  })

  it('serves nothing from a folder in the Papierkorb or below one, to anyone', () => {
    const tree = [folder('bin', { deleted: true }), folder('child', { parentId: 'bin' }), folder('kept')]
    expect(liveFolderAccessOf(tree, ['bin', 'child']).visibleFolderIds).toEqual(['kept'])
  })

  it('a folder with its own list that every member may read restricts nobody', () => {
    const tree = [folder('team', { accessMode: 'custom', everyoneReads: true })]
    expect(liveFolderAccessOf(tree, []).visibleFolderIds).toEqual(['team'])
    expect(liveFolderAccessOf(tree, []).restrictionOf('team')).toBeNull()
  })
})
