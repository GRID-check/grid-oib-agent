import { render, screen, waitFor } from '@/test-utils'
import { fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { toast } from 'sonner'
import { BaseKnowledge } from './base-knowledge'
import type { KnowledgeBaseStatus } from '@/lib/knowledge/service'
import { PlatformAccessProvider } from '@/features/platform/platform-access'
import { platform as dePlatform } from '@/i18n/dictionaries/de/platform'
import { DOC_CLASS_LABELS } from '@/lib/knowledge/doc-class'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'

/**
 * The manager was rebuilt on the shared admin primitives (SectionCard +
 * DataToolbar + Table + Sheet + Pagination). These tests pin the CAPABILITIES,
 * not the old layout: every edit a row used to carry inline is still reachable
 * (now from the detail sheet or as a bulk action), and the list survives more
 * documents than fit on one screen.
 */

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

// The in-app PDF viewer pulls in an iframe/dialog we don't exercise here.
vi.mock('@/features/knowledge/components/pdf-viewer-dialog', () => ({
  PdfViewerDialog: () => <div data-testid="pdf-viewer" />,
}))

function file(
  overrides: Partial<KnowledgeBaseStatus['files'][number]>
): KnowledgeBaseStatus['files'][number] {
  return {
    fileName: 'doc.pdf',
    state: 'ingested',
    sizeBytes: 1024,
    chunkCount: 4,
    ingestedSha256: null,
    currentSha256: null,
    ingestedAt: null,
    summary: null,
    docClass: 'sonstiges',
    docClassSuggestion: null,
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
    failed: 0,
    removed: 0,
    inconsistent: 0,
    totalChunks: 12,
  },
  files: [
    file({ fileName: 'oib-richtlinie-2.pdf', docClass: 'oib_richtlinie' }),
    file({ fileName: 'oenorm-b-1600.pdf', docClass: 'norm_extern' }),
    file({ fileName: 'sonstiges-notiz.pdf', docClass: 'sonstiges' }),
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
    })
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

/** Open the overflow menu and pick an entry. */
async function pickMenu(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole('button', { name: 'More actions' }))
  await user.click(await screen.findByRole('menuitem', { name }))
}

const requestsTo = (spy: ReturnType<typeof vi.fn>, match: string, method?: string) =>
  spy.mock.calls.filter(
    ([url, init]) =>
      typeof url === 'string' &&
      url.includes(match) &&
      (method === undefined || (init as RequestInit | undefined)?.method === method)
  )

