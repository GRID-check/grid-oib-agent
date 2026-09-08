/**
 * What a document menu offers — independent of whether it opens from ⋯ or a
 * right-click. The renderer is tested in action-menu.spec; this file pins the
 * heuristics: a viewer who may not mutate sees nothing that mutates, a failed
 * document is the only one that offers retry, and an empty move submenu is
 * not a submenu.
 */

import { describe, expect, it, vi } from 'vitest'
import { documentActionEntries, type DocumentActionLabels } from './action-entries'

const LABELS: DocumentActionLabels = {
  open: 'Open',
  ask: 'Ask about this',
  download: 'Download',
  rename: 'Rename…',
  move: 'Move to folder',
  copyOriginPath: 'Copy origin path',
  delete: 'Delete…',
  reingest: 'Retry indexing',
  reingesting: 'Retrying…',
  allFiles: 'All Files',
}

const DOCUMENT = { id: 'doc-1', filename: 'Einreichplan_EG.pdf', displayName: null }

const handlers = {
  onDownload: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onReingest: vi.fn(),
  onMove: vi.fn(),
}

function ids(document: Parameters<typeof documentActionEntries>[0]['document'], extra: Partial<Parameters<typeof documentActionEntries>[0]> = {}) {
  return documentActionEntries({
    document,
    labels: LABELS,
    ...handlers,
    ...extra,
  })
    .filter((entry) => entry.type === 'item' || entry.type === 'sub')
    .map((entry) => entry.id)
}

describe('documentActionEntries', () => {
  it('carries download, rename and delete by default, with delete set apart', () => {
    const entries = documentActionEntries({
      document: DOCUMENT,
      labels: LABELS,
      ...handlers,
    })
    const itemIds = entries.filter((e) => e.type === 'item' || e.type === 'sub').map((e) => e.id)
    expect(itemIds).toEqual(['download', 'rename', 'delete'])
    const del = entries.find((e) => e.type === 'item' && e.id === 'delete')
    expect(del?.type === 'item' && del.variant).toBe('destructive')
    expect(entries.some((e) => e.type === 'separator')).toBe(true)
  })

  it('offers only what the surface asked for', () => {
    expect(
      ids(DOCUMENT, { actions: ['rename', 'delete'] }),
    ).toEqual(['rename', 'delete'])
  })

  it('keeps download for a read-only viewer and drops the mutations', () => {
    expect(ids(DOCUMENT, { canManage: false })).toEqual(['download'])
  })

  it('renders nothing at all when a read-only viewer would see an empty menu', () => {
    expect(ids(DOCUMENT, { actions: ['rename', 'delete'], canManage: false })).toEqual([])
  })

  it('offers retry only for a failed document the viewer may manage', () => {
    expect(ids({ ...DOCUMENT, status: 'failed' })).toContain('reingest')
    expect(ids(DOCUMENT)).not.toContain('reingest')
    expect(ids({ ...DOCUMENT, status: 'failed' }, { canManage: false })).not.toContain('reingest')
  })

  it('does not offer move when there is nowhere to move it to', () => {
    expect(ids(DOCUMENT)).not.toContain('move')
    expect(ids(DOCUMENT, { folders: [{ id: 'f1', name: 'Brandschutz', parentId: null }] })).toContain(
      'move',
    )
  })

  it('offers open and ask only when the surface can do them', () => {
    expect(ids(DOCUMENT, { onOpen: vi.fn(), onAsk: vi.fn() })).toEqual([
      'open',
      'ask',
      'download',
      'rename',
      'delete',
    ])
  })

  it('offers copy origin path only when the file has one', () => {
    expect(ids(DOCUMENT, { onCopyOriginPath: vi.fn() })).not.toContain('copy-origin')
    expect(
      ids(
        { ...DOCUMENT, originPath: 'Wohnbau/EG.pdf' },
        { onCopyOriginPath: vi.fn() },
      ),
    ).toContain('copy-origin')
  })
})
