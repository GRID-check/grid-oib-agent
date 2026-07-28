import { render, screen, waitFor } from '@/test-utils'
import { fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { BaseKnowledge } from './base-knowledge'
import type { KnowledgeBaseStatus } from '@/lib/knowledge/service'

/**
 * The manager was rebuilt on the shared admin primitives (SectionCard +
 * DataToolbar + Table + Sheet + Pagination). These tests pin the CAPABILITIES,
 * not the old layout: every edit a row used to carry inline is still reachable
 * (now from the detail sheet or as a bulk action), and the list survives more
 * documents than fit on one screen.
 */

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

// The in-app PDF viewer pulls in an iframe/dialog we don't exercise here.
vi.mock('@/features/knowledge/components/pdf-viewer-dialog', () => ({
  PdfViewerDialog: () => <div data-testid="pdf-viewer" />,
}))

function file(overrides: Partial<KnowledgeBaseStatus['files'][number]>): KnowledgeBaseStatus['files'][number] {
  return {
    fileName: 'doc.pdf',
    state: 'ingested',
    origin: 'corpus',
    sizeBytes: 1024,
    chunkCount: 4,
    ingestedSha256: null,
    currentSha256: null,
    ingestedAt: null,
    summary: null,
    docClass: 'sonstiges',
    displayTitle: null,
    ...overrides,
  }
}

const STATUS: KnowledgeBaseStatus = {
  collectionName: 'oib',
  collectionExists: true,
  collectionUpdatedAt: null,
  summary: {
    totalFiles: 3,
    ingested: 3,
    stale: 0,
    pending: 0,
    snapshot: 0,
    removed: 0,
    inconsistent: 0,
    totalChunks: 12,
  },
  files: [
    file({ fileName: 'oib-richtlinie-2.pdf', docClass: 'oib_richtlinie' }),
    file({ fileName: 'oenorm-b-1600.pdf', docClass: 'norm_extern' }),
    file({ fileName: 'sonstiges-notiz.pdf', docClass: 'sonstiges', origin: 'uploaded' }),
  ],
}

/** 14 documents — more than the page size, so the pager has something to do. */
const MANY: KnowledgeBaseStatus = {
  ...STATUS,
  summary: { ...STATUS.summary, totalFiles: 14, ingested: 14, totalChunks: 56 },
  files: Array.from({ length: 14 }, (_, index) =>
    file({
      fileName: `base-${String(index + 1).padStart(2, '0')}.pdf`,
      docClass: index === 0 ? 'oib_richtlinie' : 'sonstiges',
    }),
  ),
}

function jsonResponse(body: unknown, ok = true, statusCode = 200) {
  return { ok, status: statusCode, json: async () => body } as Response
}

/** Open a row's detail sheet — where rename / reclassify / view / delete live now. */
async function openDetail(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: `Open details for ${name}` }))
  return screen.getByTestId('knowledge-detail')
}