describe('BaseKnowledge', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(toast.error).mockClear()
    vi.mocked(toast.info).mockClear()
    vi.mocked(toast.success).mockClear()
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
    expect(within(summary).getByText('Sections')).toBeInTheDocument()
    expect(within(summary).getByText('12')).toBeInTheDocument()
    expect(within(summary).getByText('Issues')).toBeInTheDocument()

    expect(screen.getByText('oib-richtlinie-2.pdf')).toBeInTheDocument()
    expect(screen.getByText('oenorm-b-1600.pdf')).toBeInTheDocument()
    expect(screen.getByText('sonstiges-notiz.pdf')).toBeInTheDocument()
    // The Dokumentart label surfaces per row, translated (it used to be German in every locale).
    expect(screen.getAllByText(/OIB directive \(binding\)/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/OIB-Richtlinie \(verbindlich\)/)).not.toBeInTheDocument()
  })

  test('the binding-vs-other distinction survives in the type filter and the detail sheet', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    await user.click(screen.getByRole('combobox', { name: 'Document type' }))
    await user.click(screen.getByRole('option', { name: 'Binding OIB foundations' }))

    await waitFor(() => expect(screen.queryByText('oenorm-b-1600.pdf')).not.toBeInTheDocument())
    expect(screen.getByText('oib-richtlinie-2.pdf')).toBeInTheDocument()

    const sheet = await openDetail(user, 'oib-richtlinie-2.pdf')
    expect(within(sheet).getByText('Binding')).toBeInTheDocument()
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
    const trigger = within(sheet).getByRole('combobox', {
      name: /Document type for oenorm-b-1600\.pdf/i,
    })
    expect(trigger).toHaveTextContent('Standard (ÖNORM etc.)')

    await user.click(trigger)
    await user.click(screen.getByRole('option', { name: 'Law / building code' }))

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            typeof url === 'string' &&
            url.includes('/api/platform/knowledge/documents/oenorm-b-1600.pdf/doc-class') &&
            (init as RequestInit | undefined)?.method === 'PATCH'
        )
      ).toBe(true)
    })

    const patchCall = fetchSpy.mock.calls.find(
      ([url, init]) =>
        typeof url === 'string' &&
        url.includes('/doc-class') &&
        (init as RequestInit | undefined)?.method === 'PATCH'
    )
    expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({
      doc_class: 'gesetz',
    })
  })

  test('a Dokumentart read from the text is offered, and accepting it is the same PATCH', async () => {
    const suggested = file({
      fileName: 'BO_Wien_konsolidiert.pdf',
      docClass: 'sonstiges',
      docClassSuggestion: 'gesetz',
    })
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ...STATUS, files: [...STATUS.files, suggested] }))
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'BO_Wien_konsolidiert.pdf')

    // Offered beside the picker, never applied: the picker still shows the stored class.
    expect(within(sheet).getByText('Read from the text: Law / building code')).toBeInTheDocument()
    expect(
      within(sheet).getByRole('combobox', { name: /Document type for BO_Wien/i })
    ).toHaveTextContent('Other base document')
    expect(
      fetchSpy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH')
    ).toBe(false)

    await user.click(within(sheet).getByRole('button', { name: 'Accept' }))

    await waitFor(() => {
      const patch = fetchSpy.mock.calls.find(
        ([url, init]) =>
          typeof url === 'string' &&
          url.includes('/BO_Wien_konsolidiert.pdf/doc-class') &&
          (init as RequestInit | undefined)?.method === 'PATCH'
      )
      expect(patch && JSON.parse((patch[1] as RequestInit).body as string)).toEqual({
        doc_class: 'gesetz',
      })
    })
  })

  test('a suggestion equal to the stored class offers nothing', async () => {
    const same = file({
      fileName: 'b1600.pdf',
      docClass: 'norm_extern',
      docClassSuggestion: 'norm_extern',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ ...STATUS, files: [...STATUS.files, same] }))
    )
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'b1600.pdf')
    expect(within(sheet).queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })

  test('renaming from the detail sheet PATCHes the display-title endpoint with the new name', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(STATUS))
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'oib-richtlinie-2.pdf')

    const input = within(sheet).getByRole('textbox', {
      name: 'Display name for oib-richtlinie-2.pdf',
    })
    await user.clear(input)
    await user.type(input, 'OIB-Richtlinie 2, Ausgabe Mai 2023')
    await user.click(within(sheet).getByRole('button', { name: 'Save name' }))

    await waitFor(() => {
      const patchCall = fetchSpy.mock.calls.find(
        ([url, init]) =>
          typeof url === 'string' &&
          url.includes('/api/platform/knowledge/documents/oib-richtlinie-2.pdf/display-title') &&
          (init as RequestInit | undefined)?.method === 'PATCH'
      )
      expect(patchCall).toBeDefined()
      expect(JSON.parse((patchCall![1] as RequestInit).body as string)).toEqual({
        display_title: 'OIB-Richtlinie 2, Ausgabe Mai 2023',
      })
    })
  })

  test('a row deletes after confirmation, and the dialog says what is deleted', async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (
        typeof url === 'string' &&
        url.includes('/api/platform/knowledge/documents/') &&
        init?.method === 'DELETE'
      ) {
        return Promise.resolve(jsonResponse({ success: true, fileName: 'oib-richtlinie-2.pdf' }))
      }
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'oib-richtlinie-2.pdf')

    // One kind of removal for every row: it deletes.
    expect(
      within(sheet).queryByRole('button', { name: 'Remove from corpus' })
    ).not.toBeInTheDocument()
    await user.click(within(sheet).getByRole('button', { name: 'Remove' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Remove oib-richtlinie-2.pdf?')
    expect(dialog).toHaveTextContent('This deletes the PDF and all of its indexed content')
    await user.click(within(dialog).getByRole('button', { name: 'Remove document' }))

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            typeof url === 'string' &&
            url.includes('/api/platform/knowledge/documents/oib-richtlinie-2.pdf') &&
            (init as RequestInit | undefined)?.method === 'DELETE'
        )
      ).toBe(true)
    })
  })

  test('an indexed file the corpus no longer lists can be deleted but not viewed', async () => {
    const orphaned: KnowledgeBaseStatus = {
      ...STATUS,
      files: [...STATUS.files, file({ fileName: 'orphan.pdf', state: 'removed', sizeBytes: null })],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(orphaned)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'orphan.pdf')

    expect(within(sheet).queryByRole('button', { name: 'View PDF' })).not.toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: 'Remove' })).toBeInTheDocument()
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
      if (
        typeof url === 'string' &&
        url === '/api/platform/knowledge/documents' &&
        init?.method === 'POST'
      ) {
        return Promise.resolve(
          jsonResponse({ status: 'pending', kind: 'file', fileName: 'dropped.pdf', members: null })
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
            (init as RequestInit | undefined)?.method === 'POST'
        )
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
          })
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
            (init as RequestInit | undefined)?.method === 'POST'
        )
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
      files: [...STATUS.files, file({ fileName: 'a.pdf', docClass: 'sonstiges' })],
    }
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (
        typeof url === 'string' &&
        url.includes('/api/platform/knowledge/documents') &&
        init?.method === 'POST'
      ) {
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

    await pickMenu(user, /Sync corpus/)

    // Sync costs model calls on every new PDF, so it asks first and says so.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Sync the corpus?')
    expect(dialog).toHaveTextContent(/costs model calls/)
    expect(requestsTo(fetchSpy, '/sync')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Sync' }))

    await waitFor(() => {
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) =>
            typeof url === 'string' &&
            url === '/api/platform/knowledge/sync' &&
            (init as RequestInit | undefined)?.method === 'POST'
        )
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
    await user.click(screen.getByRole('option', { name: 'Law / building code' }))

    await waitFor(() => {
      const patched = fetchSpy.mock.calls
        .filter(
          ([url, init]) =>
            typeof url === 'string' &&
            url.includes('/doc-class') &&
            (init as RequestInit | undefined)?.method === 'PATCH'
        )
        .map(([url]) => url as string)
      expect(patched).toHaveLength(2)
      expect(patched.some((url) => url.includes('oib-richtlinie-2.pdf'))).toBe(true)
      expect(patched.some((url) => url.includes('oenorm-b-1600.pdf'))).toBe(true)
    })
  })

  test('re-indexing sends exactly the selected documents in one request', async () => {
    // Sync is incremental and gates on each PDF's sha256, so it does nothing for an
    // unchanged file. This is the control for rebuilding chunks after a change to how
    // they are BUILT, and it must not touch documents the admin did not select.
    const fetchSpy = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes('/reingest')) {
        return Promise.resolve(
          jsonResponse({
            status: 'pending',
            queued: ['oib-richtlinie-2.pdf'],
            unknown: [],
            message: 'ok',
          })
        )
      }
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    await user.click(screen.getByRole('checkbox', { name: 'Select oib-richtlinie-2.pdf' }))
    const selectionBar = await screen.findByTestId('data-toolbar-selection')
    await user.click(within(selectionBar).getByRole('button', { name: /Re-index/i }))

    // Re-indexing re-runs OCR, captioning and embedding: confirm, with the scope named.
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Re-index 1 document?')
    expect(within(dialog).getByTestId('confirm-name-list')).toHaveTextContent(
      'oib-richtlinie-2.pdf'
    )
    expect(dialog).toHaveTextContent(/costs model calls/)
    expect(requestsTo(fetchSpy, '/reingest')).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Re-index 1 document' }))

    await waitFor(() => {
      const calls = fetchSpy.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/reingest')
      )
      expect(calls).toHaveLength(1)
      const [, init] = calls[0]
      expect((init as RequestInit).method).toBe('POST')
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        fileNames: ['oib-richtlinie-2.pdf'],
      })
    })
  })

  test('re-indexing nothing the corpus still has reports it instead of claiming success', async () => {
    const fetchSpy = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes('/reingest')) {
        return Promise.resolve(
          jsonResponse({ status: 'noop', queued: [], unknown: ['gone.pdf'], message: '' })
        )
      }
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    await user.click(screen.getByRole('checkbox', { name: 'Select oib-richtlinie-2.pdf' }))
    const selectionBar = await screen.findByTestId('data-toolbar-selection')
    await user.click(within(selectionBar).getByRole('button', { name: /Re-index/i }))
    await user.click(await screen.findByTestId('knowledge-reingest-confirm'))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())

    // The selection survives, because nothing was started and the admin may want to retry.
    await waitFor(() => {
      expect(screen.getByTestId('data-toolbar-selection')).toHaveTextContent('1 selected')
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
        ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE'
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

  test('the German document-type labels equal the backend vocabulary', () => {
    // The UI reads the dictionary, the parity test pins DOC_CLASS_LABELS to the
    // Python file; this keeps the two German spellings from drifting apart.
    expect(dePlatform.knowledge.docClasses).toEqual(DOC_CLASS_LABELS)
  })

  test('the delete dialog keeps its targets while the request is in flight', async () => {
    // Regression: the rows are removed optimistically, and the dialog used to
    // derive its targets from the live list, so mid-request the title read
    // " entfernen?" and a bulk delete flipped to the single-file copy.
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Promise<Response>(() => {})
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')
    await user.click(screen.getByRole('checkbox', { name: 'Select oib-richtlinie-2.pdf' }))
    await user.click(screen.getByRole('checkbox', { name: 'Select sonstiges-notiz.pdf' }))
    await user.click(
      within(await screen.findByTestId('data-toolbar-selection')).getByRole('button', {
        name: 'Remove',
      })
    )

    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Remove 2 documents' }))

    await waitFor(() => expect(requestsTo(fetchSpy, '/documents/', 'DELETE')).toHaveLength(2))
    // The rows are gone from the table, the dialog still names what it deletes.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Open details for sonstiges/ })).toBeNull()
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('Remove 2 documents?')
    expect(screen.getByRole('dialog')).toHaveTextContent('sonstiges-notiz.pdf')
  })

  test('a failed refresh keeps the loaded table and says so in a toast', async () => {
    // Regression: any failed load set the status to null, so a transient error
    // after a reclassify replaced the whole table with an error card.
    let loads = 0
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Promise.resolve(jsonResponse({ ok: true }))
      loads += 1
      return Promise.resolve(
        loads === 1 ? jsonResponse(STATUS) : jsonResponse({ error: 'flaky' }, false, 502)
      )
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'oenorm-b-1600.pdf')
    await user.click(within(sheet).getByRole('combobox', { name: /Document type for oenorm/ }))
    await user.click(screen.getByRole('option', { name: 'Law / building code' }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The list could not be refreshed. Showing the last loaded state.'
      )
    )
    expect(screen.queryByText('The knowledge base could not be loaded.')).not.toBeInTheDocument()
    // `hidden`: the open sheet aria-hides the page; the row is still rendered behind it.
    expect(
      screen.getByRole('button', { name: 'Open details for oib-richtlinie-2.pdf', hidden: true })
    ).toBeInTheDocument()
  })

  test('cancelling the sync or re-index confirm sends nothing', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse(STATUS))
    vi.stubGlobal('fetch', fetchSpy)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')

    await pickMenu(user, /Sync corpus/)
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('checkbox', { name: 'Select oenorm-b-1600.pdf' }))
    await user.click(
      within(screen.getByTestId('data-toolbar-selection')).getByRole('button', { name: /Re-index/ })
    )
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    expect(requestsTo(fetchSpy, '/sync')).toHaveLength(0)
    expect(requestsTo(fetchSpy, '/reingest')).toHaveLength(0)
  })

  test('documents with issues can be re-indexed together from the overflow menu', async () => {
    const withIssues: KnowledgeBaseStatus = {
      ...STATUS,
      summary: { ...STATUS.summary, totalFiles: 5, ingested: 3, failed: 1, stale: 1 },
      files: [
        ...STATUS.files,
        file({ fileName: 'broken.pdf', state: 'failed', chunkCount: 0 }),
        file({ fileName: 'old.pdf', state: 'stale' }),
      ],
    }
    const fetchSpy = vi.fn((url: string, _init?: RequestInit) => {
      if (url.includes('/reingest')) {
        return Promise.resolve(
          jsonResponse({ status: 'pending', queued: ['broken.pdf', 'old.pdf'], unknown: [] })
        )
      }
      return Promise.resolve(jsonResponse(withIssues))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    expect(
      within(await screen.findByTestId('knowledge-summary-issues')).getByText('2')
    ).toBeInTheDocument()

    await pickMenu(user, /Re-index issues \(2\)/)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Re-index 2 documents?')
    await user.click(within(dialog).getByRole('button', { name: 'Re-index 2 documents' }))

    await waitFor(() => {
      const [call] = requestsTo(fetchSpy, '/reingest', 'POST')
      expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
        fileNames: ['broken.pdf', 'old.pdf'],
      })
    })
  })

  test('the status filter narrows the table to documents that need attention', async () => {
    const withIssue: KnowledgeBaseStatus = {
      ...STATUS,
      files: [...STATUS.files, file({ fileName: 'broken.pdf', state: 'failed', chunkCount: 0 })],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(withIssue)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('broken.pdf')
    await user.click(screen.getByRole('combobox', { name: 'Status' }))
    await user.click(screen.getByRole('option', { name: 'Has issues' }))

    await waitFor(() => expect(screen.queryByText('oib-richtlinie-2.pdf')).not.toBeInTheDocument())
    expect(screen.getByText('broken.pdf')).toBeInTheDocument()
  })

  test('the detail sheet states what a status means in visible text', async () => {
    const withIssue: KnowledgeBaseStatus = {
      ...STATUS,
      files: [...STATUS.files, file({ fileName: 'broken.pdf', state: 'failed', chunkCount: 0 })],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(withIssue)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    const sheet = await openDetail(user, 'broken.pdf')
    expect(within(sheet).getByTestId('knowledge-detail-state-hint')).toHaveTextContent(
      /Processing did not finish/
    )
  })

  test('the dropzone is a keyboard-reachable button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')
    await user.click(screen.getByRole('button', { name: /Add documents/ }))

    const zone = screen.getByTestId('knowledge-dropzone')
    expect(zone.tagName).toBe('BUTTON')
    expect(zone).toHaveAttribute('type', 'button')
  })

  test('a drop while an upload is running is refused with a reason, not ignored', async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/platform/knowledge/documents' && init?.method === 'POST')
        return new Promise<Response>(() => {})
      return Promise.resolve(jsonResponse(STATUS))
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const user = userEvent.setup()

    render(<BaseKnowledge />)
    await screen.findByText('oib-richtlinie-2.pdf')
    await user.click(screen.getByRole('button', { name: /Add documents/ }))

    const first = new File(['%PDF-1.4'], 'first.pdf', { type: 'application/pdf' })
    const second = new File(['%PDF-1.4'], 'second.pdf', { type: 'application/pdf' })
    fireEvent.drop(screen.getByTestId('knowledge-dropzone'), { dataTransfer: { files: [first] } })
    await waitFor(() =>
      expect(requestsTo(fetchSpy, '/api/platform/knowledge/documents', 'POST')).toHaveLength(1)
    )

    fireEvent.drop(screen.getByTestId('knowledge-dropzone'), { dataTransfer: { files: [second] } })
    expect(toast.info).toHaveBeenCalledWith('Wait for the current upload or sync to finish.')
    expect(requestsTo(fetchSpy, '/api/platform/knowledge/documents', 'POST')).toHaveLength(1)
  })

  test('read-only platform staff see the corpus without any write control', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(STATUS)))
    const user = userEvent.setup()

    render(
      <PlatformAccessProvider permissions={[PLATFORM_PERMISSIONS.settingsView]}>
        <BaseKnowledge />
      </PlatformAccessProvider>
    )
    await screen.findByText('oib-richtlinie-2.pdf')

    expect(screen.getByTestId('knowledge-read-only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add documents/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    const sheet = await openDetail(user, 'oib-richtlinie-2.pdf')
    expect(within(sheet).getByRole('button', { name: 'View PDF' })).toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(within(sheet).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(sheet).queryByRole('combobox')).not.toBeInTheDocument()
  })
})
