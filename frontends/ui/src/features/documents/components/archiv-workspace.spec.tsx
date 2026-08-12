import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { ArchivWorkspace } from './archiv-workspace'

/**
 * The completion toast is an assertion here, not decoration: it is the only
 * moment the Archiv tells a user that the file they uploaded became usable.
 */
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
  },
}))

const mockUploadFiles = vi.fn()

vi.mock('../hooks/use-archiv-documents', () => ({
  useArchivDocuments: vi.fn().mockImplementation(() => ({
    uploadFiles: mockUploadFiles,
    cancelUpload: vi.fn(),
    retryFile: vi.fn(),
    trackedFiles: [],
    isUploading: false,
    isPolling: false,
    error: null,
    clearError: vi.fn(),
  })),
}))

// useFileDragDrop reads accepted MIME types from AppConfig for its drag affordance.
vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    authRequired: true,
    fileUpload: {
      acceptedTypes: '.pdf,.docx,.txt,.md',
      acceptedMimeTypes: ['application/pdf', 'text/plain', 'text/markdown'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

const archivDocuments = [
  {
    id: 'doc-1',
    filename: 'brandschutz-gutachten.pdf',
    fileSize: 2048,
    contentType: 'application/pdf',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
    summary: 'Brandschutzkonzept für mehrgeschossigen Holzbau.',
    tags: ['Brandschutz', 'Gutachten'],
  },
  {
    id: 'doc-2',
    filename: 'fassadendetail.pdf',
    fileSize: 1024,
    contentType: 'application/pdf',
    status: 'completed',
    createdAt: '2026-01-02T00:00:00Z',
    errorMessage: null,
    tags: ['Detail'],
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  server.use(
    http.get('/api/archiv/documents', () =>
      HttpResponse.json({
        documents: archivDocuments,
        collectionName: 'archiv_org-1',
        canManage: true,
      })
    ),
    http.get('/api/documents/:id/preview', () => HttpResponse.json({ url: null }))
  )
})

describe('ArchivWorkspace — library listing', () => {
  it('loads the Archiv and renders the library card grid with category chips', async () => {
    render(<ArchivWorkspace canManage />)

    expect(await screen.findByText('brandschutz-gutachten.pdf')).toBeInTheDocument()
    expect(screen.getAllByTestId('archiv-document-card')).toHaveLength(2)
    // Real AI summary is surfaced; the tag-driven category row too.
    expect(screen.getByText('Brandschutzkonzept für mehrgeschossigen Holzbau.')).toBeInTheDocument()
    const group = screen.getByRole('group', { name: /filter by category/i })
    expect(within(group).getByRole('button', { name: 'Brandschutz' })).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: 'Detail' })).toBeInTheDocument()
  })

  it('filters the grid via a category chip', async () => {
    const user = userEvent.setup()
    render(<ArchivWorkspace canManage />)
    await screen.findByText('brandschutz-gutachten.pdf')

    await user.click(screen.getByRole('button', { name: 'Detail' }))
    expect(screen.getByText('fassadendetail.pdf')).toBeInTheDocument()
    expect(screen.queryByText('brandschutz-gutachten.pdf')).not.toBeInTheDocument()
  })

  it('shows the load-error state with a retry affordance when the list request fails', async () => {
    server.use(http.get('/api/archiv/documents', () => HttpResponse.json({}, { status: 500 })))
    render(<ArchivWorkspace canManage />)

    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })
})

describe('ArchivWorkspace — permissions', () => {
  it('offers the upload affordance to managers', async () => {
    render(<ArchivWorkspace canManage />)
    await screen.findByText('brandschutz-gutachten.pdf')
    expect(screen.getByRole('button', { name: /upload/i })).toBeInTheDocument()
  })

  it('hides upload and delete for read-only members', async () => {
    render(<ArchivWorkspace canManage={false} />)
    await screen.findByText('brandschutz-gutachten.pdf')
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByText('brandschutz-gutachten.pdf'))
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /delete from archiv/i })).not.toBeInTheDocument()
    )
  })
})

/**
 * An Archiv upload has to stop saying "Wird gelesen…" on its own.
 *
 * The Archiv asked for its list on mount and once more from `onComplete` —
 * which fires when the BYTES land, i.e. the moment extraction STARTS. An `.ifc`
 * has no ingest job at all (`beginModelExtraction` returns a null job id), so
 * the upload orchestrator never watched it either: every model uploaded here
 * sat at "Processing" until someone reloaded the page, and the ingestion-
 * complete toast never fired. The project Files workspace had a settling poll
 * for exactly this; both surfaces now share it.
 */
