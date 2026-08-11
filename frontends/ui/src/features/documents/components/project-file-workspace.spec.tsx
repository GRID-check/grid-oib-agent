import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { ProjectFileWorkspace } from './project-file-workspace'

const mockUploadFiles = vi.fn()

/**
 * The workspace reads the URL now: `?model=` is what turns Dateien into the
 * model viewer, so the page needs a router the way every other URL-backed
 * surface in the app does.
 */
const routerReplace = vi.fn()
let searchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: (...args: unknown[]) => routerReplace(...args),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/app/projects/p1/files',
  useSearchParams: () => searchParams,
}))

/**
 * Toasts are assertions here, not decoration: the confirmation a user gets when
 * an upload finally lands is the only place the app says what the file became.
 */
const toastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
  },
}))

// Force the mobile presentation so the preview renders as a full-screen dialog.
vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => true,
}))

vi.mock('../hooks/use-project-documents', () => ({
  useProjectDocuments: vi.fn().mockImplementation(() => ({
    uploadFiles: mockUploadFiles,
    retryFile: vi.fn(),
    isUploading: false,
    trackedFiles: [],
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

/** Minimal DataTransfer stand-in for jsdom drag events. */
function makeDataTransfer(files: File[]) {
  return {
    items: files.map((f) => ({ kind: 'file', type: f.type })),
    files,
    types: ['Files'],
  }
}

describe('ProjectFileWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
  })

  it('renders the file workspace with its project name and corpus context', () => {
    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    expect(screen.getByText('Test')).toBeDefined()
    expect(screen.getByText(/ground Piloti’s answers/i)).toBeDefined()
  })

  it('shows the drop overlay on dragover of a supported file', () => {
    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    const dropzone = screen.getByTestId('workspace-dropzone')
    const dataTransfer = makeDataTransfer([
      new File(['x'], 'plan.pdf', { type: 'application/pdf' }),
    ])

    fireEvent.dragEnter(dropzone, { dataTransfer })

    expect(screen.getByTestId('workspace-drop-overlay')).toBeInTheDocument()
    expect(screen.getByText(/drop files to upload/i)).toBeInTheDocument()
  })

  it('routes a dropped file into the existing upload path (uploadFiles)', () => {
    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    const dropzone = screen.getByTestId('workspace-dropzone')
    const file = new File(['x'], 'plan.pdf', { type: 'application/pdf' })
    const dataTransfer = makeDataTransfer([file])

    fireEvent.dragEnter(dropzone, { dataTransfer })
    fireEvent.drop(dropzone, { dataTransfer })

    expect(mockUploadFiles).toHaveBeenCalledTimes(1)
    expect(mockUploadFiles).toHaveBeenCalledWith([file])
    // Overlay clears after drop.
    expect(screen.queryByTestId('workspace-drop-overlay')).not.toBeInTheDocument()
  })

  it('flags an unsupported drag but still defers rejection to uploadFiles, like the button', () => {
    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    const dropzone = screen.getByTestId('workspace-dropzone')
    const badFile = new File(['x'], 'photo.png', { type: 'image/png' })
    const dataTransfer = makeDataTransfer([badFile])

    fireEvent.dragEnter(dropzone, { dataTransfer })
    // Unsupported affordance is shown during drag.
    expect(screen.getByText(/not a supported type/i)).toBeInTheDocument()

    fireEvent.drop(dropzone, { dataTransfer })
    // Same contract as the button: files still flow to uploadFiles, which validates.
    expect(mockUploadFiles).toHaveBeenCalledWith([badFile])
  })
})

describe('ProjectFileWorkspace — mobile preview overlay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', () =>
        HttpResponse.json({
          documents: [
            {
              id: 'doc-1',
              filename: 'notes.txt',
              fileSize: 128,
              contentType: 'text/plain',
              status: 'ready',
              folderId: null,
              createdAt: '2026-01-01T00:00:00Z',
              errorMessage: null,
            },
          ],
        })
      )
    )
  })

  it('renders the preview as a labelled modal dialog and closes on Escape', async () => {
    render(
      <ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />
    )

    // Open the preview by selecting the loaded file.
    const fileRow = await screen.findByRole('button', { name: /notes\.txt/i })
    fireEvent.click(fileRow)

    // Dialog semantics with an accessible name. Asserted by NAME rather than by
    // `aria-label`: the shell is Radix now, which labels the content via
    // `aria-labelledby` pointing at a visually-hidden DialogTitle. Querying the
    // computed accessible name tests what a screen reader announces instead of
    // pinning the attribute the implementation happens to use.
    const dialog = await screen.findByRole('dialog', { name: /File preview: notes\.txt/i })
    expect(dialog).toBeInTheDocument()

    // Escape closes it. Radix listens on the content, not on document.
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('ProjectFileWorkspace — saved tags survive reselect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', () =>
        HttpResponse.json({
          documents: [
            {
              id: 'doc-a',
              filename: 'alpha.txt',
              fileSize: 128,
              contentType: 'text/plain',
              status: 'ready',
              folderId: null,
              createdAt: '2026-01-01T00:00:00Z',
              errorMessage: null,
              tags: ['Grundriss'],
            },
            {
              id: 'doc-b',
              filename: 'beta.txt',
              fileSize: 256,
              contentType: 'text/plain',
              status: 'ready',
              folderId: null,
              createdAt: '2026-01-02T00:00:00Z',
              errorMessage: null,
              tags: [],
            },
          ],
        })
      ),
      http.patch('/api/documents/:id/tags', () => HttpResponse.json({}))
    )
  })

  it('shows the newly saved tag after switching away and back to the file', async () => {
    const user = userEvent.setup()
    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)

    // Open doc-a and add a discipline tag via the inline add-tag input.
    fireEvent.click(await screen.findByRole('button', { name: /alpha\.txt/i }))
    await user.type(await screen.findByRole('textbox', { name: /add tag/i }), 'Brandschutz{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove tag Brandschutz' })).toBeDefined()
    )

    // Switch to doc-b (the pane re-seeds from the newly selected file's tags)...
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(await screen.findByRole('button', { name: /beta\.txt/i }))
    await screen.findByRole('dialog')

    // ...then back to doc-a: the saved tag must still be there (parent state
    // was updated on save), not reverted to the pre-edit ['Grundriss'].
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(await screen.findByRole('button', { name: /alpha\.txt/i }))
    await screen.findByRole('dialog')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove tag Brandschutz' })).toBeDefined()
    )
    expect(screen.getByRole('button', { name: 'Remove tag Grundriss' })).toBeDefined()
  })
})

