import { describe, expect, it } from 'vitest'
import { DOCUMENT_STATUS_FACTS, type KnownDocumentStatus } from '@/lib/documents/document-status'
import type { FileItem, FolderItem } from '../file-types'
import {
  MAX_HOTSPOTS,
  buildFolderBrief,
  emptyTally,
  filesInSubtree,
  isUnplaced,
  readShare,
  readStateOf,
  subtreeFolderIds,
  subtreeTallies,
  tallyOf,
  type ReadState,
} from './folder-knowledge'

const file = (overrides: Partial<FileItem> & { id: string }): FileItem => ({
  filename: 'doc.pdf',
  displayName: null,
  fileSize: 1,
  contentType: 'application/pdf',
  status: 'ready',
  folderId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
  ...overrides,
})

const folder = (id: string, name: string, parentId: string | null = null): FolderItem => ({
  id,
  name,
  parentId,
  path: name,
})

/**
 * Every declared status and the read state it must map to. Typed over
 * KnownDocumentStatus, so a status added to DOCUMENT_STATUS_FACTS fails the
 * typecheck here until somebody decides what it means for reading.
 */
const EXPECTED_READ_STATE: Record<KnownDocumentStatus, ReadState> = {
  ready: 'readable',
  ingested: 'readable',
  success: 'readable',
  completed: 'readable',
  processed: 'readable',
  uploading: 'reading',
  pending: 'reading',
  processing: 'reading',
  ingesting: 'reading',
  failed: 'failed',
  error: 'failed',
  quarantined: 'held',
  stored: 'unindexed',
  uploaded: 'unindexed',
}

describe('readStateOf', () => {
  it('declares a read state for exactly the statuses in DOCUMENT_STATUS_FACTS', () => {
    expect(Object.keys(EXPECTED_READ_STATE).sort()).toEqual(Object.keys(DOCUMENT_STATUS_FACTS).sort())
  })

  it.each(Object.entries(EXPECTED_READ_STATE))('maps %s to %s', (status, state) => {
    expect(readStateOf(status)).toBe(state)
  })

  it('ignores case, because the reading surfaces always have', () => {
    expect(readStateOf('READY')).toBe('readable')
    expect(readStateOf('Failed')).toBe('failed')
    expect(readStateOf('Quarantined')).toBe('held')
    expect(readStateOf('Uploaded')).toBe('unindexed')
  })

  it('reads an unknown status as still being read, never as citable', () => {
    expect(readStateOf('some-new-state')).toBe('reading')
    expect(readStateOf('')).toBe('reading')
  })

  it('reads null and undefined as still being read', () => {
    expect(readStateOf(null)).toBe('reading')
    expect(readStateOf(undefined)).toBe('reading')
  })

  it('does not answer from Object.prototype for a status named like one', () => {
    expect(readStateOf('constructor')).toBe('reading')
    expect(readStateOf('toString')).toBe('reading')
  })
})

describe('isUnplaced', () => {
  it('is true for a readable document in no document type', () => {
    expect(isUnplaced({ status: 'ready', tags: null })).toBe(true)
    expect(isUnplaced({ status: 'ready', tags: [] })).toBe(true)
  })

  it('is true for a readable document whose only tags are disciplines', () => {
    expect(isUnplaced({ status: 'ready', tags: ['Brandschutz'] })).toBe(true)
  })

  it('is true when the only tag is outside the vocabulary', () => {
    expect(isUnplaced({ status: 'ready', tags: ['Unbekannt'] })).toBe(true)
  })

  it('is false for a readable document with a document type', () => {
    expect(isUnplaced({ status: 'ready', tags: ['Grundriss'] })).toBe(false)
    expect(isUnplaced({ status: 'ready', tags: ['Brandschutz', 'Grundriss'] })).toBe(false)
  })

  it('is false for a document that is not readable, because it is counted under its own state', () => {
    expect(isUnplaced({ status: 'failed', tags: null })).toBe(false)
    expect(isUnplaced({ status: 'processing', tags: null })).toBe(false)
    expect(isUnplaced({ status: 'quarantined', tags: null })).toBe(false)
    expect(isUnplaced({ status: 'stored', tags: ['Brandschutz'] })).toBe(false)
  })
})

