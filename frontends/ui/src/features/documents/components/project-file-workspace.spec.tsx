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
import type { DocumentWireRow } from '../lib/file-item'

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
/** A failure that stops an upload is an assertion too — see the folder plan. */
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
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

  it('routes a dropped file into the existing upload path (uploadFiles)', async () => {
    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    const dropzone = screen.getByTestId('workspace-dropzone')
    const file = new File(['x'], 'plan.pdf', { type: 'application/pdf' })
    const dataTransfer = makeDataTransfer([file])

    fireEvent.dragEnter(dropzone, { dataTransfer })
    fireEvent.drop(dropzone, { dataTransfer })

    // The drop path resolves a microtask later: a DROPPED FOLDER is invisible
    // to `dataTransfer.files` and has to be walked through the entries API, so
    // the handler captures entries synchronously and hands over the files
    // afterwards. A plain file drop still ends in exactly this call.
    await waitFor(() => expect(mockUploadFiles).toHaveBeenCalledTimes(1))
    expect(mockUploadFiles).toHaveBeenCalledWith([file])
    // Overlay clears after drop.
    expect(screen.queryByTestId('workspace-drop-overlay')).not.toBeInTheDocument()
  })

  it('flags an unsupported drag but still defers rejection to uploadFiles, like the button', async () => {
    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    const dropzone = screen.getByTestId('workspace-dropzone')
    const badFile = new File(['x'], 'photo.png', { type: 'image/png' })
    const dataTransfer = makeDataTransfer([badFile])

    fireEvent.dragEnter(dropzone, { dataTransfer })
    // Unsupported affordance is shown during drag.
    expect(screen.getByText(/not a supported type/i)).toBeInTheDocument()

    fireEvent.drop(dropzone, { dataTransfer })
    // Same contract as the button: files still flow to uploadFiles, which validates.
    await waitFor(() => expect(mockUploadFiles).toHaveBeenCalledWith([badFile]))
  })
})

/**
 * A FOLDER IS NOT A LONGER LIST OF FILES.
 *
 * It used to be treated as one: every file landed in whichever folder the
 * reader stood in, the tree survived only as a string on the row, and two files
 * of the same name inside one drop both uploaded — one silently overwriting the
 * other, because a project holds one document per filename (0074). These pin
 * the plan that replaced that: what it says, what the reader decides, and where
 * the files actually go.
 */
