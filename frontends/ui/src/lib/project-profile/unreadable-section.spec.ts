/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getRestrictedFolderIds } from '@/lib/authz/folder-access'
import { findFolderPathsInProject, listUnreadableProjectDocuments } from '@/lib/documents/repository'
import {
  buildUnreadableDocumentsSection,
  loadUnreadableDocumentsSection,
  MAX_UNREADABLE_LINES,
  type UnreadableDocument,
} from './unreadable-section'

vi.mock('@/lib/authz/folder-access', () => ({ getRestrictedFolderIds: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({
  listUnreadableProjectDocuments: vi.fn(),
  findFolderPathsInProject: vi.fn(),
}))

const WEITERE = '- (weitere nicht lesbare Dateien nicht aufgeführt)'

type UnreadableRow = Awaited<ReturnType<typeof listUnreadableProjectDocuments>>[number]

function row(overrides: Partial<UnreadableRow> = {}): UnreadableRow {
  return { filename: 'Honorarnote.pdf', displayName: null, folderId: null, ...overrides }
}

function doc(overrides: Partial<UnreadableDocument> = {}): UnreadableDocument {
  return { filename: 'Honorarnote.pdf', displayName: null, folderPath: null, ...overrides }
}

/** `count` distinct rows, each with its own filename, so a cap is visible in the output. */
function manyRows(count: number): UnreadableRow[] {
  return Array.from({ length: count }, (_, index) => row({ filename: `datei-${index + 1}.pdf` }))
}

describe('buildUnreadableDocumentsSection', () => {
  it('renders nothing when no document is unreadable', () => {
    expect(buildUnreadableDocumentsSection([])).toBe('')
  })

  it('opens with the documents_unreadable header and one bullet per document', () => {
    expect(buildUnreadableDocumentsSection([doc()])).toBe('documents_unreadable:\n- Honorarnote.pdf')
  })

  it('names the folder a document sits in', () => {
    expect(buildUnreadableDocumentsSection([doc({ folderPath: 'a/b' })])).toBe(
      'documents_unreadable:\n- Honorarnote.pdf (Ordner: a/b)'
    )
  })

  it('names a document by its display name, with the file name in brackets', () => {
    expect(buildUnreadableDocumentsSection([doc({ displayName: 'Title', filename: 'file.pdf' })])).toBe(
      'documents_unreadable:\n- Title (file.pdf)'
    )
  })

  it('falls back to the file name when the display name is blank', () => {
    expect(buildUnreadableDocumentsSection([doc({ displayName: '   ', filename: 'file.pdf' })])).toBe(
      'documents_unreadable:\n- file.pdf'
    )
  })

  it('caps the list at MAX_UNREADABLE_LINES and says that more were left out', () => {
    const docs = manyRows(MAX_UNREADABLE_LINES + 3).map((r) => doc({ filename: r.filename }))

    const lines = buildUnreadableDocumentsSection(docs).split('\n')

    expect(lines).toHaveLength(1 + MAX_UNREADABLE_LINES + 1)
    expect(lines[MAX_UNREADABLE_LINES]).toBe(`- datei-${MAX_UNREADABLE_LINES}.pdf`)
    expect(lines.at(-1)).toBe(WEITERE)
  })

  it('states that more were left out when the caller says so, even for a short list', () => {
    expect(buildUnreadableDocumentsSection([doc()], true)).toBe(
      `documents_unreadable:\n- Honorarnote.pdf\n${WEITERE}`
    )
  })
})

describe('loadUnreadableDocumentsSection', () => {
  beforeEach(() => {
    vi.mocked(getRestrictedFolderIds).mockResolvedValue([])
    vi.mocked(listUnreadableProjectDocuments).mockResolvedValue([])
    vi.mocked(findFolderPathsInProject).mockResolvedValue(new Map())
  })

  it('reads nothing and renders nothing without an organization', async () => {
    expect(await loadUnreadableDocumentsSection('proj-1', null)).toBe('')
    expect(await loadUnreadableDocumentsSection('proj-1', undefined)).toBe('')

    expect(getRestrictedFolderIds).not.toHaveBeenCalled()
    expect(listUnreadableProjectDocuments).not.toHaveBeenCalled()
  })

  it('passes the hidden folders through and asks for one row more than it shows', async () => {
    vi.mocked(getRestrictedFolderIds).mockResolvedValue(['f-hidden'])

    await loadUnreadableDocumentsSection('proj-1', 'org-1')

    expect(getRestrictedFolderIds).toHaveBeenCalledWith('org-1', 'proj-1')
    expect(listUnreadableProjectDocuments).toHaveBeenCalledWith(
      'proj-1',
      'org-1',
      ['f-hidden'],
      MAX_UNREADABLE_LINES + 1
    )
  })

  it('maps each folder to its path, once per folder, and names no folder it cannot place', async () => {
    vi.mocked(listUnreadableProjectDocuments).mockResolvedValue([
      row({ filename: 'a.pdf', folderId: 'f1' }),
      row({ filename: 'b.pdf', folderId: 'f1' }),
      row({ filename: 'c.pdf', folderId: 'f-gone' }),
      row({ filename: 'd.pdf', folderId: null }),
    ])
    vi.mocked(findFolderPathsInProject).mockResolvedValue(new Map([['f1', 'Planung/Entwurf']]))

    const section = await loadUnreadableDocumentsSection('proj-1', 'org-1')

    expect(findFolderPathsInProject).toHaveBeenCalledWith(['f1', 'f-gone'], 'proj-1', 'org-1')
    expect(section).toBe(
      [
        'documents_unreadable:',
        '- a.pdf (Ordner: Planung/Entwurf)',
        '- b.pdf (Ordner: Planung/Entwurf)',
        '- c.pdf',
        '- d.pdf',
      ].join('\n')
    )
  })

  it('states that more were left out when the repository returns one row past the cap', async () => {
    vi.mocked(listUnreadableProjectDocuments).mockResolvedValue(manyRows(MAX_UNREADABLE_LINES + 1))

    const lines = (await loadUnreadableDocumentsSection('proj-1', 'org-1')).split('\n')

    expect(lines).toHaveLength(1 + MAX_UNREADABLE_LINES + 1)
    expect(lines.at(-1)).toBe(WEITERE)
    expect(lines).not.toContain(`- datei-${MAX_UNREADABLE_LINES + 1}.pdf`)
  })

  it('renders nothing rather than failing when the repository throws', async () => {
    vi.mocked(listUnreadableProjectDocuments).mockRejectedValue(new Error('db down'))

    expect(await loadUnreadableDocumentsSection('proj-1', 'org-1')).toBe('')
  })

  it('renders nothing rather than failing when folder access cannot be read', async () => {
    vi.mocked(getRestrictedFolderIds).mockRejectedValue(new Error('db down'))

    expect(await loadUnreadableDocumentsSection('proj-1', 'org-1')).toBe('')
    expect(listUnreadableProjectDocuments).not.toHaveBeenCalled()
  })
})
