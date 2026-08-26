import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { type ReactElement, type ReactNode } from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { ProjectFileWorkspace } from './project-file-workspace'
import { FilePreviewHost } from './file-preview-host'
import { useFilePreviewStore } from '../stores/file-preview-store'
import { useProjectDocuments } from '../hooks/use-project-documents'

function renderWorkspace(ui: ReactElement) {
  return render(
    <>
      {ui}
      <FilePreviewHost />
    </>,
  )
}

/** The file card/row — not the overflow trigger that also names the file. */
function findFileButton(name: RegExp) {
  return screen.findByRole('button', {
    name: (accessibleName) => name.test(accessibleName) && !/file actions/i.test(accessibleName),
  })
}

function resetPreviewStore() {
  useFilePreviewStore.setState({
    file: null,
    mode: 'modal',
    hidden: false,
    peekWidth: 320,
    context: {},
  })
}

const mockUploadFiles = vi.fn()

/**
 * The workspace reads the URL now: `?model=` is what turns Dateien into the
 * model viewer, so the page needs a router the way every other URL-backed
 * surface in the app does.
 */
const routerReplace = vi.fn()
/** Opening the stage PUSHES, so the back button closes it. */
const routerPush = vi.fn()
let searchParams = new URLSearchParams()
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: (...args: unknown[]) => routerPush(...args),
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

vi.mock('@/features/bim/components/ifc-file-preview', () => ({
  IfcFilePreview: () => <div data-testid="ifc-file-preview" />,
}))

vi.mock('@/features/knowledge/components/pdf-viewer-dialog', () => ({
  PdfViewerDialog: () => null,
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

// The real portal lands in the layout header; unit tests have no slot.
vi.mock('@/components/shell/project-section-frame', () => ({
  ProjectSectionActions: ({ children }: { children: ReactNode }) => children,
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
    resetPreviewStore()
  })

  it('renders the file workspace with view controls and upload', () => {
    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    expect(screen.getByRole('radiogroup', { name: 'View' })).toBeDefined()
    expect(screen.getByTestId('project-upload-input')).toBeDefined()
    expect(screen.queryByRole('heading', { name: 'Test' })).toBeNull()
  })

  it('shows the drop overlay on dragover of a supported file', () => {
    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    const dropzone = screen.getByTestId('workspace-dropzone')
    const dataTransfer = makeDataTransfer([
      new File(['x'], 'plan.pdf', { type: 'application/pdf' }),
    ])

    fireEvent.dragEnter(dropzone, { dataTransfer })

    expect(screen.getByTestId('workspace-drop-overlay')).toBeInTheDocument()
    expect(screen.getByText(/drop files to upload/i)).toBeInTheDocument()
  })

  it('routes a dropped file into the existing upload path (uploadFiles)', () => {
    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
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
    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
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
      ),
      http.get('/api/documents/:id/preview', () => HttpResponse.json({ url: null })),
    )
  })

  it('renders the preview as a labelled modal dialog and closes on Escape', async () => {
    renderWorkspace(
      <ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />
    )

    // Open the preview by selecting the loaded file.
    const fileRow = await findFileButton(/notes\.txt/i)
    fireEvent.click(fileRow)

    // Dialog semantics with an accessible name. Asserted by NAME rather than by
    // `aria-label`: the shell is Radix now, which labels the content via
    // `aria-labelledby` pointing at a visually-hidden DialogTitle. Querying the
    // computed accessible name tests what a screen reader announces instead of
    // pinning the attribute the implementation happens to use.
    const dialog = await screen.findByRole('dialog', { name: /File preview: notes\.txt/i })
    expect(dialog).toBeInTheDocument()

    // Escape closes it. The host listens on document (not Radix content).
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})

describe('ProjectFileWorkspace — saved tags survive reselect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    resetPreviewStore()
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
      http.patch('/api/documents/:id/tags', () => HttpResponse.json({})),
      http.get('/api/documents/:id/preview', () => HttpResponse.json({ url: null })),
    )
  })

  it('shows the newly saved tag after switching away and back to the file', async () => {
    const user = userEvent.setup()
    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)

    // Open doc-a and add a discipline tag via the inline add-tag input.
    fireEvent.click(await findFileButton(/alpha\.txt/i))
    await user.type(await screen.findByRole('textbox', { name: /add tag/i }), 'Brandschutz{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove tag Brandschutz' })).toBeDefined()
    )

    // Switch to doc-b (the pane re-seeds from the newly selected file's tags)...
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(await findFileButton(/beta\.txt/i))
    await screen.findByRole('dialog')

    // ...then back to doc-a: the saved tag must still be there (parent state
    // was updated on save), not reverted to the pre-edit ['Grundriss'].
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    fireEvent.click(await findFileButton(/alpha\.txt/i))
    await screen.findByRole('dialog')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove tag Brandschutz' })).toBeDefined()
    )
    expect(screen.getByRole('button', { name: 'Remove tag Grundriss' })).toBeDefined()
  })
})