/**
 * A file that is still being read has to stop being one on screen.
 *
 * The list was fetched once and never again, so a document that finished
 * indexing after the page loaded kept its "processing" badge until a reload —
 * and an `.ifc` never gets a second chance from the upload path at all, because
 * extraction is detached and has no ingest job for the orchestrator to poll.
 */
describe('ProjectFileWorkspace — a settling document settles on screen', () => {
  /** How many times the corpus has been asked for, across the poll. */
  let documentCalls = 0

  /** The list, served with whatever status the test has moved it to. */
  const corpus = (status: string, filename = 'Haus-A.ifc') =>
    HttpResponse.json({
      documents: [
        {
          id: 'doc-ifc',
          filename,
          fileSize: 148_900_000,
          contentType: 'application/octet-stream',
          status,
          folderId: null,
          createdAt: '2026-01-01T00:00:00Z',
          errorMessage: null,
        },
      ],
    })

  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    documentCalls = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-asks while a model is being read, and stops once it is', async () => {
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', () => {
        documentCalls += 1
        // Still extracting on the first read; done by the time the poll fires.
        return corpus(documentCalls === 1 ? 'processing' : 'ready')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    await waitFor(() => expect(documentCalls).toBe(1))

    await vi.advanceTimersByTimeAsync(4_100)
    await waitFor(() => expect(documentCalls).toBe(2))

    // Everything is terminal now, so the polling stops rather than asking
    // forever about a corpus that cannot change on its own.
    const settled = documentCalls
    await vi.advanceTimersByTimeAsync(12_000)
    expect(documentCalls).toBe(settled)
  })

  it('keeps at most one poll in flight, however slow the endpoint is', async () => {
    // `setInterval` fired again whether or not the previous refresh had come
    // back, so a slow endpoint accumulated requests and let an older response
    // land after a newer one — overwriting a document that had just finished
    // with its earlier "still reading" row.
    let inFlight = 0
    let peak = 0
    const gate: { release: (() => void) | null } = { release: null }
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', async () => {
        documentCalls += 1
        inFlight += 1
        peak = Math.max(peak, inFlight)
        // The first response returns at once; every poll after it hangs until
        // this test lets it go.
        if (documentCalls > 1) await new Promise<void>((resolve) => (gate.release = resolve))
        inFlight -= 1
        return corpus('processing')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    await waitFor(() => expect(documentCalls).toBe(1))

    // Three poll windows pass while the second request is still hanging.
    await vi.advanceTimersByTimeAsync(13_000)
    expect(documentCalls).toBe(2)
    expect(peak).toBe(1)

    gate.release?.()
  })

  it('tells the user what became possible — a building is asked, not cited', async () => {
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', () => {
        documentCalls += 1
        return corpus(documentCalls === 1 ? 'processing' : 'ready')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    await waitFor(() => expect(documentCalls).toBe(1))
    await vi.advanceTimersByTimeAsync(4_100)

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/you can now ask about the building/i),
        expect.anything()
      )
    )
  })

  it('keeps the ordinary wording for an ordinary document', async () => {
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', () => {
        documentCalls += 1
        return corpus(documentCalls === 1 ? 'processing' : 'ready', 'Bescheid.pdf')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    await waitFor(() => expect(documentCalls).toBe(1))
    await vi.advanceTimersByTimeAsync(4_100)

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/citable/i),
        expect.anything()
      )
    )
  })
})

