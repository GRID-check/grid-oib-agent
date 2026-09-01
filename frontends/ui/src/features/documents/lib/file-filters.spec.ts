import { describe, expect, test } from 'vitest'
import type { FileItem } from '../components/project-file-workspace'
import {
  NO_FILE_FILTERS,
  activeFilterCount,
  applyFileFilters,
  statusGroupOf,
  toggleIn,
  FILE_KIND_FILTERS,
} from './file-filters'

const file = (overrides: Partial<FileItem> & { id: string }): FileItem =>
  ({
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
  }) as FileItem

describe('statusGroupOf', () => {
  test('collapses the pipeline vocabulary onto the three questions people ask', () => {
    expect(statusGroupOf('ingesting')).toBe('processing')
    expect(statusGroupOf('processing')).toBe('processing')
    expect(statusGroupOf('ingested')).toBe('ready')
    expect(statusGroupOf('success')).toBe('ready')
    expect(statusGroupOf('error')).toBe('failed')
  })

  /**
   * The asymmetry is the point. Calling an unknown state `ready` tells a reader
   * Piloti can cite a document it cannot, which is the error that costs an
   * afternoon; parking a new pipeline state under "in Arbeit" until somebody
   * maps it costs nothing.
   */
  test('treats an unmapped status as in progress, never as citable', () => {
    expect(statusGroupOf('quarantined')).toBe('processing')
    expect(statusGroupOf(null)).toBe('processing')
    expect(statusGroupOf(undefined)).toBe('processing')
  })
})

describe('activeFilterCount', () => {
  test('is zero for the empty set', () => {
    expect(activeFilterCount(NO_FILE_FILTERS, true)).toBe(0)
  })

  /**
   * A dimension counts once however many values it holds. "Dateityp: Grundriss
   * + Schnitt" is ONE constraint the reader can lift; counting it as two turns
   * the badge into a tally of clicks.
   */
  test('counts a dimension once, not once per value', () => {
    expect(
      activeFilterCount({ ...NO_FILE_FILTERS, kinds: ['floorplan', 'section', 'photo'] }, true)
    ).toBe(1)
  })

  test('never counts assignment when the menu does not offer it', () => {
    const filters = { ...NO_FILE_FILTERS, assignment: 'mine' as const }
    expect(activeFilterCount(filters, true)).toBe(1)
    // Collaboration off: the section is not rendered, so a badge counting it
    // would point at a control that is not there.
    expect(activeFilterCount(filters, false)).toBe(0)
  })

  test('counts the server-side authorship filter, which the menu does show', () => {
    expect(activeFilterCount({ ...NO_FILE_FILTERS, agentAuthoredOnly: true }, false)).toBe(1)
  })
})

describe('toggleIn', () => {
  test('adds, removes, and keeps the offered order rather than click order', () => {
    const added = toggleIn<(typeof FILE_KIND_FILTERS)[number]>([], 'photo', FILE_KIND_FILTERS)
    expect(added).toEqual(['photo'])
    // 'floorplan' is offered BEFORE 'photo', so it lands before it whichever
    // was pressed first — otherwise the checkbox list reorders under the cursor.
    expect(toggleIn(added, 'floorplan', FILE_KIND_FILTERS)).toEqual(['floorplan', 'photo'])
    expect(toggleIn(added, 'photo', FILE_KIND_FILTERS)).toEqual([])
  })
})

describe('applyFileFilters', () => {
  const files = [
    file({ id: 'a', filename: 'Grundriss EG.pdf', status: 'ready' }),
    file({ id: 'b', filename: 'Bericht.pdf', status: 'failed' }),
    file({ id: 'c', filename: 'Modell.ifc', status: 'ingesting' }),
  ]

  test('returns the SAME array when nothing is constrained', () => {
    // Identity, not just equality: a new array on every render re-renders the
    // whole listing whenever anything else on the page changes.
    expect(applyFileFilters(files, NO_FILE_FILTERS, { canCollaborate: true })).toBe(files)
  })

  test('an empty dimension means "every value", never "no value"', () => {
    expect(applyFileFilters(files, { ...NO_FILE_FILTERS, kinds: [], statuses: [] }, { canCollaborate: true }))
      .toHaveLength(3)
  })

  test('narrows by status group, not by the raw status string', () => {
    const result = applyFileFilters(files, { ...NO_FILE_FILTERS, statuses: ['processing'] }, {
      canCollaborate: true,
    })
    // `ingesting` is not the literal 'processing', and the reader asked the
    // question the group answers.
    expect(result.map((f) => f.id)).toEqual(['c'])
  })

  test('narrows by inferred kind, so an .ifc is a model whatever it is named', () => {
    const result = applyFileFilters(files, { ...NO_FILE_FILTERS, kinds: ['model'] }, {
      canCollaborate: true,
    })
    expect(result.map((f) => f.id)).toEqual(['c'])
  })

  test('ANDs the dimensions', () => {
    const result = applyFileFilters(
      files,
      { ...NO_FILE_FILTERS, kinds: ['model'], statuses: ['ready'] },
      { canCollaborate: true }
    )
    expect(result).toHaveLength(0)
  })

  test('ignores assignment entirely when collaboration is off', () => {
    // The workspace passes `canCollaborate` from a flag; a filter whose control
    // is not rendered must not silently narrow the listing.
    const withAssignees = [file({ id: 'a', assignees: [{ userId: 'u1' } as never] })]
    expect(
      applyFileFilters(withAssignees, { ...NO_FILE_FILTERS, assignment: 'unassigned' }, {
        canCollaborate: false,
      })
    ).toHaveLength(1)
  })

  test('does NOT apply the authorship filter, which the listing endpoint answers', () => {
    // Applying it here as well would be a second, divergent definition of the
    // same word — and the endpoint's is the one that can reach a report which
    // fell off the end of a 500-row listing.
    expect(
      applyFileFilters(files, { ...NO_FILE_FILTERS, agentAuthoredOnly: true }, { canCollaborate: true })
    ).toBe(files)
  })
})
