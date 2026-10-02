import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { ArchivWorkspace } from './archiv-workspace'
import { useArchivDocuments } from '../hooks/use-archiv-documents'

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

const navigation = vi.hoisted(() => ({ search: '', replace: vi.fn() }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: navigation.replace, refresh: vi.fn() }),
  usePathname: () => '/app/archiv',
  useSearchParams: () => new URLSearchParams(navigation.search),
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
  navigation.search = ''
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

  it('states how much the Archiv holds beside its title', async () => {
    render(<ArchivWorkspace canManage />)
    expect(await screen.findByTestId('archiv-document-count')).toHaveTextContent('2')
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
  // Paged, not capped: the Archiv used to stop at its newest 500 without a word.
  it('reads every page of the Archiv, following the cursor', async () => {
    const cursors: Array<string | null> = []
    server.use(
      http.get('/api/archiv/documents', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor')
        cursors.push(cursor)
        return HttpResponse.json({
          documents: cursor ? [archivDocuments[1]] : [archivDocuments[0]],
          nextCursor: cursor ? null : 'page-2',
          collectionName: 'archiv_org-1',
          canManage: true,
        })
      })
    )
    render(<ArchivWorkspace canManage />)

    expect(await screen.findByText('fassadendetail.pdf')).toBeInTheDocument()
    expect(screen.getByText('brandschutz-gutachten.pdf')).toBeInTheDocument()
    expect(cursors).toEqual([null, 'page-2'])
    expect(screen.queryByText(/showing the newest/i)).not.toBeInTheDocument()
  })

  it('says where it stopped when the Archiv outruns the page ceiling', async () => {
    let requests = 0
    server.use(
      http.get('/api/archiv/documents', () => {
        requests += 1
        return HttpResponse.json({
          documents: [{ ...archivDocuments[0], id: `doc-${requests}`, filename: `plan-${requests}.pdf` }],
          nextCursor: `c${requests}`,
          collectionName: 'archiv_org-1',
          canManage: true,
        })
      })
    )
    render(<ArchivWorkspace canManage />)

    expect(await screen.findByText(/showing the newest 20 documents/i)).toBeInTheDocument()
    expect(requests).toBe(20)
  })
})

describe('ArchivWorkspace — permissions', () => {
  it('offers the upload affordance to managers', async () => {
    render(<ArchivWorkspace canManage />)
    await screen.findByText('brandschutz-gutachten.pdf')
    expect(screen.getByRole('button', { name: /upload/i })).toBeInTheDocument()
  })

  it('leaves a read-only member the download and nothing that mutates', async () => {
    render(<ArchivWorkspace canManage={false} />)
    await screen.findByText('brandschutz-gutachten.pdf')
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument()

    const user = userEvent.setup()
    // Each card keeps a download-only overflow menu; rename/delete stay gone.
    const triggers = screen.getAllByTestId('document-actions-trigger')
    expect(triggers.length).toBeGreaterThan(0)
    await user.click(triggers[0])
    expect(await screen.findByRole('menuitem', { name: /download/i })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /rename/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /delete/i })).not.toBeInTheDocument()
  })
})