/**
 * A model is a file, and the file grid is where it opens.
 *
 * The `/model` page is gone. What replaced it is this: an `.ifc` in the grid
 * opens the building full screen, and every other file opens the preview
 * dialog exactly as before. The branch is the whole integration.
 */
describe('ProjectFileWorkspace — an .ifc opens as a building', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', () =>
        HttpResponse.json({
          documents: [
            {
              id: 'doc-model',
              filename: 'Haus-A.ifc',
              fileSize: 149_000_000,
              contentType: 'application/octet-stream',
              status: 'ready',
              folderId: null,
              createdAt: '2026-01-01T00:00:00Z',
              errorMessage: null,
            },
            {
              id: 'doc-pdf',
              filename: 'Einreichplan.pdf',
              fileSize: 2048,
              contentType: 'application/pdf',
              status: 'ready',
              folderId: null,
              createdAt: '2026-01-02T00:00:00Z',
              errorMessage: null,
            },
          ],
        })
      )
    )
  })

  it('puts the model in the URL rather than opening the file preview', async () => {
    render(
      <ProjectFileWorkspace
        projectId="proj-1"
        projectName="Test"
        collectionName="test-coll"
        showModels
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /Haus-A\.ifc/i }))

    // The name, not the id: `?model=` is resolved by file name so the link
    // survives a re-ingestion and stays readable in a chat message.
    const href = routerReplace.mock.calls.at(-1)?.[0] as string
    expect(new URLSearchParams(href.split('?')[1]).get('model')).toBe('Haus-A.ifc')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('leaves every other file opening the preview dialog', async () => {
    render(
      <ProjectFileWorkspace
        projectId="proj-1"
        projectName="Test"
        collectionName="test-coll"
        showModels
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: /Einreichplan\.pdf/i }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('falls back to the ordinary preview when the org has no IFC feature', async () => {
    // A viewer whose endpoints would answer 403 is worse than no viewer: the
    // reader gets a full-screen surface that cannot load, instead of the file
    // dialog that works.
    render(
      <ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />
    )
    fireEvent.click(await screen.findByRole('button', { name: /Haus-A\.ifc/i }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(routerReplace).not.toHaveBeenCalled()
  })
})
