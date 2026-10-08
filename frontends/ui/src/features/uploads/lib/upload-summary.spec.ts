import { describe, expect, it } from 'vitest'
import { HISTORY, MIXED_SUMMARY, SETTLED_SUMMARY } from '@/app/dev/_fixtures/upload-batches'
import {
  documentHref,
  documentTypeCounts,
  formatFolderPath,
  groupByFolder,
  isSettling,
  placeHref,
  summaryFacets,
  tallyHistoryEntry,
  tallySummary,
  visibleTally,
} from './upload-summary'

describe('tallySummary', () => {
  it('counts each outcome, adds uploads that never arrived to the failures, and totals the excluded terms', () => {
    expect(tallySummary(MIXED_SUMMARY)).toEqual({
      ready: 3,
      reading: 1,
      quarantined: 1,
      failed: 2,
      stored: 0,
      unchanged: 4,
      excluded: 4,
    })
  })

  it('reads a history row the same way', () => {
    expect(tallyHistoryEntry(HISTORY[0])).toEqual(tallySummary(MIXED_SUMMARY))
  })

  it('shows the non-zero counts in reading order, keeping „ready" even at zero', () => {
    expect(visibleTally(tallyHistoryEntry(HISTORY[2]))).toEqual([
      { key: 'ready', count: 0 },
      { key: 'unchanged', count: 2 },
    ])
  })
})

describe('summaryFacets', () => {
  it('counts the new versions and the protected files beside the outcomes', () => {
    expect(summaryFacets(MIXED_SUMMARY)).toEqual([
      { key: 'changed', count: 1 },
      { key: 'protected', count: 2 },
    ])
  })

  it('shows neither when no file is either', () => {
    const plain = {
      ...MIXED_SUMMARY,
      documents: MIXED_SUMMARY.documents.map((document) => ({ ...document, replaced: false, restricted: false })),
    }
    expect(summaryFacets(plain)).toEqual([])
  })
})

describe('groupByFolder', () => {
  it('puts the root first, then folders by path, files by name', () => {
    const groups = groupByFolder(MIXED_SUMMARY.documents)
    expect(groups.map((group) => group.path)).toEqual([null, 'Gutachten', 'Pläne/Einreichung'])
    expect(groups[2].documents.map((document) => document.id)).toEqual(['doc-grundriss-eg', 'doc-schnitt-aa'])
  })

  it('spaces the path separators', () => {
    expect(formatFolderPath('Pläne/Einreichung/')).toBe('Pläne / Einreichung')
  })
})

describe('documentTypeCounts', () => {
  it('counts the detected types and skips files without one', () => {
    expect(documentTypeCounts(SETTLED_SUMMARY.documents)).toEqual([
      { type: 'Foto', count: 1 },
      { type: 'Grundriss', count: 1 },
      { type: 'Gutachten', count: 1 },
      { type: 'Schnitt', count: 1 },
    ])
  })
})

describe('isSettling', () => {
  it('is true while the batch is open and a file is being read', () => {
    expect(isSettling(MIXED_SUMMARY)).toBe(true)
  })

  it('is false once the batch has completed', () => {
    expect(isSettling(SETTLED_SUMMARY)).toBe(false)
    expect(isSettling({ ...MIXED_SUMMARY, completedAt: '2026-10-01T09:00:00.000Z' })).toBe(false)
  })
})

describe('links', () => {
  it('opens a project file in the Files view, an Archiv file in the Archiv, and links no chat file', () => {
    expect(documentHref(MIXED_SUMMARY, 'doc-1')).toBe('/app/projects/proj-stadthaus/files?doc=doc-1')
    expect(documentHref({ scope: 'archiv', projectId: null }, 'doc 1')).toBe('/app/archiv?doc=doc%201')
    expect(documentHref({ scope: 'session', projectId: null }, 'doc-1')).toBeNull()
  })

  it('links where the upload went', () => {
    expect(placeHref(MIXED_SUMMARY)).toBe('/app/projects/proj-stadthaus/files')
    expect(placeHref({ scope: 'archiv', projectId: null, conversationId: null })).toBe('/app/archiv')
    expect(placeHref({ scope: 'session', projectId: null, conversationId: 'c 1' })).toBe('/app/chat?session=c%201')
  })
})