describe('tallyOf', () => {
  it('is the empty tally for no files', () => {
    expect(tallyOf([])).toEqual(emptyTally())
  })

  it('counts each read state, unplaced documents, pages and the newest createdAt', () => {
    const files = [
      file({ id: 'a', status: 'ready', tags: ['Grundriss'], pageCount: 10, createdAt: '2026-01-02T00:00:00.000Z' }),
      file({ id: 'b', status: 'ingested', tags: null, pageCount: 0, createdAt: '2026-01-05T00:00:00.000Z' }),
      file({ id: 'c', status: 'completed', tags: ['Brandschutz'], pageCount: null, createdAt: '2026-01-03T00:00:00.000Z' }),
      file({ id: 'd', status: 'processing', createdAt: '2026-01-04T00:00:00.000Z' }),
      file({ id: 'e', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' }),
      file({ id: 'f', status: 'failed', pageCount: 99, createdAt: '2026-01-06T00:00:00.000Z' }),
      file({ id: 'g', status: 'error', createdAt: '2026-01-02T12:00:00.000Z' }),
      file({ id: 'h', status: 'quarantined', pageCount: 7, createdAt: '2026-01-07T00:00:00.000Z' }),
      file({ id: 'i', status: 'stored', pageCount: 5, createdAt: '2025-12-31T00:00:00.000Z' }),
      file({ id: 'j', status: 'uploaded', createdAt: '2026-01-01T06:00:00.000Z' }),
    ]

    expect(tallyOf(files)).toEqual({
      total: 10,
      readable: 3,
      reading: 2,
      failed: 2,
      held: 1,
      unindexed: 2,
      unplaced: 2,
      // Pages count only readable documents: 10 + 0 (the 0 adds nothing), the
      // failed 99, the held 7 and the stored 5 are all excluded.
      pages: 10,
      // The newest createdAt across ALL files, not only the readable ones.
      latest: '2026-01-07T00:00:00.000Z',
    })
  })

  it('counts a readable document with a null or zero pageCount as zero pages', () => {
    expect(tallyOf([file({ id: 'a', status: 'ready', pageCount: null })]).pages).toBe(0)
    expect(tallyOf([file({ id: 'a', status: 'ready', pageCount: 0 })]).pages).toBe(0)
  })

  it('leaves latest null when no file carries a createdAt', () => {
    expect(tallyOf([file({ id: 'a', createdAt: '' })]).latest).toBeNull()
  })
})

describe('readShare', () => {
  it('is the share of readable documents among those meant to be read, leaving out unindexed', () => {
    const tally = tallyOf([
      file({ id: 'a', status: 'ready' }),
      file({ id: 'b', status: 'ready' }),
      file({ id: 'c', status: 'processing' }),
      file({ id: 'd', status: 'stored' }),
      file({ id: 'e', status: 'uploaded' }),
      file({ id: 'f', status: 'stored' }),
    ])
    // 2 readable out of the 3 meant to be read (a, b, c): the three unindexed rows do not dilute it.
    expect(readShare(tally)).toBeCloseTo(2 / 3)
  })

  it('counts failed and held documents in the denominator', () => {
    expect(readShare(tallyOf([file({ id: 'a', status: 'ready' }), file({ id: 'b', status: 'failed' })]))).toBe(0.5)
    expect(readShare(tallyOf([file({ id: 'a', status: 'ready' }), file({ id: 'b', status: 'quarantined' })]))).toBe(0.5)
  })

  it('is one when everything meant to be read is readable', () => {
    expect(readShare(tallyOf([file({ id: 'a', status: 'ready' }), file({ id: 'b', status: 'stored' })]))).toBe(1)
  })

  it('is null when there is nothing to read: an empty tally', () => {
    expect(readShare(emptyTally())).toBeNull()
  })

  it('is null when there is nothing to read: only unindexed documents', () => {
    expect(readShare(tallyOf([file({ id: 'a', status: 'stored' }), file({ id: 'b', status: 'uploaded' })]))).toBeNull()
  })
})

/**
 * A three-level tree with a sibling:
 *
 *   A ── B ── C
 *   D
 */
const TREE = [folder('A', 'A'), folder('B', 'B', 'A'), folder('C', 'C', 'B'), folder('D', 'D')]

describe('subtreeTallies', () => {
  const fa = file({ id: 'fa', folderId: 'A', status: 'ready', tags: ['Grundriss'], pageCount: 2, createdAt: '2026-01-01T00:00:00.000Z' })
  const fb = file({ id: 'fb', folderId: 'B', status: 'failed', createdAt: '2026-01-03T00:00:00.000Z' })
  const fc = file({ id: 'fc', folderId: 'C', status: 'processing', createdAt: '2026-01-02T00:00:00.000Z' })
  const fd = file({ id: 'fd', folderId: 'D', status: 'ready', tags: null, createdAt: '2026-01-04T00:00:00.000Z' })
  const orphan = file({ id: 'orphan', folderId: null, status: 'failed', createdAt: '2026-02-01T00:00:00.000Z' })

  it('gives a leaf folder the tally of its own documents', () => {
    const tallies = subtreeTallies([fa, fb, fc, fd, orphan], TREE)
    expect(tallies.get('C')).toEqual(tallyOf([fc]))
  })

  it("folds a folder's children into its tally, all the way up", () => {
    const tallies = subtreeTallies([fa, fb, fc, fd, orphan], TREE)
    expect(tallies.get('B')).toEqual(tallyOf([fb, fc]))
    expect(tallies.get('A')).toEqual(tallyOf([fa, fb, fc]))
  })

  it('keeps an independent sibling independent', () => {
    const tallies = subtreeTallies([fa, fb, fc, fd, orphan], TREE)
    expect(tallies.get('D')).toEqual(tallyOf([fd]))
    expect(tallies.get('A')?.total).toBe(3)
  })

  it('ignores files with no folder', () => {
    const tallies = subtreeTallies([orphan], TREE)
    expect(tallies.get('A')).toEqual(emptyTally())
    expect(tallies.get('D')).toEqual(emptyTally())
    expect(tallies.get('A')?.failed).toBe(0)
  })

  it('has an entry for every folder in the listing, including those with no documents', () => {
    const tallies = subtreeTallies([], TREE)
    expect([...tallies.keys()].sort()).toEqual(['A', 'B', 'C', 'D'])
    for (const tally of tallies.values()) expect(tally).toEqual(emptyTally())
  })

  it('terminates on a parentId cycle without throwing', () => {
    const x = folder('X', 'X', 'Y')
    const y = folder('Y', 'Y', 'X')
    const files = [
      file({ id: 'fx', folderId: 'X', status: 'failed' }),
      file({ id: 'fy', folderId: 'Y', status: 'ready' }),
    ]
    let tallies: ReturnType<typeof subtreeTallies> | undefined
    expect(() => {
      tallies = subtreeTallies(files, [x, y])
    }).not.toThrow()
    expect(tallies?.get('X')?.failed).toBe(1)
    expect(tallies?.get('Y')?.readable).toBe(1)
  })

  it('terminates on a folder that is its own parent', () => {
    const self = folder('S', 'S', 'S')
    const tallies = subtreeTallies([file({ id: 'fs', folderId: 'S', status: 'failed' })], [self])
    expect(tallies.get('S')?.failed).toBe(1)
  })
})

describe('subtreeFolderIds', () => {
  it('is null for the shelf root, meaning everything', () => {
    expect(subtreeFolderIds(TREE, null)).toBeNull()
  })

  it('holds the folder and every folder beneath it, not its siblings', () => {
    expect(subtreeFolderIds(TREE, 'A')).toEqual(new Set(['A', 'B', 'C']))
    expect(subtreeFolderIds(TREE, 'B')).toEqual(new Set(['B', 'C']))
  })

  it('holds only the folder itself when it has no children', () => {
    expect(subtreeFolderIds(TREE, 'C')).toEqual(new Set(['C']))
  })

  it('still holds a folder that is not in the listing', () => {
    expect(subtreeFolderIds(TREE, 'ghost')).toEqual(new Set(['ghost']))
  })

  it('terminates on a parentId cycle and holds both members', () => {
    const cycle = [folder('X', 'X', 'Y'), folder('Y', 'Y', 'X')]
    expect(subtreeFolderIds(cycle, 'X')).toEqual(new Set(['X', 'Y']))
  })
})

describe('filesInSubtree', () => {
  const files = [
    file({ id: 'fa', folderId: 'A' }),
    file({ id: 'fb', folderId: 'B' }),
    file({ id: 'fc', folderId: 'C' }),
    file({ id: 'fd', folderId: 'D' }),
    file({ id: 'shelf', folderId: null }),
  ]

  it('returns the same array instance for the shelf root', () => {
    expect(filesInSubtree(files, TREE, null)).toBe(files)
  })

  it('returns the documents anywhere under a folder, and only those', () => {
    expect(filesInSubtree(files, TREE, 'B').map((f) => f.id)).toEqual(['fb', 'fc'])
    expect(filesInSubtree(files, TREE, 'A').map((f) => f.id)).toEqual(['fa', 'fb', 'fc'])
  })

  it('leaves out documents with no folder when the root is a folder', () => {
    expect(filesInSubtree(files, TREE, 'A').some((f) => f.folderId === null)).toBe(false)
  })
})

describe('buildFolderBrief', () => {
  /**
   * Under A (the brief's folder): three readable documents with types, one
   * untyped readable document, a quarantined document, a failed one and one
   * still being read. D is a sibling that must never leak in.
   */
  const r1 = file({
    id: 'r1',
    folderId: 'A',
    status: 'ready',
    tags: ['Grundriss', 'Brandschutz'],
    contentTypes: ['text', 'table'],
  })
  const r2 = file({
    id: 'r2',
    folderId: 'B',
    status: 'ingested',
    tags: ['Grundriss', 'Schallschutz', 'Brandschutz'],
    contentTypes: ['text', 'text', 'image'],
  })
  const r3 = file({
    id: 'r3',
    folderId: 'C',
    status: 'completed',
    // The same discipline twice on one document is still one document.
    tags: ['Schnitt', 'Brandschutz', 'Brandschutz'],
    contentTypes: ['chart'],
  })
  const u1 = file({ id: 'u1', folderId: 'A', status: 'ready', tags: ['Brandschutz', 'Frei erfunden'] })
  const q1 = file({
    id: 'q1',
    folderId: 'A',
    status: 'quarantined',
    tags: ['Bescheid', 'Standsicherheit'],
    contentTypes: ['drawing'],
  })
  const f1 = file({ id: 'f1', folderId: 'B', status: 'failed', tags: ['Gutachten'], contentTypes: ['table'] })
  const p1 = file({ id: 'p1', folderId: 'C', status: 'processing', tags: ['Gutachten'] })
  const outside = file({ id: 'outside', folderId: 'D', status: 'failed', tags: ['Vertrag'] })
  const files = [r1, r2, r3, u1, q1, f1, p1, outside]

  it('tallies the whole subtree under the brief folder', () => {
    const brief = buildFolderBrief(files, TREE, 'A')
    expect(brief.files.map((f) => f.id)).toEqual(['r1', 'r2', 'r3', 'u1', 'q1', 'f1', 'p1'])
    expect(brief.tally.total).toBe(7)
    expect(brief.tally.readable).toBe(4)
    expect(brief.tally.reading).toBe(1)
    expect(brief.tally.failed).toBe(1)
    expect(brief.tally.held).toBe(1)
    expect(brief.tally.unplaced).toBe(1)
  })

  it('counts document types only from readable documents, most frequent first', () => {
    const brief = buildFolderBrief(files, TREE, 'A')
    // Grundriss on r1 and r2; Schnitt on r3. Gutachten sits on a failed and a
    // processing document, and Bescheid on a quarantined one: none are counted.
    expect(brief.documentTypes).toEqual([
      { label: 'Grundriss', count: 2 },
      { label: 'Schnitt', count: 1 },
    ])
  })

  it('counts disciplines only from readable documents, and a repeated tag once per document', () => {
    const brief = buildFolderBrief(files, TREE, 'A')
    // Brandschutz on r1, r2, r3 (twice in one document, counted once) and u1.
    expect(brief.disciplines).toEqual([
      { label: 'Brandschutz', count: 4 },
      { label: 'Schallschutz', count: 1 },
    ])
  })

  it('ignores a quarantined document\'s tags entirely', () => {
    const brief = buildFolderBrief(files, TREE, 'A')
    expect(brief.documentTypes.map((c) => c.label)).not.toContain('Bescheid')
    expect(brief.disciplines.map((c) => c.label)).not.toContain('Standsicherheit')
  })

  it('counts a document type once per document even when the tag is listed twice', () => {
    const doubled = file({ id: 'dbl', folderId: 'A', status: 'ready', tags: ['Foto', 'Foto'] })
    expect(buildFolderBrief([doubled], TREE, 'A').documentTypes).toEqual([{ label: 'Foto', count: 1 }])
  })

  it('counts content categories only from readable documents, each once per document', () => {
    const brief = buildFolderBrief(files, TREE, 'A')
    // text on r1 and r2 (r2 lists it twice, counted once); table on r1 only:
    // the failed f1's table is not counted, nor the quarantined q1's drawing.
    expect(brief.contents).toEqual([
      { label: 'text', count: 2 },
      { label: 'table', count: 1 },
      { label: 'image', count: 1 },
      { label: 'chart', count: 1 },
    ])
  })

  it('lists the documents that need a person, by why, and those still being read', () => {
    const brief = buildFolderBrief(files, TREE, 'A')
    expect(brief.attention.failed).toEqual([f1])
    expect(brief.attention.held).toEqual([q1])
    expect(brief.attention.unplaced).toEqual([u1])
    expect(brief.reading).toEqual([p1])
  })

  it('does not list a readable document with a type as unplaced', () => {
    const brief = buildFolderBrief(files, TREE, 'A')
    expect(brief.attention.unplaced.map((f) => f.id)).not.toContain('r1')
  })

  it('does not count a failed document\'s tags as a document type', () => {
    const brief = buildFolderBrief([f1], TREE, 'A')
    expect(brief.documentTypes).toEqual([])
    expect(brief.tally.failed).toBe(1)
  })

  it('orders equal counts by the vocabulary, so the list is stable', () => {
    // Schnitt is listed first in the corpus; Grundriss precedes it in the vocabulary.
    const docs = [
      file({ id: 's', folderId: 'A', status: 'ready', tags: ['Schnitt'] }),
      file({ id: 'g', folderId: 'A', status: 'ready', tags: ['Grundriss'] }),
    ]
    expect(buildFolderBrief(docs, TREE, 'A').documentTypes.map((c) => c.label)).toEqual(['Grundriss', 'Schnitt'])
  })

  it('orders equal discipline counts by the vocabulary', () => {
    const docs = [
      file({ id: 'b', folderId: 'A', status: 'ready', tags: ['Brandschutz'] }),
      file({ id: 's', folderId: 'A', status: 'ready', tags: ['Standsicherheit'] }),
    ]
    expect(buildFolderBrief(docs, TREE, 'A').disciplines.map((c) => c.label)).toEqual([
      'Standsicherheit',
      'Brandschutz',
    ])
  })

  it('builds the shelf root from every document', () => {
    const brief = buildFolderBrief(files, TREE, null)
    expect(brief.tally.total).toBe(8)
    expect(brief.files).toBe(files)
    expect(brief.attention.failed.map((f) => f.id)).toEqual(['f1', 'outside'])
  })
})

describe('buildFolderBrief hotspots', () => {
  /**
   * A>B>C is a chain, E sits under A beside B, and D is a second root.
   */
  const H_TREE = [
    folder('A', 'A'),
    folder('B', 'B', 'A'),
    folder('C', 'C', 'B'),
    folder('E', 'E', 'A'),
    folder('D', 'D'),
  ]
  const broken = (id: string, folderId: string | null) => file({ id, folderId, status: 'failed' })

  it('names only the deepest folder holding the trouble, not its ancestors', () => {
    const brief = buildFolderBrief([broken('x', 'C')], H_TREE, null)
    expect(brief.hotspots.map((h) => h.folder.id)).toEqual(['C'])
  })

  it('gives the trail from the top of the tree down to the hotspot', () => {
    const brief = buildFolderBrief([broken('x', 'C')], H_TREE, null)
    expect(brief.hotspots[0]?.trail).toEqual(['A', 'B', 'C'])
  })

  it('gives the trail from just below the brief folder when the brief is a folder', () => {
    const brief = buildFolderBrief([broken('x', 'C')], H_TREE, 'A')
    expect(brief.hotspots.map((h) => h.folder.id)).toEqual(['C'])
    expect(brief.hotspots[0]?.trail).toEqual(['B', 'C'])
  })

  it('never names the brief folder itself, even when its own documents are broken', () => {
    const brief = buildFolderBrief([broken('x', 'A'), broken('y', 'B')], H_TREE, 'A')
    expect(brief.hotspots.map((h) => h.folder.id)).toEqual(['B'])
  })

  it('never names a folder outside the brief subtree', () => {
    const brief = buildFolderBrief([broken('x', 'D')], H_TREE, 'A')
    expect(brief.hotspots).toEqual([])
  })

  it('reports the tally of the folder\'s own documents, not its subtree', () => {
    const brief = buildFolderBrief([broken('x', 'B'), broken('y', 'C')], H_TREE, null)
    const b = brief.hotspots.find((h) => h.folder.id === 'B')
    expect(b?.tally.failed).toBe(1)
    expect(b?.tally.total).toBe(1)
  })

  it('does not list a folder whose documents are all settled, readable or unindexed', () => {
    const settled = [
      file({ id: 'ok', folderId: 'B', status: 'ready', tags: ['Schnitt'] }),
      file({ id: 'rest', folderId: 'C', status: 'stored' }),
    ]
    expect(buildFolderBrief(settled, H_TREE, null).hotspots).toEqual([])
  })

  it('ranks failed above held above reading above unplaced', () => {
    const files = [
      file({ id: 'unplaced', folderId: 'E', status: 'ready', tags: null }),
      file({ id: 'reading', folderId: 'D', status: 'processing' }),
      file({ id: 'held', folderId: 'B', status: 'quarantined' }),
      file({ id: 'failed', folderId: 'C', status: 'failed' }),
    ]
    expect(buildFolderBrief(files, H_TREE, null).hotspots.map((h) => h.folder.id)).toEqual(['C', 'B', 'D', 'E'])
  })

  it('ranks more trouble of the same class above less', () => {
    const files = [broken('one', 'C'), broken('two', 'D'), broken('three', 'D')]
    expect(buildFolderBrief(files, H_TREE, null).hotspots.map((h) => h.folder.id)).toEqual(['D', 'C'])
  })

  it('orders equally bad folders by name, so the list is stable', () => {
    const named = [folder('Z', 'Zeta'), folder('Y', 'Alpha')]
    const files = [broken('z', 'Z'), broken('y', 'Y')]
    expect(buildFolderBrief(files, named, null).hotspots.map((h) => h.folder.name)).toEqual(['Alpha', 'Zeta'])
  })

  it('keeps at most MAX_HOTSPOTS, worst first', () => {
    const many = Array.from({ length: MAX_HOTSPOTS + 2 }, (_, i) => folder(`F${i}`, `F${i}`))
    // F0 has the most failures, so it is the worst; the rest are one failure each.
    const files = [
      ...Array.from({ length: 3 }, (_, i) => broken(`f0-${i}`, 'F0')),
      ...many.slice(1).map((f) => broken(`x-${f.id}`, f.id)),
    ]
    const hotspots = buildFolderBrief(files, many, null).hotspots
    expect(hotspots).toHaveLength(MAX_HOTSPOTS)
    expect(hotspots[0]?.folder.id).toBe('F0')
  })

  it('ignores a document whose folder is not in the listing', () => {
    expect(buildFolderBrief([broken('ghost', 'nowhere')], H_TREE, null).hotspots).toEqual([])
  })

  it('ignores a document with no folder', () => {
    expect(buildFolderBrief([broken('shelf', null)], H_TREE, null).hotspots).toEqual([])
    expect(buildFolderBrief([broken('shelf', null)], H_TREE, 'A').hotspots).toEqual([])
  })
})

/**
 * Regression: the ordering was once a weighted sum (1e6 failed, 1e4 held, 100
 * reading, 1 unplaced), so at 100 readings a folder tied with one hold and at
 * 101 unplaced it outranked one reading. The contract is class by class.
 */
describe('hotspot ordering holds at large counts', () => {
  it('ranks one held document above a folder with 100 documents being read', () => {
    const files = [
      ...Array.from({ length: 100 }, (_, i) => file({ id: `r${i}`, folderId: 'Alpha', status: 'processing' })),
      file({ id: 'h', folderId: 'Zeta', status: 'quarantined' }),
    ]
    const hotspots = buildFolderBrief(files, [folder('Alpha', 'Alpha'), folder('Zeta', 'Zeta')], null).hotspots
    expect(hotspots.map((h) => h.folder.name)).toEqual(['Zeta', 'Alpha'])
  })

  it('ranks one document being read above a folder with 101 unplaced documents', () => {
    const files = [
      ...Array.from({ length: 101 }, (_, i) => file({ id: `u${i}`, folderId: 'Alpha', status: 'ready', tags: null })),
      file({ id: 'r', folderId: 'Zeta', status: 'processing' }),
    ]
    const hotspots = buildFolderBrief(files, [folder('Alpha', 'Alpha'), folder('Zeta', 'Zeta')], null).hotspots
    expect(hotspots.map((h) => h.folder.name)).toEqual(['Zeta', 'Alpha'])
  })
})
