import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '@/mocks/server'
import { ArchivWorkspace } from './archiv-workspace'

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
    await user.click(screen.getByText('brandschutz-gutachten.pdf'))
    // The menu carries only mutations here (download has its own button), so
    // with nothing left to offer it does not render at all — an empty overflow
    // menu is a control that lies about being one.
    await waitFor(() =>
      expect(screen.queryByTestId('document-actions-trigger')).not.toBeInTheDocument()
    )
  })
})

/** Open the Archiv preview for a document and its file-actions menu. */
async function openActions(user: ReturnType<typeof userEvent.setup>, filename: string) {
  await user.click(await screen.findByText(filename))
  await user.click(await screen.findByTestId('document-actions-trigger'))
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