/**
 * An Archiv upload has to stop saying "Wird verarbeitet…" on its own.
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
  /** How many times the whole Archiv list has been asked for. */
  let documentCalls = 0
  /** How many times the settling row's own status has been asked for. */
  let statusCalls = 0

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

  const statusOf = (status: string) => HttpResponse.json({ id: 'doc-ifc', filename: 'Haus-A.ifc', status })

  beforeEach(() => {
    documentCalls = 0
    statusCalls = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-asks the settling row by id — not the whole Archiv — and stops once it is terminal', async () => {
    server.use(
      http.get('/api/archiv/documents', () => {
        documentCalls += 1
        return corpus('processing')
      }),
      http.get('/api/documents/:id/status', ({ params }) => {
        statusCalls += 1
        expect(params.id).toBe('doc-ifc')
        return statusOf('ready')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ArchivWorkspace canManage />)
    await waitFor(() => expect(documentCalls).toBe(1))
    expect(await screen.findByText('Reading')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(4_100)
    await waitFor(() => expect(statusCalls).toBe(1))
    // The badge the user is actually looking at flips, without a reload.
    await waitFor(() => expect(screen.getByText('Citable')).toBeInTheDocument())
    // The poll never drained the listing again.
    expect(documentCalls).toBe(1)

    // Everything is terminal now, so the polling stops.
    await vi.advanceTimersByTimeAsync(12_000)
    expect(statusCalls).toBe(1)
    expect(documentCalls).toBe(1)
  })

  it('confirms the moment the document becomes citable', async () => {
    server.use(
      http.get('/api/archiv/documents', () => {
        documentCalls += 1
        return corpus('processing')
      }),
      http.get('/api/documents/:id/status', () => statusOf('ready'))
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
    // come back, letting an older response land after a newer one.
    let inFlight = 0
    let peak = 0
    const gate: { release: (() => void) | null } = { release: null }
    server.use(
      http.get('/api/archiv/documents', () => {
        documentCalls += 1
        return corpus('processing')
      }),
      http.get('/api/documents/:id/status', async () => {
        statusCalls += 1
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise<void>((resolve) => (gate.release = resolve))
        inFlight -= 1
        return statusOf('processing')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ArchivWorkspace canManage />)
    await waitFor(() => expect(documentCalls).toBe(1))

    // Three poll windows pass while the first status read is still hanging.
    await vi.advanceTimersByTimeAsync(13_000)
    expect(statusCalls).toBe(1)
    expect(peak).toBe(1)

    gate.release?.()
  })

  it('polls quietly — the grid the user is reading is never replaced by a skeleton', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    server.use(
      http.get('/api/archiv/documents', () => {
        documentCalls += 1
        return corpus('processing')
      }),
      http.get('/api/documents/:id/status', async () => {
        statusCalls += 1
        await new Promise<void>((resolve) => (gate.release = resolve))
        return statusOf('processing')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ArchivWorkspace canManage />)
    expect(await screen.findByText('Haus-A.ifc')).toBeInTheDocument()

    await vi.advanceTimersByTimeAsync(4_100)
    await waitFor(() => expect(statusCalls).toBe(1))
    expect(screen.getByText('Haus-A.ifc')).toBeInTheDocument()

    gate.release?.()
  })

  it('reloads quietly when an upload finishes on any surface', async () => {
    // The orchestrator tells every subscriber, so a chat attachment finishing
    // lands here too. A skeleton over the Archiv for it is a flash for nothing.
    const gate: { release: (() => void) | null } = { release: null }
    server.use(
      http.get('/api/archiv/documents', async () => {
        documentCalls += 1
        if (documentCalls > 1) await new Promise<void>((resolve) => (gate.release = resolve))
        return corpus('ready')
      })
    )

    render(<ArchivWorkspace canManage />)
    expect(await screen.findByText('Haus-A.ifc')).toBeInTheDocument()

    const onComplete = vi.mocked(useArchivDocuments).mock.calls.at(-1)?.[0]?.onComplete
    onComplete?.()
    await waitFor(() => expect(documentCalls).toBe(2))
    expect(screen.getByText('Haus-A.ifc')).toBeInTheDocument()

    // And the callback is one function for the life of the page, so the
    // orchestrator subscription is not re-made on every render.
    const callbacks = new Set(vi.mocked(useArchivDocuments).mock.calls.map(([options]) => options?.onComplete))
    expect(callbacks.size).toBe(1)

    gate.release?.()
  })
})

/**
 * A late answer must never overwrite a newer one.
 *
 * `useSettlingRefresh` serialises its OWN polls, so at most one poll is in
 * flight — but nothing coordinated that poll with a FOREGROUND load. A slow
 * status read carrying `processing` could land after a newer load had already
 * brought back `ready`, putting the "Wird gelesen…" badge back on a document
 * the user had just been told was citable — and, because the row read as
 * unsettled again, restarting the poll that was supposed to have stopped.
 */
describe('ArchivWorkspace — only the newest answer may win', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

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

  /**
   * Let the released response travel msw → fetch → React, WITHOUT letting the
   * 4 s settling poll fire. If a stale answer regressed the badge, a restarted
   * poll would heal it and the test would pass while the user still saw the
   * flicker.
   */
  const flushWithoutPolling = async () => {
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(50)
  }

  it('ignores a poll response that resolves after a newer foreground load', async () => {
    let documentCalls = 0
    let statusCalls = 0
    const gate: { release: (() => void) | null } = { release: null }
    server.use(
      http.get('/api/archiv/documents', () => {
        documentCalls += 1
        return corpus(documentCalls === 1 ? 'processing' : 'ready')
      }),
      // The POLL is held open until a newer load has already answered
      // `ready`, then answers the stale `processing`.
      http.get('/api/documents/:id/status', async () => {
        statusCalls += 1
        await new Promise<void>((resolve) => (gate.release = resolve))
        return HttpResponse.json({ id: 'doc-ifc', filename: 'Haus-A.ifc', status: 'processing' })
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ArchivWorkspace canManage />)
    expect(await screen.findByText('Reading')).toBeInTheDocument()

    // The settling poll goes out and hangs.
    await vi.advanceTimersByTimeAsync(4_100)
    await waitFor(() => expect(statusCalls).toBe(1))

    // Meanwhile the upload orchestrator finishes and asks for the list again.
    const onComplete = vi.mocked(useArchivDocuments).mock.calls.at(-1)?.[0]?.onComplete
    expect(onComplete).toBeTypeOf('function')
    onComplete?.()
    await waitFor(() => expect(documentCalls).toBe(2))
    await waitFor(() => expect(screen.getByText('Citable')).toBeInTheDocument())

    // Now the stale poll answers. It is older than what is on screen, so it
    // must not commit.
    gate.release?.()
    await flushWithoutPolling()

    expect(screen.getByText('Citable')).toBeInTheDocument()
    expect(screen.queryByText('Reading')).not.toBeInTheDocument()

    // …and it must not resurrect the poll either.
    await vi.advanceTimersByTimeAsync(8_000)
    expect(statusCalls).toBe(1)
    expect(documentCalls).toBe(2)
  })
})

describe('ArchivWorkspace — a link to one document', () => {
  it('opens the document ?doc= names once the corpus has it, and lets go of the parameter', async () => {
    navigation.search = 'doc=doc-2'
    render(<ArchivWorkspace canManage />)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByText('fassadendetail.pdf').length).toBeGreaterThan(0)
    expect(navigation.replace).toHaveBeenCalledWith('/app/archiv', { scroll: false })
  })

  it('opens nothing for an id the Archiv does not hold, and still drops it', async () => {
    navigation.search = 'doc=gone'
    render(<ArchivWorkspace canManage />)

    expect(await screen.findByText('fassadendetail.pdf')).toBeInTheDocument()
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledWith('/app/archiv', { scroll: false }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

/** Open the Archiv preview for a document and the preview-header actions menu. */
async function openActions(user: ReturnType<typeof userEvent.setup>, filename: string) {
  await user.click(await screen.findByText(filename))
  const dialog = await screen.findByRole('dialog')
  await user.click(within(dialog).getByTestId('document-actions-trigger'))
}

describe('ArchivWorkspace — file operations', () => {
  it('asks before deleting, names the document, and cancels without deleting', async () => {
    let deleted = false
    server.use(
      http.delete('/api/archiv/documents/:id', () => {
        deleted = true
        return new HttpResponse(null, { status: 204 })
      })
    )
    const user = userEvent.setup()
    render(<ArchivWorkspace canManage />)

    await openActions(user, 'brandschutz-gutachten.pdf')
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }))

    // The question names the file, and the answer says what is lost.
    expect(await screen.findByText('Delete “brandschutz-gutachten.pdf”?')).toBeInTheDocument()
    expect(screen.getByText(/removes the document for the whole organization/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect(deleted).toBe(false)
    // The card is still in the grid (the preview header names it too, hence
    // "all").
    expect(screen.getAllByText('brandschutz-gutachten.pdf').length).toBeGreaterThan(0)
  })

  it('deletes on confirm and removes the card from the grid', async () => {
    server.use(
      http.delete('/api/archiv/documents/:id', () => new HttpResponse(null, { status: 204 }))
    )
    const user = userEvent.setup()
    render(<ArchivWorkspace canManage />)

    await openActions(user, 'fassadendetail.pdf')
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }))
    await user.click(await screen.findByTestId('document-delete-confirm'))

    await waitFor(() => expect(screen.queryByText('fassadendetail.pdf')).not.toBeInTheDocument())
    expect(screen.getByText('brandschutz-gutachten.pdf')).toBeInTheDocument()
  })

  it('renames through the scope-aware document route and shows the new name on the card', async () => {
    const patched: Array<{ id: string; body: unknown }> = []
    server.use(
      http.patch('/api/documents/:id', async ({ params, request }) => {
        const body = (await request.json()) as { displayName: string | null }
        patched.push({ id: String(params.id), body })
        return HttpResponse.json({ id: params.id, filename: 'fassadendetail.pdf', ...body })
      })
    )
    const user = userEvent.setup()
    render(<ArchivWorkspace canManage />)

    await openActions(user, 'fassadendetail.pdf')
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }))

    const field = await screen.findByLabelText('Name')
    await user.clear(field)
    await user.type(field, 'Fassade Nord')
    await user.click(screen.getByTestId('rename-submit'))

    // The extension is the pane's, not the typist's: it is a fact about the
    // bytes and survives whatever is typed into the stem.
    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toEqual({
      id: 'doc-2',
      body: { displayName: 'Fassade Nord.pdf' },
    })
    // Both the card and the preview header carry the new name.
    expect((await screen.findAllByText('Fassade Nord.pdf')).length).toBeGreaterThan(0)
  })
})

/**
 * The Archiv answers a same-name file the way a project's Dateien does (U1):
 * it asks for a new version, from the shelf itself — asked of the server by
 * name (`POST /api/archiv/documents/name-matches`), since the listing on screen
 * is paged — and never refuses or replaces on one browser's memory.
 */
describe('ArchivWorkspace — a file the Archiv already holds', () => {
  let probed: string[][]
  /** What the probe answers from: the Archiv's documents, by exact name. */
  let shelf: Array<{ id: string; filename: string; lifecycle?: 'active' | 'archived' }>

  beforeEach(() => {
    probed = []
    shelf = archivDocuments.map((doc) => ({ id: doc.id, filename: doc.filename }))
    server.use(
      http.post('/api/archiv/documents/name-matches', async ({ request }) => {
        const { names } = (await request.json()) as { names: string[] }
        probed.push(names)
        return HttpResponse.json({
          documents: shelf
            .filter((doc) => names.includes(doc.filename))
            .map((doc) => ({
              id: doc.id,
              filename: doc.filename,
              displayName: null,
              fileSize: 2048,
              contentHash: null,
              folderId: null,
              authoredBy: 'user',
              lifecycle: doc.lifecycle ?? 'active',
            })),
        })
      })
    )
  })

  function pick(file: File) {
    const input = screen.getAllByTestId('project-upload-input')[0] as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  it('asks „new version of X?" and uploads on yes', async () => {
    const user = userEvent.setup()
    render(<ArchivWorkspace canManage />)
    await screen.findByText('brandschutz-gutachten.pdf')

    const revised = new File(['revised'], 'brandschutz-gutachten.pdf', { type: 'application/pdf' })
    pick(revised)

    const dialog = await screen.findByTestId('folder-upload-dialog')
    expect(dialog).toHaveAttribute('data-kind', 'single-update')
    expect(mockUploadFiles).not.toHaveBeenCalled()

    await user.click(within(dialog).getByTestId('folder-upload-confirm'))
    await waitFor(() => expect(mockUploadFiles).toHaveBeenCalledWith([revised], expect.objectContaining({ screeningReleased: expect.any(Function) })))
    expect(probed).toEqual([['brandschutz-gutachten.pdf']])
  })

  // Paged listing: the oldest Archiv document may not be loaded, and the upload
  // versions it anyway. The probe is what knows.
  it('asks about a same-name document the loaded listing does not hold', async () => {
    shelf = [{ id: 'doc-old', filename: 'alt-norm.pdf', lifecycle: 'archived' }]
    render(<ArchivWorkspace canManage />)
    await screen.findByText('brandschutz-gutachten.pdf')

    pick(new File(['x'], 'alt-norm.pdf', { type: 'application/pdf' }))

    const dialog = await screen.findByTestId('folder-upload-dialog')
    await waitFor(() => expect(dialog).toHaveAttribute('data-kind', 'single-update'))
    expect(within(dialog).getByTestId('folder-upload-archived')).toBeInTheDocument()
    expect(mockUploadFiles).not.toHaveBeenCalled()
  })

  it('sends a file with a name it does not hold straight to the upload', async () => {
    render(<ArchivWorkspace canManage />)
    await screen.findByText('brandschutz-gutachten.pdf')

    const fresh = new File(['x'], 'neu.pdf', { type: 'application/pdf' })
    pick(fresh)

    await waitFor(() => expect(mockUploadFiles).toHaveBeenCalledWith([fresh]))
    expect(screen.queryByTestId('folder-upload-dialog')).not.toBeInTheDocument()
  })
})