describe('ProjectFileWorkspace — a dropped folder', () => {
  const existing: DocumentWireRow = {
    id: 'doc-eg',
    filename: 'EG.pdf',
    displayName: null,
    fileSize: 10,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-06-14T09:00:00.000Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    assignees: [],
    authoredBy: 'user' as const,
  }

  /** A `File` carrying the path a folder input reports. */
  function pathed(relativePath: string, size = 10): File {
    const name = relativePath.split('/').pop()!
    const file = new File(['x'.repeat(size)], name, { type: 'application/pdf' })
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true })
    return file
  }

  let ensureRequests: Array<{ parentId: string | null; paths: string[] }>
  let moveRequests: Array<{ documentId: string; folderId: string | null }>

  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    resetPreviewStore()
    ensureRequests = []
    moveRequests = []
    server.use(
      http.get('/api/documents', () => HttpResponse.json({ documents: [] })),
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.post('/api/projects/:projectId/folders/ensure', async ({ request }) => {
        const body = (await request.json()) as { parentId: string | null; paths: string[] }
        ensureRequests.push(body)
        return HttpResponse.json({
          folders: [],
          folderIdByPath: Object.fromEntries(body.paths.map((path) => [path, `folder-for-${path}`])),
        })
      }),
      http.patch('/api/documents/:id/folder', async ({ params, request }) => {
        const body = (await request.json()) as { folderId: string | null }
        moveRequests.push({ documentId: String(params.id), folderId: body.folderId })
        return HttpResponse.json({ id: params.id })
      }),
    )
  })

  // `clearMocks` does not undo a stubbed global, and one test replaces `crypto`
  // to give happy-dom the `subtle.digest` it does not ship.
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderWithCorpus(
    files: DocumentWireRow[] = [existing],
    folders: Array<{ id: string; parentId: string | null; name: string; path: string }> = [],
  ) {
    return renderWorkspace(
      <ProjectFileWorkspace
        projectId="proj-1"
        projectName="Test"
        collectionName="test-coll"
        initialFiles={files}
        initialFolders={folders}
      />,
    )
  }

  async function dropFolder(files: File[]) {
    const input = screen.getByTestId('project-upload-folder-input') as HTMLInputElement
    // `userEvent.upload` rebuilds the FileList and would drop the paths we just
    // stamped, which are the only thing that makes this a folder at all.
    Object.defineProperty(input, 'files', { value: files, configurable: true })
    fireEvent.change(input)
    return screen.findByTestId('folder-upload-dialog')
  }

  it('asks before it touches anything, and says what it is about to do', async () => {
    renderWithCorpus()
    await dropFolder([pathed('Wohnbau/Plaene/EG.pdf'), pathed('Wohnbau/Plaene/OG.pdf')])

    // Nothing has been uploaded on the strength of the gesture alone.
    expect(mockUploadFiles).not.toHaveBeenCalled()

    const dialog = await screen.findByTestId('folder-upload-dialog')
    // One file is new; the other already exists under that name, project-wide,
    // which is the rule the server enforces.
    expect(within(dialog).getByTestId('folder-upload-count-new')).toHaveTextContent('1')
    expect(within(dialog).getByTestId('folder-upload-count-update')).toHaveTextContent('1')
    // Two folders in the tree, neither of which exists here yet.
    expect(within(dialog).getByTestId('folder-upload-count-folders')).toHaveTextContent('2')
  })

  it('creates the tree and files each document into its own folder', async () => {
    renderWithCorpus()
    await dropFolder([pathed('Wohnbau/Plaene/EG.pdf'), pathed('Wohnbau/Statik/Bericht.pdf')])

    await userEvent.click(await screen.findByTestId('folder-upload-confirm'))

    await waitFor(() => expect(ensureRequests).toHaveLength(1))
    expect(ensureRequests[0]).toEqual({
      parentId: null,
      paths: ['Wohnbau', 'Wohnbau/Plaene', 'Wohnbau/Statik'],
    })

    await waitFor(() => expect(mockUploadFiles).toHaveBeenCalledTimes(1))
    const [sent, options] = mockUploadFiles.mock.calls[0] as [
      File[],
      { folderIdFor: (file: File) => string | null },
    ]
    expect(sent.map((file) => file.name).sort()).toEqual(['Bericht.pdf', 'EG.pdf'])
    // The whole point: two files from one drop, two different folders.
    const targets = sent.map((file) => options.folderIdFor(file))
    expect(new Set(targets)).toEqual(
      new Set(['folder-for-Wohnbau/Plaene', 'folder-for-Wohnbau/Statik']),
    )
  })

  it('leaves the existing documents alone when the reader unticks the update', async () => {
    renderWithCorpus()
    await dropFolder([pathed('Wohnbau/EG.pdf'), pathed('Wohnbau/New.pdf')])

    const toggle = await screen.findByTestId('folder-upload-include-updates')
    await userEvent.click(within(toggle).getByRole('checkbox'))
    await userEvent.click(screen.getByTestId('folder-upload-confirm'))

    await waitFor(() => expect(mockUploadFiles).toHaveBeenCalledTimes(1))
    const [sent] = mockUploadFiles.mock.calls[0] as [File[]]
    expect(sent.map((file) => file.name)).toEqual(['New.pdf'])
  })

  it('sends neither of two files that share a name inside one drop', async () => {
    renderWithCorpus()
    await dropFolder([pathed('W/A/Deckblatt.pdf'), pathed('W/B/Deckblatt.pdf')])

    const dialog = await screen.findByTestId('folder-upload-dialog')
    // Before this, both uploaded and one overwrote the other with nothing said.
    expect(within(dialog).getByTestId('folder-upload-collisions')).toBeInTheDocument()
    expect(screen.getByTestId('folder-upload-confirm')).toBeDisabled()
  })

  it('uploads nothing when the folders could not be created', async () => {
    server.use(
      http.post('/api/projects/:projectId/folders/ensure', () =>
        HttpResponse.json({ error: 'nope' }, { status: 500 }),
      ),
    )
    renderWithCorpus()
    await dropFolder([pathed('Wohnbau/New.pdf')])

    await userEvent.click(await screen.findByTestId('folder-upload-confirm'))

    // A half-applied plan is the state that is hardest to reason about
    // afterwards; the whole thing is repeatable instead.
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(mockUploadFiles).not.toHaveBeenCalled()
  })

  /*
   * THE RE-SYNC, which is what this feature is for.
   *
   * A büro drops the project directory again. Every file in it is already here
   * and unchanged, and one document has since been reorganised in Piloti. There
   * is nothing to upload — and the dialog's own promise, that the folder
   * structure is recreated, is false unless that one document moves.
   */
  it('moves an unchanged document the tree files somewhere else, without uploading', async () => {
    const digest = `sha256:${'a'.repeat(64)}`
    renderWithCorpus(
      [{ ...existing, contentHash: digest, folderId: null }],
      [{ id: 'folder-plaene', parentId: null, name: 'Plaene', path: 'Plaene' }],
    )
    // The planner hashes the plausible duplicates in the browser to find out
    // that they are identical. happy-dom ships no `crypto.subtle`, so it is
    // supplied here — 32 bytes of 0xaa, which is the digest above in hex.
    vi.stubGlobal('crypto', {
      ...globalThis.crypto,
      subtle: { digest: async () => new Uint8Array(32).fill(0xaa).buffer },
    })

    await dropFolder([pathed('Plaene/EG.pdf')])

    // Not an upload, and not "nothing to do" either.
    const confirm = await screen.findByTestId('folder-upload-confirm')
    await waitFor(() => expect(confirm).toBeEnabled())
    await userEvent.click(confirm)

    await waitFor(() => expect(moveRequests).toHaveLength(1))
    // Resolved through the ensure response, exactly as the uploads are — the
    // folder a document moves into may have been created a moment ago.
    expect(moveRequests[0]).toEqual({ documentId: 'doc-eg', folderId: 'folder-for-Plaene' })
  })

  it('still takes a handful of picked files straight to the upload path', async () => {
    renderWithCorpus()
    const input = screen.getByTestId('project-upload-input') as HTMLInputElement
    const file = new File(['x'], 'plan.pdf', { type: 'application/pdf' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)

    await waitFor(() => expect(mockUploadFiles).toHaveBeenCalledWith([file]))
    expect(screen.queryByTestId('folder-upload-dialog')).not.toBeInTheDocument()
  })
})