describe('BaseKnowledge', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('renders the corpus summary and every document as a table row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))

    render(<BaseKnowledge />)

    // The corpus summary — documents / indexed / pending / chunks — was
    // invisible before the rebuild.
    const summary = await screen.findByTestId('knowledge-summary')
    expect(within(summary).getByText('Documents')).toBeInTheDocument()
    expect(within(summary).getByText('Indexed sections')).toBeInTheDocument()
    expect(within(summary).getByText('12')).toBeInTheDocument()

    expect(screen.getByText('oib-richtlinie-2.pdf')).toBeInTheDocument()
    expect(screen.getByText('oenorm-b-1600.pdf')).toBeInTheDocument()
    expect(screen.getByText('sonstiges-notiz.pdf')).toBeInTheDocument()
    // Dokumentart label surfaces per row (via SourceSignalChip).
    expect(screen.getAllByText(/OIB-Richtlinie \(verbindlich\)/).length).toBeGreaterThan(0)
  })

  test('the binding-vs-other distinction survives as a scope filter and a row badge', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    // The binding OIB document is marked as such in its row.
    expect(screen.getByText('Binding')).toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Scope' }))
    await user.click(screen.getByRole('option', { name: 'Binding OIB foundations' }))

    await waitFor(() => expect(screen.queryByText('oenorm-b-1600.pdf')).not.toBeInTheDocument())
    expect(screen.getByText('oib-richtlinie-2.pdf')).toBeInTheDocument()
  })

  test('the search box filters the list down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    await user.type(screen.getByRole('textbox', { name: 'Filter documents' }), 'oenorm')

    await waitFor(() => expect(screen.queryByText('oib-richtlinie-2.pdf')).not.toBeInTheDocument())
    expect(screen.getByText('oenorm-b-1600.pdf')).toBeInTheDocument()
  })

  test('the Dokumentart dropdown in the detail sheet reflects the doc_class and PATCHes on change', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(STATUS))
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'oenorm-b-1600.pdf')

    // The sheet's dropdown is pre-filled with the current class label.
    const trigger = within(sheet).getByRole('combobox', { name: /Document type for oenorm-b-1600\.pdf/i })
    expect(trigger).toHaveTextContent('Norm (ÖNORM u.a.)')

    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: 'Gesetz / Bauordnung' }))

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            typeof url === 'string' &&
            url.includes('/api/platform/knowledge/documents/oenorm-b-1600.pdf/doc-class') &&
            (init as RequestInit | undefined)?.method === 'PATCH',
        ),
      ).toBe(true)
    })

    const patchCall = fetchSpy.mock.calls.find(
      ([url, init]) =>
        typeof url === 'string' &&
        url.includes('/doc-class') &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    )
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({ doc_class: 'gesetz' })
  })

  test('renaming from the detail sheet PATCHes the display-title endpoint with the new name', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(STATUS))
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'oib-richtlinie-2.pdf')

    const input = within(sheet).getByRole('textbox', { name: 'Display name for oib-richtlinie-2.pdf' })
    await user.clear(input)
    await user.type(input, 'OIB-Richtlinie 2, Ausgabe Mai 2023')
    await user.click(within(sheet).getByRole('button', { name: 'Save name' }))

    await waitFor(() => {
      const patchCall = fetchSpy.mock.calls.find(
        ([url, init]) =>
          typeof url === 'string' &&
          url.includes('/api/platform/knowledge/documents/oib-richtlinie-2.pdf/display-title') &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      )
      expect(patchCall).toBeDefined()
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({
        display_title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
      })
    })
  })

  test('a repo-shipped (corpus) row deletes with corpus wording after confirmation', async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/platform/knowledge/documents/') && init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({ success: true, fileName: 'oib-richtlinie-2.pdf', mode: 'excluded' }))
      }
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'oib-richtlinie-2.pdf')

    // The corpus row (origin: 'corpus') offers "Remove from corpus", not "Remove".
    await user.click(within(sheet).getByRole('button', { name: 'Remove from corpus' }))

    // The confirm dialog repeats the corpus-specific wording; confirm it.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove oib-richtlinie-2.pdf from the corpus?')
    await user.click(within(dialog).getByRole('button', { name: 'Remove from corpus' }))

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            typeof url === 'string' &&
            url.includes('/api/platform/knowledge/documents/oib-richtlinie-2.pdf') &&
            (init as RequestInit | undefined)?.method === 'DELETE',
        ),
      ).toBe(true)
    })
  })

  test('an uploaded row deletes with the uploaded wording', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'sonstiges-notiz.pdf')

    await user.click(within(sheet).getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove sonstiges-notiz.pdf?')
    expect(dialog).toHaveTextContent('This deletes the uploaded PDF')
  })

  test('the detail sheet opens the in-app PDF viewer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'oib-richtlinie-2.pdf')

    await user.click(within(sheet).getByRole('button', { name: 'View PDF' }))
    expect(await screen.findByTestId('pdf-viewer')).toBeInTheDocument()
  })

  test('the upload input accepts PDF and ZIP', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    const input = screen.getByTestId('knowledge-upload-input') as HTMLInputElement
    expect(input.accept).toContain('.pdf')
    expect(input.accept).toContain('.zip')
  })

  test('the dropzone is revealed by the "Add documents" action rather than always open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    expect(screen.queryByTestId('knowledge-dropzone')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Add documents/ }))
    expect(screen.getByTestId('knowledge-dropzone')).toBeInTheDocument()
  })

  test('dropping a PDF on the revealed dropzone uploads it', async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url === '/api/platform/knowledge/documents' && init?.method === 'POST') {
        return Promise.resolve(
          jsonResponse({ status: 'pending', kind: 'file', fileName: 'dropped.pdf', members: null }),
        )
      }
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')
    await user.click(screen.getByRole('button', { name: /Add documents/ }))

    const pdf = new File(['%PDF-1.4'], 'dropped.pdf', { type: 'application/pdf' })
    fireEvent.drop(screen.getByTestId('knowledge-dropzone'), { dataTransfer: { files: [pdf] } })

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            typeof url === 'string' &&
            url === '/api/platform/knowledge/documents' &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  test('uploading a file posts to the corpus and starts background polling', async () => {
    const fetchSpy = vi.fn((url: string, _init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/platform/knowledge/documents')) {
        return Promise.resolve(
          jsonResponse({
            status: 'pending',
            kind: 'file',
            fileName: 'new-doc.pdf',
            docClass: 'sonstiges',
            message: '',
            accepted: 1,
            rejected: 0,
            members: null,
          }),
        )
      }
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    const input = screen.getByTestId('knowledge-upload-input') as HTMLInputElement
    const pdf = new File(['%PDF-1.4'], 'new-doc.pdf', { type: 'application/pdf' })
    await user.upload(input, pdf)

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            typeof url === 'string' &&
            url === '/api/platform/knowledge/documents' &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  test('a ZIP upload shows aggregate + per-file indexing progress', async () => {
    const zipBody = {
      status: 'pending',
      kind: 'zip',
      fileName: null,
      docClass: null,
      message: '',
      accepted: 2,
      rejected: 0,
      members: [
        { fileName: 'a.pdf', status: 'pending', docClass: 'sonstiges', reason: null },
        { fileName: 'b.pdf', status: 'pending', docClass: 'sonstiges', reason: null },
      ],
    }
    // Status snapshot where a.pdf has finished indexing but b.pdf hasn't appeared yet.
    const statusWithA: KnowledgeBaseStatus = {
      ...STATUS,
      files: [...STATUS.files, file({ fileName: 'a.pdf', origin: 'uploaded', docClass: 'sonstiges' })],
    }
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/platform/knowledge/documents') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse(zipBody))
      }
      return Promise.resolve(jsonResponse(statusWithA))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    const input = screen.getByTestId('knowledge-upload-input') as HTMLInputElement
    const zip = new File(['PK'], 'bulk.zip', { type: 'application/zip' })
    await user.upload(input, zip)

    // Aggregate progress: a.pdf done, b.pdf still working → "1 of 2".
    const progress = await screen.findByTestId('knowledge-upload-progress')
    expect(progress).toHaveTextContent('Indexing 1 of 2')
    // Per-file rows surface inside the progress card, each with its live state.
    expect(within(progress).getByText('a.pdf')).toBeInTheDocument()
    expect(within(progress).getByText('b.pdf')).toBeInTheDocument()
    expect(within(progress).getByText('Indexed')).toBeInTheDocument()
    expect(within(progress).getByText('Indexing…')).toBeInTheDocument()
  })

  test('syncing the corpus posts to the sync endpoint', async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/sync') && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ filesAdded: 1, filesTotal: 3 }))
      }
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    await user.click(screen.getByRole('button', { name: /Sync corpus/ }))

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            typeof url === 'string' &&
            url === '/api/platform/knowledge/sync' &&
            (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true)
    })
  })

  test('selecting rows reveals bulk actions and reclassifies every selected document', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(STATUS))
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    await user.click(screen.getByRole('checkbox', { name: 'Select oib-richtlinie-2.pdf' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select oenorm-b-1600.pdf' }))

    // The toolbar swaps to the selection bar.
    const selectionBar = await screen.findByTestId('data-toolbar-selection')
    expect(selectionBar).toHaveTextContent('2 selected')

    await user.click(within(selectionBar).getByRole('combobox', { name: 'Change document type' }))
    await user.click(screen.getByRole('option', { name: 'Gesetz / Bauordnung' }))

    await waitFor(() => {
      const patched = fetchSpy.mock.calls
        .filter(
          ([url, init]) =>
            typeof url === 'string' &&
            url.includes('/doc-class') &&
            (init as RequestInit | undefined)?.method === 'PATCH',
        )
        .map(([url]) => url as string)
      expect(patched).toHaveLength(2)
      expect(patched.some((url) => url.includes('oib-richtlinie-2.pdf'))).toBe(true)
      expect(patched.some((url) => url.includes('oenorm-b-1600.pdf'))).toBe(true)
    })
  })

  test('bulk delete confirms once and removes every selected document', async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && init?.method === 'DELETE') {
        return Promise.resolve(jsonResponse({ success: true }))
      }
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    await user.click(screen.getByRole('checkbox', { name: 'Select oib-richtlinie-2.pdf' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select sonstiges-notiz.pdf' }))

    const selectionBar = await screen.findByTestId('data-toolbar-selection')
    await user.click(within(selectionBar).getByRole('button', { name: 'Remove' }))

    // A mixed selection gets the bulk wording, not either single-file variant.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove 2 documents?')
    await user.click(within(dialog).getByRole('button', { name: 'Remove 2 documents' }))

    await waitFor(() => {
      const deleted = fetchSpy.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
      )
      expect(deleted).toHaveLength(2)
    })
  })

  test('pages through a corpus larger than one page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(MANY)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('base-01.pdf')

    // Page one holds ten of the fourteen documents.
    expect(screen.getByText('1–10 of 14')).toBeInTheDocument()
    expect(screen.queryByText('base-14.pdf')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Next/ }))

    expect(await screen.findByText('base-14.pdf')).toBeInTheDocument()
    expect(screen.getByText('11–14 of 14')).toBeInTheDocument()
    expect(screen.queryByText('base-02.pdf')).not.toBeInTheDocument()
  })

  test('sorting by document name reverses the visible page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(MANY)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('base-01.pdf')

    // First click sorts ascending by name, second descending.
    const header = screen.getByRole('button', { name: 'Sort by Document' })
    await user.click(header)
    await user.click(header)

    expect(await screen.findByText('base-14.pdf')).toBeInTheDocument()
    expect(screen.queryByText('base-01.pdf')).not.toBeInTheDocument()
  })

  test('a failed status load offers a retry that refetches', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'nope' }, false, 500))
      .mockResolvedValue(jsonResponse(STATUS))
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    render(<BaseKnowledge />)

    expect(await screen.findByText('The knowledge base could not be loaded.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Retry/i }))

    expect(await screen.findByText('oib-richtlinie-2.pdf')).toBeInTheDocument()
  })

  test('an empty corpus invites the first upload instead of showing an empty table', async () => {
    const empty: KnowledgeBaseStatus = {
      ...STATUS,
      summary: { ...STATUS.summary, totalFiles: 0, ingested: 0, totalChunks: 0 },
      files: [],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(empty)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)

    expect(await screen.findByText('No base documents yet')).toBeInTheDocument()

    // The empty state must not lock the owner out of the upload affordance.
    await user.click(screen.getByRole('button', { name: /Add documents/ }))
    expect(screen.getByTestId('knowledge-dropzone')).toBeInTheDocument()
  })
})
