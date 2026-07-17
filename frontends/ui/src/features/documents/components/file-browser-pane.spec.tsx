import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { FileBrowserPane } from './file-browser-pane'
import type { FileItem, FolderItem } from './project-file-workspace'

const files: FileItem[] = [
  {
    id: 'f1',
    filename: 'site-plan.pdf',
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
  {
    id: 'f2',
    filename: 'permit.pdf',
    fileSize: 2048,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-01-02T00:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: null,
    contentTypes: null,
    tags: null,
  },
]

function renderPane(overrides: Partial<Parameters<typeof FileBrowserPane>[0]> = {}) {
  return render(
    <FileBrowserPane
      files={files}
      selectedFileId={null}
      onSelectFile={vi.fn()}
      isLoading={false}
      hasFolderSelected={false}
      {...overrides}
    />
  )
}

describe('FileBrowserPane — card grid', () => {
  it('renders one card per file with a content-aware skeleton thumbnail', () => {
    renderPane()
    const cards = screen.getAllByTestId('file-card')
    expect(cards).toHaveLength(2)
    // Kind inference drives the thumbnail: "site-plan.pdf" → siteplan sketch.
    const sitePlanCard = cards.find((c) => within(c).queryByText('site-plan.pdf'))!
    expect(within(sitePlanCard).getByTestId('document-kind-thumbnail')).toHaveAttribute(
      'data-kind',
      'siteplan'
    )
    // "permit.pdf" → official-notice sketch.
    const permitCard = cards.find((c) => within(c).queryByText('permit.pdf'))!
    expect(within(permitCard).getByTestId('document-kind-thumbnail')).toHaveAttribute(
      'data-kind',
      'notice'
    )
  })

  it('shows the tinted extension chip, size and the ingestion status badge on each card', () => {
    renderPane()
    const cards = screen.getAllByTestId('file-card')
    const card = cards.find((c) => within(c).queryByText('site-plan.pdf'))!
    expect(within(card).getByText('PDF')).toBeInTheDocument()
    expect(within(card).getByText(/1\.0 KB/)).toBeInTheDocument()
    // The ingestion-status badge is kept — critical info the dummy lacks.
    expect(within(card).getByText('Ready')).toBeInTheDocument()
  })

  it('surfaces the failure reason on failed cards', () => {
    renderPane({
      files: [{ ...files[0], status: 'failed', errorMessage: 'Could not be processed' }],
    })
    expect(screen.getByText('Could not be processed')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('marks the selected card with aria-pressed', () => {
    renderPane({ selectedFileId: 'f1' })
    const cards = screen.getAllByTestId('file-card')
    const selected = cards.find((c) => within(c).queryByText('site-plan.pdf'))!
    expect(selected).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders the upload card as the last tile of the grid', () => {
    renderPane({ uploadCard: <div data-testid="upload-card-stub" /> })
    expect(screen.getByTestId('upload-card-stub')).toBeInTheDocument()
  })
})

describe('FileBrowserPane — document descriptions', () => {
  it('surfaces the AI-generated description on the card when one exists', () => {
    const withSummary: FileItem[] = [
      { ...files[0], summary: 'A ground-floor plan of the east wing.' },
      files[1],
    ]
    renderPane({ files: withSummary })
    // The description shows for the file that has one, and only for that file.
    expect(screen.getByText('A ground-floor plan of the east wing.')).toBeInTheDocument()
  })
})

describe('FileBrowserPane — folder chips', () => {
  const folders: FolderItem[] = [
    { id: 'root-1', parentId: null, name: 'Pläne', path: '/Pläne' },
    { id: 'root-2', parentId: null, name: 'Bescheide', path: '/Bescheide' },
    { id: 'child-1', parentId: 'root-1', name: 'EG', path: '/Pläne/EG' },
  ]

  it('renders top-level folders (only) as a chip row and forwards selection', async () => {
    const user = userEvent.setup()
    const onSelectFolder = vi.fn()
    renderPane({ folders, selectedFolderId: null, onSelectFolder })

    expect(screen.getByRole('button', { name: 'Pläne' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bescheide' })).toBeInTheDocument()
    // Nested folders stay in the sidebar tree, not the chip row.
    expect(screen.queryByRole('button', { name: 'EG' })).not.toBeInTheDocument()
    // The "All Files" chip is the root selection.
    expect(screen.getByRole('button', { name: 'All Files' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Pläne' }))
    expect(onSelectFolder).toHaveBeenCalledWith('root-1')
  })

  it('renders no chip row without folders or handler', () => {
    renderPane()
    expect(screen.queryByRole('button', { name: 'All Files' })).not.toBeInTheDocument()
  })
})

describe('FileBrowserPane — search', () => {
  it('matches tags and summaries, not just filenames', async () => {
    const user = userEvent.setup()
    renderPane({
      files: [
        { ...files[0], tags: ['Brandschutz'] },
        { ...files[1], summary: 'Fluchtweg im zweiten Obergeschoss.' },
      ],
    })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'brandschutz')
    expect(screen.getByText('site-plan.pdf')).toBeInTheDocument()
    expect(screen.queryByText('permit.pdf')).not.toBeInTheDocument()

    await user.clear(screen.getByRole('textbox', { name: /search files/i }))
    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fluchtweg')
    expect(screen.getByText('permit.pdf')).toBeInTheDocument()
    expect(screen.queryByText('site-plan.pdf')).not.toBeInTheDocument()
  })

  it('offers an inline reset button while a query is entered', async () => {
    const user = userEvent.setup()
    renderPane()

    expect(screen.queryByRole('button', { name: /reset search/i })).not.toBeInTheDocument()
    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'plan')
    await user.click(screen.getByRole('button', { name: /reset search/i }))
    expect(screen.getByRole('textbox', { name: /search files/i })).toHaveValue('')
    expect(screen.getByText('permit.pdf')).toBeInTheDocument()
  })
})

describe('FileBrowserPane — search zero-match', () => {
  it('shows an EmptyState with a Clear-search action when nothing matches', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'zzzz')

    expect(screen.getByText(/no files match/i)).toBeInTheDocument()
    expect(screen.getByText(/“zzzz”/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument()
    // The file cards are gone while the query has no matches.
    expect(screen.queryByText('site-plan.pdf')).not.toBeInTheDocument()
  })

  it('restores the full list when Clear search is clicked', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'zzzz')
    await user.click(screen.getByRole('button', { name: /clear search/i }))

    expect(screen.getByText('site-plan.pdf')).toBeInTheDocument()
    expect(screen.getByText('permit.pdf')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument()
  })
})