describe('ProjectFileWorkspace — renaming and deleting a document', () => {
  const document = {
    id: 'doc-a',
    filename: 'alpha.pdf',
    fileSize: 128,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-01-01T00:00:00Z',
    errorMessage: null,
    tags: [],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    resetPreviewStore()
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', () => HttpResponse.json({ documents: [document] })),
      http.get('/api/documents/:id/preview', () => HttpResponse.json({ url: null })),
    )
  })

  it('renames from the preview and shows the new name on the card behind it', async () => {
    server.use(
      http.patch('/api/documents/:id', async ({ request }) => {
        const body = (await request.json()) as { displayName: string | null }
        return HttpResponse.json({ id: 'doc-a', filename: 'alpha.pdf', ...body })
      })
    )
    const user = userEvent.setup()
    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)

    fireEvent.click(await findFileButton(/alpha\.pdf/i))
    const renameDialog = await screen.findByRole('dialog')
    await user.click(within(renameDialog).getByTestId('document-actions-trigger'))
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }))

    const field = await screen.findByLabelText('Name')
    await user.clear(field)
    await user.type(field, 'Einreichplan EG')
    await user.click(screen.getByTestId('rename-submit'))

    // The dialog closes and the corpus behind it carries the new name — no
    // refetch, no stale card under the modal.
    await waitFor(() => expect(screen.queryByLabelText('Name')).not.toBeInTheDocument())
    expect((await screen.findAllByText('Einreichplan EG.pdf')).length).toBeGreaterThan(0)
  })

  it('deletes through the project route and drops the card', async () => {
    const deleted: string[] = []
    server.use(
      http.delete('/api/documents/:id', ({ params }) => {
        deleted.push(String(params.id))
        return new HttpResponse(null, { status: 204 })
      })
    )
    const user = userEvent.setup()
    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)

    fireEvent.click(await findFileButton(/alpha\.pdf/i))
    const deleteDialog = await screen.findByRole('dialog')
    await user.click(within(deleteDialog).getByTestId('document-actions-trigger'))
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }))
    await user.click(await screen.findByTestId('document-delete-confirm'))

    await waitFor(() => expect(deleted).toEqual(['doc-a']))
    await waitFor(() => expect(screen.queryByText('alpha.pdf')).not.toBeInTheDocument())
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
    resetPreviewStore()
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

    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
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

    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
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

    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
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

    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
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
 * A late answer must never overwrite a newer one.
 *
 * `useSettlingRefresh` serialises its OWN polls, so at most one poll is in
 * flight — but nothing coordinated that poll with a FOREGROUND load (mount,
 * upload settled, `onComplete`, retry). A slow poll carrying `processing` could
 * land after a newer foreground load had already brought back `ready`, putting
 * the "Wird gelesen…" badge back on a document the user had just been told was
 * citable — and, because the row read as unsettled again, restarting the poll
 * that was supposed to have stopped. The Archiv workspace carries the twin of
 * this test over its own loader.
 */