describe('ArchivWorkspace — a settling document settles on screen', () => {
  /** How many times the Archiv list has been asked for, across the poll. */
  let documentCalls = 0

  const corpus = (status: string) =>
    HttpResponse.json({
      documents: [
        {
          id: 'doc-ifc',
          filename: 'Haus-A.ifc',
          fileSize: 148_900_000,
          contentType: 'application/octet-stream',
          status,
          createdAt: '2026-01-01T00:00:00Z',
          errorMessage: null,
          tags: [],
        },
      ],
      collectionName: 'archiv_org-1',
      canManage: true,
    })

  beforeEach(() => {
    documentCalls = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-asks while a model is being read, and stops once it is', async () => {
    server.use(
      http.get('/api/archiv/documents', () => {
        documentCalls += 1
        // Still extracting on the first read; done by the time the poll fires.
        return corpus(documentCalls === 1 ? 'processing' : 'ready')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ArchivWorkspace canManage />)
    await waitFor(() => expect(documentCalls).toBe(1))
    expect(await screen.findByText('Processing')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(4_100)
    await waitFor(() => expect(documentCalls).toBe(2))
    // The badge the user is actually looking at flips, without a reload.
    await waitFor(() => expect(screen.getByText('Citable')).toBeInTheDocument())

    // Everything is terminal now, so the polling stops rather than asking
    // forever about a corpus that cannot change on its own.
    const settled = documentCalls
    await vi.advanceTimersByTimeAsync(12_000)
    expect(documentCalls).toBe(settled)
  })

  it('confirms the moment the document becomes citable', async () => {
    server.use(
      http.get('/api/archiv/documents', () => {
        documentCalls += 1
        return corpus(documentCalls === 1 ? 'processing' : 'ready')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ArchivWorkspace canManage />)
    await waitFor(() => expect(documentCalls).toBe(1))
    expect(toastSuccess).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(4_100)
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        expect.stringContaining('Haus-A.ifc'),
        expect.anything()
      )
    )
  })

  it('keeps at most one poll in flight, however slow the endpoint is', async () => {
    // `setInterval` would fire again whether or not the previous refresh had
    // come back, letting an older response land after a newer one — overwriting
    // a document that had just finished with its earlier "still reading" row.
    let inFlight = 0
    let peak = 0
    const gate: { release: (() => void) | null } = { release: null }
    server.use(
      http.get('/api/archiv/documents', async () => {
        documentCalls += 1
        inFlight += 1
        peak = Math.max(peak, inFlight)
        if (documentCalls > 1) await new Promise<void>((resolve) => (gate.release = resolve))
        inFlight -= 1
        return corpus('processing')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ArchivWorkspace canManage />)
    await waitFor(() => expect(documentCalls).toBe(1))

    // Three poll windows pass while the second request is still hanging.
    await vi.advanceTimersByTimeAsync(13_000)
    expect(documentCalls).toBe(2)
    expect(peak).toBe(1)

    gate.release?.()
  })

  it('polls quietly — the grid the user is reading is never replaced by a skeleton', async () => {
    // The poll is held open, so the assertion lands WHILE a refresh is in
    // flight: a foreground load would have swapped the whole pane for skeletons
    // every four seconds, which is the reason the flag exists.
    const gate: { release: (() => void) | null } = { release: null }
    server.use(
      http.get('/api/archiv/documents', async () => {
        documentCalls += 1
        if (documentCalls > 1) await new Promise<void>((resolve) => (gate.release = resolve))
        return corpus('processing')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ArchivWorkspace canManage />)
    expect(await screen.findByText('Haus-A.ifc')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(4_100)
    await waitFor(() => expect(documentCalls).toBe(2))
    expect(screen.getByText('Haus-A.ifc')).toBeInTheDocument()

    gate.release?.()
  })
})

describe('ArchivWorkspace — preview and delete', () => {
  it('opens the shared preview pane on card selection with the two-step delete for managers', async () => {
    const user = userEvent.setup()
    render(<ArchivWorkspace canManage />)

    await user.click(await screen.findByText('brandschutz-gutachten.pdf'))

    // First click arms the confirmation; nothing is deleted yet.
    const deleteButton = await screen.findByRole('button', { name: /delete from archiv/i })
    await user.click(deleteButton)
    expect(screen.getByText(/removes the document for the whole organization/i)).toBeInTheDocument()

    // Cancel returns to the armed-off state.
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(screen.getByRole('button', { name: /delete from archiv/i })).toBeInTheDocument()
  })

  it('deletes on confirm and removes the card from the grid', async () => {
    server.use(
      http.delete('/api/archiv/documents/:id', () => new HttpResponse(null, { status: 204 }))
    )
    const user = userEvent.setup()
    render(<ArchivWorkspace canManage />)

    await user.click(await screen.findByText('fassadendetail.pdf'))
    await user.click(await screen.findByRole('button', { name: /delete from archiv/i }))
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.queryByText('fassadendetail.pdf')).not.toBeInTheDocument())
    expect(screen.getByText('brandschutz-gutachten.pdf')).toBeInTheDocument()
  })
})