/**
 * The listing the SERVER already read.
 *
 * Dateien used to paint a skeleton, boot its bundle and only then ask for the
 * folders and the documents — three round trips stacked behind the JavaScript,
 * on a page whose whole job is to show a list the page request could already
 * have had. The page reads both now and hands them down; what these pin is that
 * the seed is a first paint and not a second source of truth: the corpus is on
 * screen in the first frame, and nothing goes back out to fetch what it was
 * just given.
 */
describe('ProjectFileWorkspace — server-seeded first paint', () => {
  const seededFile = {
    id: 'doc-seed',
    filename: 'Einreichplan.pdf',
    displayName: null,
    fileSize: 2048,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-06-14T09:00:00.000Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
    assignees: [],
    authoredBy: 'user' as const,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    resetPreviewStore()
  })

  it('renders the seeded corpus without asking for it again', async () => {
    const documentsRequests: string[] = []
    const folderRequests: string[] = []
    server.use(
      http.get('/api/documents', ({ request }) => {
        documentsRequests.push(request.url)
        return HttpResponse.json({ documents: [] })
      }),
      http.get('/api/projects/:projectId/folders', ({ request }) => {
        folderRequests.push(request.url)
        return HttpResponse.json({ folders: [] })
      }),
    )

    renderWorkspace(
      <ProjectFileWorkspace
        projectId="proj-1"
        projectName="Test"
        collectionName="test-coll"
        initialFiles={[seededFile]}
        initialFolders={[{ id: 'folder-1', parentId: null, name: 'Brandschutz', path: 'Brandschutz' }]}
      />,
    )

    // The file and the folder are there to be found immediately — no skeleton
    // frame to wait through, which is the whole point of the seed.
    expect(await findFileButton(/Einreichplan\.pdf/)).toBeInTheDocument()
    expect(screen.getByTestId('folder-card-folder-1')).toBeInTheDocument()
    expect(screen.queryByTestId('file-browser-skeleton')).not.toBeInTheDocument()

    // And neither listing is re-requested on mount. A refetch here would be
    // invisible on a fast connection and would still cost every reader two
    // round trips for an answer they can already see.
    await waitFor(() => expect(mockUploadFiles).not.toHaveBeenCalled())
    expect(documentsRequests).toHaveLength(0)
    expect(folderRequests).toHaveLength(0)
  })

  it('still fetches when the caller has nothing to seed with', async () => {
    let documentsRequests = 0
    server.use(
      http.get('/api/documents', () => {
        documentsRequests += 1
        return HttpResponse.json({ documents: [seededFile] })
      }),
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
    )

    renderWorkspace(
      <ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />,
    )

    expect(await findFileButton(/Einreichplan\.pdf/)).toBeInTheDocument()
    expect(documentsRequests).toBe(1)
  })

  it('re-reads the listing when the „Von Piloti" chip narrows it server-side', async () => {
    const requested: string[] = []
    server.use(
      http.get('/api/documents', ({ request }) => {
        requested.push(new URL(request.url).searchParams.get('authoredBy') ?? '')
        return HttpResponse.json({ documents: [] })
      }),
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
    )

    renderWorkspace(
      <ProjectFileWorkspace
        projectId="proj-1"
        projectName="Test"
        collectionName="test-coll"
        initialFiles={[seededFile]}
        initialFolders={[]}
      />,
    )
    expect(await findFileButton(/Einreichplan\.pdf/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /filter/i }))
    await userEvent.click(await screen.findByLabelText('By Piloti'))

    // The seed is spent by the mount, not by the component's lifetime: a filter
    // that only the server can apply must still reach it.
    await waitFor(() => expect(requested).toEqual(['agent']))
  })
})