describe('ProjectFileWorkspace — only the newest answer may win', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    resetPreviewStore()
  })

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
          folderId: null,
          createdAt: '2026-01-01T00:00:00Z',
          errorMessage: null,
        },
      ],
    })

  /**
   * Let the released response travel msw → fetch → React, WITHOUT letting the
   * 4 s settling poll fire. If a stale answer regressed the badge, a restarted
   * poll would immediately fetch the real `ready` again and heal it — the test
   * would then pass while the user still saw the flicker. Well under one poll
   * interval of fake time, spent in many small awaits, is what separates the
   * two.
   */
  const flushWithoutPolling = async () => {
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(50)
  }

  it('ignores a poll response that resolves after a newer foreground load', async () => {
    let documentCalls = 0
    const gate: { release: (() => void) | null } = { release: null }
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', async () => {
        documentCalls += 1
        const call = documentCalls
        // The POLL (call 2) is held open until a newer foreground load (call 3)
        // has already answered `ready`, then answers the stale `processing`.
        if (call === 2) {
          await new Promise<void>((resolve) => (gate.release = resolve))
          return corpus('processing')
        }
        return corpus(call === 1 ? 'processing' : 'ready')
      })
    )
    vi.useFakeTimers({ shouldAdvanceTime: true })

    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    expect(await screen.findByText('Processing')).toBeInTheDocument()

    // The settling poll goes out and hangs.
    await vi.advanceTimersByTimeAsync(4_100)
    await waitFor(() => expect(documentCalls).toBe(2))

    // Meanwhile the upload orchestrator finishes and asks for the corpus again —
    // a foreground load, uncoordinated with the poll already in flight.
    const onComplete = vi.mocked(useProjectDocuments).mock.calls.at(-1)?.[0]?.onComplete
    expect(onComplete).toBeTypeOf('function')
    onComplete?.()
    await waitFor(() => expect(documentCalls).toBe(3))
    await waitFor(() => expect(screen.getByText('Citable')).toBeInTheDocument())

    // Now the stale poll answers. It is older than what is on screen, so it
    // must not commit.
    gate.release?.()
    await flushWithoutPolling()

    expect(screen.getByText('Citable')).toBeInTheDocument()
    expect(screen.queryByText('Processing')).not.toBeInTheDocument()

    // …and it must not resurrect the poll either: the corpus is terminal, so
    // nothing more is asked for.
    await vi.advanceTimersByTimeAsync(8_000)
    expect(documentCalls).toBe(3)
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
    resetPreviewStore()
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
      ),
      http.get('/api/documents/:id/preview', () => HttpResponse.json({ url: null })),
    )
  })

  it('puts the model in the URL rather than opening the file preview', async () => {
    renderWorkspace(
      <ProjectFileWorkspace
        projectId="proj-1"
        projectName="Test"
        collectionName="test-coll"
        showModels
      />
    )
    fireEvent.click(await findFileButton(/Haus-A\.ifc/i))

    // The name, not the id: `?model=` is resolved by file name so the link
    // survives a re-ingestion and stays readable in a chat message.
    //
    // And PUSHED, not replaced: with `replace` the stage added no history
    // entry, so the back button left the Files page entirely — discarding the
    // camera, the cut, the selection, the hidden set and every measurement.
    // On a phone, back is how anyone dismisses a full-screen overlay.
    const href = routerPush.mock.calls.at(-1)?.[0] as string
    expect(new URLSearchParams(href.split('?')[1]).get('model')).toBe('Haus-A.ifc')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('leaves every other file opening the preview dialog', async () => {
    renderWorkspace(
      <ProjectFileWorkspace
        projectId="proj-1"
        projectName="Test"
        collectionName="test-coll"
        showModels
      />
    )
    fireEvent.click(await findFileButton(/Einreichplan\.pdf/i))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('falls back to the ordinary preview when the org has no IFC feature', async () => {
    // A viewer whose endpoints would answer 403 is worse than no viewer: the
    // reader gets a full-screen surface that cannot load, instead of the file
    // dialog that works.
    renderWorkspace(
      <ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />
    )
    fireEvent.click(await findFileButton(/Haus-A\.ifc/i))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(routerReplace).not.toHaveBeenCalled()
  })
})

describe('ProjectFileWorkspace — the Von Piloti filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    resetPreviewStore()
  })

  it('asks the LISTING for agent-authored rows rather than filtering what it already has', async () => {
    // Authorship is a column with a partial index and the listing is capped at
    // 500 rows: filtering client-side would quietly miss a report that fell off
    // the end of a large corpus, which is the one thing this chip exists to
    // find. So the chip is a query parameter, and the listing is re-read.
    const searches: string[] = []
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', ({ request }) => {
        searches.push(new URL(request.url).search)
        return HttpResponse.json({ documents: [] })
      }),
    )

    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)

    await waitFor(() => expect(searches.length).toBeGreaterThan(0))
    expect(searches[0]).not.toContain('authoredBy')

    await userEvent.click(screen.getByTestId('filter-agent-authored'))

    await waitFor(() => expect(searches.at(-1)).toContain('authoredBy=agent'))
    expect(searches.at(-1)).toContain('projectId=proj-1')
  })

  it('goes back to the whole estate when the chip is released', async () => {
    const searches: string[] = []
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', ({ request }) => {
        searches.push(new URL(request.url).search)
        return HttpResponse.json({ documents: [] })
      }),
    )

    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    await waitFor(() => expect(searches.length).toBeGreaterThan(0))

    const chip = screen.getByTestId('filter-agent-authored')
    await userEvent.click(chip)
    await waitFor(() => expect(searches.at(-1)).toContain('authoredBy=agent'))
    await userEvent.click(chip)

    // Unfiltered is not the same as `authoredBy=user`: the default listing is
    // the whole project's estate, both hands.
    await waitFor(() => expect(searches.at(-1)).not.toContain('authoredBy'))
  })
})