/**
 * „Bisher keine Möglichkeit, Dateien per Drag & Drop in Ordner zu verschieben."
 *
 * The move itself already existed — `PATCH /api/documents/[id]/folder`, offered
 * as „Verschieben" in the overflow menu — so what was missing was the gesture
 * people try first, and whose absence reads as the capability being absent.
 *
 * The hazard is that this workspace ALREADY listens for drags: dropping files
 * from the desktop is how you upload. The two must not be confused, and the
 * discriminator is a fact the browser guarantees rather than a flag we set —
 * `dataTransfer.types` contains `Files` only for a drag carrying real files.
 */
describe('ProjectFileWorkspace — dragging a file into a folder', () => {
  const dragTransfer = (documentId: string) => {
    const store: Record<string, string> = { 'application/x-grid-document-id': documentId }
    return {
      types: ['application/x-grid-document-id'],
      getData: (key: string) => store[key] ?? '',
      setData: (key: string, value: string) => {
        store[key] = value
      },
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    server.use(
      http.get('/api/projects/:projectId/folders', () =>
        HttpResponse.json({ folders: [{ id: 'folder-1', name: 'Brandschutz', parentId: null }] })
      ),
      http.get('/api/documents', () =>
        HttpResponse.json({
          documents: [
            {
              id: 'doc-1',
              filename: 'plan.pdf',
              displayName: null,
              fileSize: 1024,
              contentType: 'application/pdf',
              status: 'ready',
              folderId: null,
              createdAt: '2026-01-01T00:00:00Z',
              errorMessage: null,
              summary: null,
              pageCount: null,
              chunkCount: null,
              contentTypes: null,
              tags: null,
            },
          ],
        })
      ),
      http.patch('/api/documents/:id/folder', () => HttpResponse.json({ ok: true }))
    )
  })

  it('moves the file through the same endpoint the menu uses', async () => {
    const patched: Array<{ url: string; body: unknown }> = []
    server.use(
      http.patch('/api/documents/:id/folder', async ({ request, params }) => {
        patched.push({ url: String(params.id), body: await request.json() })
        return HttpResponse.json({ ok: true })
      })
    )

    renderWorkspace(
      <ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />
    )

    const folder = await screen.findByTestId('folder-card-folder-1')
    fireEvent.dragOver(folder, { dataTransfer: dragTransfer('doc-1') })
    fireEvent.drop(folder, { dataTransfer: dragTransfer('doc-1') })

    await waitFor(() => expect(patched).toHaveLength(1))
    expect(patched[0]).toMatchObject({ url: 'doc-1', body: { folderId: 'folder-1' } })
  })

  it('does not raise the upload overlay for a drag that started in the page', async () => {
    renderWorkspace(
      <ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />
    )

    const dropzone = screen.getByTestId('workspace-dropzone')
    // No `Files` in `types` — this drag carries a document id, not an upload.
    fireEvent.dragEnter(dropzone, { dataTransfer: dragTransfer('doc-1') })

    expect(screen.queryByTestId('workspace-drop-overlay')).not.toBeInTheDocument()
    expect(mockUploadFiles).not.toHaveBeenCalled()
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

  /**
   * This used to assert the opposite — a click went straight to the stage —
   * and that is what made the model the ONE file type with no preview, and
   * what made the same `.ifc` behave differently here and in the Archiv, which
   * had no stage to jump to.
   */
  it('opens the preview first, like every other file', async () => {
    renderWorkspace(
      <ProjectFileWorkspace
        projectId="proj-1"
        projectName="Test"
        collectionName="test-coll"
        showModels
      />
    )
    fireEvent.click(await findFileButton(/Haus-A\.ifc/i))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    // And the stage is NOT entered behind the reader's back.
    expect(
      routerPush.mock.calls.some((call) => String(call[0]).includes('model=Haus-A.ifc'))
    ).toBe(false)
  })

  /**
   * The flag exists so this can be flipped in production without a deploy, and
   * the Archiv reads the same one — an `.ifc` that behaves one way in a project
   * and another in the Archiv is the defect the whole change is about.
   */
  it('goes straight to the stage when preview-first is switched off', async () => {
    renderWorkspace(
      <ProjectFileWorkspace
        projectId="proj-1"
        projectName="Test"
        collectionName="test-coll"
        showModels
        previewFirst={false}
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

    // „Von Piloti" is inside the filter menu now, not an open chip in the
    // header. The rule it tests is unchanged: the filter is a QUERY, not a
    // client-side pass over rows already fetched.
    await userEvent.click(screen.getByTestId('file-filter-menu-trigger'))
    await userEvent.click(await screen.findByLabelText('By Piloti'))

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

    await userEvent.click(screen.getByTestId('file-filter-menu-trigger'))
    const check = await screen.findByLabelText('By Piloti')
    await userEvent.click(check)
    await waitFor(() => expect(searches.at(-1)).toContain('authoredBy=agent'))
    await userEvent.click(check)

    // Unfiltered is not the same as `authoredBy=user`: the default listing is
    // the whole project's estate, both hands.
    await waitFor(() => expect(searches.at(-1)).not.toContain('authoredBy'))
  })
})

/**
 * AN ACTIVE FILTER MUST NOT BLANK THE FILES IT MATCHED.
 *
 * `filterEmptyNotice` is rendered by `FileBrowserPane` before every other
 * branch, so the workspace may only hand one over when the level is actually
 * empty: the memo used to answer filter state alone, and turning on any filter
 * — even one matching everything on screen — replaced the whole listing with
 * the "filter emptied it" panel.
 */
describe('ProjectFileWorkspace — a filter keeps what it matches', () => {
  const DOCUMENTS = [
    {
      id: 'doc-photo',
      filename: 'foto.jpg',
      fileSize: 1024,
      contentType: 'image/jpeg',
      status: 'ready',
      folderId: null,
      createdAt: '2026-01-01T00:00:00Z',
      errorMessage: null,
    },
    {
      id: 'doc-report',
      filename: 'bericht.pdf',
      fileSize: 2048,
      contentType: 'application/pdf',
      status: 'ready',
      folderId: null,
      createdAt: '2026-01-02T00:00:00Z',
      errorMessage: null,
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    resetPreviewStore()
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: [] })),
      http.get('/api/documents', () => HttpResponse.json({ documents: DOCUMENTS })),
    )
  })

  const openMenu = async () => {
    await userEvent.click(screen.getByTestId('file-filter-menu-trigger'))
  }

  it('keeps listing the files a kind filter matches, instead of the empty-filter panel', async () => {
    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    await findFileButton(/foto\.jpg/i)
    await openMenu()
    await userEvent.click(await screen.findByLabelText('Photo'))

    // The filter applied (the PDF is a document, not a photo) — and what it
    // matched is still on screen rather than replaced by the notice.
    expect(await findFileButton(/foto\.jpg/i)).toBeInTheDocument()
    expect(screen.queryByText('bericht.pdf')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /clear filters/i })).not.toBeInTheDocument()
  })

  it('says a filter emptied the level only when the level really is empty, and clearing restores it', async () => {
    renderWorkspace(<ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />)
    await findFileButton(/foto\.jpg/i)
    await openMenu()
    await userEvent.click(await screen.findByLabelText('3D model (IFC)'))
    await userEvent.keyboard('{Escape}')

    expect(screen.queryByText('foto.jpg')).not.toBeInTheDocument()
    expect(screen.queryByText('bericht.pdf')).not.toBeInTheDocument()
    const clear = await screen.findByRole('button', { name: /clear filters/i })
    await userEvent.click(clear)

    expect(await findFileButton(/foto\.jpg/i)).toBeInTheDocument()
    expect(await findFileButton(/bericht\.pdf/i)).toBeInTheDocument()
  })
})

/**
 * THE FOLDER IS PART OF THE ADDRESS.
 *
 * It was `useState`, which made the folder tree the one part of this page the
 * browser did not know about: three folders deep, back left Dateien entirely
 * instead of going up one level, a reload dropped the reader at the root, and a
 * folder could not be sent to a colleague at all. Every other view on this page
 * — which model, which storey, which element — has lived in the URL for exactly
 * those reasons.
 */
describe('ProjectFileWorkspace — folders are addressable', () => {
  const FOLDERS = [
    { id: 'f-1', name: 'Planung', parentId: null },
    { id: 'f-2', name: 'Statik', parentId: 'f-1' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    searchParams = new URLSearchParams()
    resetPreviewStore()
    server.use(
      http.get('/api/projects/:projectId/folders', () => HttpResponse.json({ folders: FOLDERS })),
      http.get('/api/documents', () =>
        HttpResponse.json({
          documents: [
            {
              id: 'doc-in-folder',
              filename: 'Statikbericht.pdf',
              fileSize: 2048,
              contentType: 'application/pdf',
              status: 'ready',
              folderId: 'f-2',
              createdAt: '2026-01-02T00:00:00Z',
              errorMessage: null,
            },
          ],
        })
      )
    )
  })

  const render = () =>
    renderWorkspace(
      <ProjectFileWorkspace projectId="proj-1" projectName="Test" collectionName="test-coll" />
    )

  it('opening a folder PUSHES it into the URL, so back means "up one level"', async () => {
    render()

    fireEvent.click(await screen.findByRole('button', { name: 'Open folder “Planung”' }))

    const href = String(routerPush.mock.calls.at(-1)?.[0])
    expect(new URLSearchParams(href.split('?')[1]).get('folder')).toBe('f-1')
    // `push`, not `replace`. With `replace` there is no history entry, and back
    // leaves the page instead of leaving the folder — which is the defect.
    expect(routerReplace).not.toHaveBeenCalled()
  })

  it('reads the level back out of the URL, so a pasted link opens that folder', async () => {
    searchParams = new URLSearchParams('folder=f-2')
    render()

    // The document filed in `f-2` — not visible at the root, where this page
    // used to land whatever the link said.
    expect(await screen.findByText(/Statikbericht/)).toBeInTheDocument()
  })

  it('offers a named way up, not just a breadcrumb to aim at', async () => {
    searchParams = new URLSearchParams('folder=f-2')
    render()

    // Named, so it says where it goes before it is pressed. The breadcrumb says
    // where you ARE, and reading a map to find the exit is work — three levels
    // deep the parent is a truncated word in a scrolling row.
    const back = await screen.findByTestId('folder-back')
    expect(back).toHaveTextContent('Planung')

    fireEvent.click(back)
    const href = String(routerPush.mock.calls.at(-1)?.[0])
    expect(new URLSearchParams(href.split('?')[1]).get('folder')).toBe('f-1')
  })

  it('leaves the root with no way up, because there is nowhere to go', async () => {
    render()
    await screen.findByRole('button', { name: 'Open folder “Planung”' })
    expect(screen.queryByTestId('folder-back')).not.toBeInTheDocument()
  })
})
