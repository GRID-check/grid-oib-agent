import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { ArchivLibraryPane } from './archiv-library-pane'
import type { FileItem } from './project-file-workspace'

const baseFile: Omit<FileItem, 'id' | 'filename'> = {
  fileSize: 1024,
  contentType: 'application/pdf',
  status: 'completed',
  folderId: null,
  createdAt: '2026-01-01T00:00:00Z',
  errorMessage: null,
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  tags: null,
}

const files: FileItem[] = [
  { ...baseFile, id: 'a1', filename: 'brandschutz-detail.pdf', tags: ['Brandschutz', 'Gutachten'] },
  {
    ...baseFile,
    id: 'a2',
    filename: 'fassade-schnitt.pdf',
    tags: ['Brandschutz'],
    summary: 'Fassadenschnitt mit Attikadetail.',
  },
  { ...baseFile, id: 'a3', filename: 'notes.pdf' },
]

function renderPane(overrides: Partial<Parameters<typeof ArchivLibraryPane>[0]> = {}) {
  return render(
    <ArchivLibraryPane
      files={files}
      selectedFileId={null}
      onSelectFile={vi.fn()}
      isLoading={false}
      {...overrides}
    />
  )
}

describe('ArchivLibraryPane — card grid', () => {
  it('renders one card per document with a content-aware skeleton thumbnail', async () => {
    renderPane()
    const cards = screen.getAllByTestId('archiv-document-card')
    expect(cards).toHaveLength(3)
    const schnittCard = cards.find((c) => within(c).queryByText('fassade-schnitt.pdf'))!
    // The thumbnail request settles (a brief skeleton first) before the
    // content-aware fallback shows.
    expect(await within(schnittCard).findByTestId('document-kind-thumbnail')).toHaveAttribute(
      'data-kind',
      'section'
    )
  })

  it('shows the tinted extension chip, size, and the ingestion status badge', () => {
    renderPane()
    const card = screen.getAllByTestId('archiv-document-card')[0]
    expect(within(card).getByText('PDF')).toBeInTheDocument()
    expect(within(card).getByText(/1 kB/)).toBeInTheDocument()
    expect(within(card).getByText('Citable')).toBeInTheDocument()
  })

  it('shows the one-line AI summary only when the backend generated one', () => {
    renderPane()
    expect(screen.getByText('Fassadenschnitt mit Attikadetail.')).toBeInTheDocument()
    const untaggedCard = screen
      .getAllByTestId('archiv-document-card')
      .find((c) => within(c).queryByText('notes.pdf'))!
    // No fake description on documents without a real summary.
    expect(untaggedCard.querySelectorAll('p')).toHaveLength(1)
  })

  it('surfaces the failure reason on failed cards', () => {
    renderPane({
      files: [{ ...files[0], status: 'failed', errorMessage: 'Could not be processed' }],
    })
    expect(screen.getByText('Could not be processed')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('marks the selected card with aria-pressed and forwards selection toggles', async () => {
    const user = userEvent.setup()
    const onSelectFile = vi.fn()
    renderPane({ selectedFileId: 'a1', onSelectFile })
    const cards = screen.getAllByTestId('archiv-document-card')
    const selected = cards.find((c) => within(c).queryByText('brandschutz-detail.pdf'))!
    expect(selected).toHaveAttribute('aria-pressed', 'true')

    await user.click(selected)
    expect(onSelectFile).toHaveBeenCalledWith(null)
  })
})

describe('ArchivLibraryPane — provenance footer', () => {
  it('renders the tag-based provenance line only for documents that really have tags', () => {
    renderPane()
    const provenances = screen.getAllByTestId('archiv-provenance')
    // Two tagged documents get a footer; the untagged one gets nothing (not a placeholder).
    expect(provenances).toHaveLength(2)
    expect(screen.getByText('From: Brandschutz · Gutachten')).toBeInTheDocument()
  })

  it('never renders a verified/Geprüft marker (no such workflow exists)', () => {
    renderPane()
    expect(screen.queryByText(/verified/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/geprüft/i)).not.toBeInTheDocument()
  })
})

describe('ArchivLibraryPane — category chips', () => {
  it('derives the chip row from the real tags on the loaded documents', () => {
    renderPane()
    const group = screen.getByRole('group', { name: /filter by category/i })
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: 'Brandschutz' })).toBeInTheDocument()
    expect(within(group).getByRole('button', { name: 'Gutachten' })).toBeInTheDocument()
    // Exactly All + the two distinct real tags — nothing invented, no "create category".
    expect(within(group).getAllByRole('button')).toHaveLength(3)
  })

  it('filters the grid by the selected tag and toggles back to All', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.click(screen.getByRole('button', { name: 'Gutachten' }))
    expect(screen.getByText('brandschutz-detail.pdf')).toBeInTheDocument()
    expect(screen.queryByText('fassade-schnitt.pdf')).not.toBeInTheDocument()
    expect(screen.queryByText('notes.pdf')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Gutachten' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getAllByTestId('archiv-document-card')).toHaveLength(3)
  })

  it('renders no chip row when no loaded document carries tags', () => {
    renderPane({ files: [{ ...files[2] }] })
    expect(screen.queryByRole('group', { name: /filter by category/i })).not.toBeInTheDocument()
  })
})

describe('ArchivLibraryPane — search', () => {
  it('matches names, tags, and summaries', async () => {
    const user = userEvent.setup()
    renderPane()
    const input = screen.getByRole('textbox', { name: /search archiv documents/i })

    await user.type(input, 'attika')
    expect(screen.getByText('fassade-schnitt.pdf')).toBeInTheDocument()
    expect(screen.queryByText('notes.pdf')).not.toBeInTheDocument()

    await user.clear(input)
    await user.type(input, 'gutachten')
    expect(screen.getByText('brandschutz-detail.pdf')).toBeInTheDocument()
    expect(screen.queryByText('fassade-schnitt.pdf')).not.toBeInTheDocument()
  })

  it('combines the search with the selected category chip', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.click(screen.getByRole('button', { name: 'Brandschutz' }))
    await user.type(screen.getByRole('textbox', { name: /search archiv documents/i }), 'fassade')
    expect(screen.getByText('fassade-schnitt.pdf')).toBeInTheDocument()
    expect(screen.queryByText('brandschutz-detail.pdf')).not.toBeInTheDocument()
  })

  it('shows a zero-match empty state whose Clear filters resets search and category', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.click(screen.getByRole('button', { name: 'Gutachten' }))
    await user.type(screen.getByRole('textbox', { name: /search archiv documents/i }), 'zzzz')
    expect(screen.getByText(/no matching documents/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /clear filters/i }))
    expect(screen.getAllByTestId('archiv-document-card')).toHaveLength(3)
    expect(screen.getByRole('textbox', { name: /search archiv documents/i })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('ArchivLibraryPane — empty and loading states', () => {
  it('shows the first-run empty state with the upload control when the Archiv is empty', () => {
    renderPane({ files: [], uploadControl: <div data-testid="upload-stub" /> })
    expect(screen.getByText(/the archiv is empty/i)).toBeInTheDocument()
    expect(screen.getByTestId('upload-stub')).toBeInTheDocument()
  })

  it('shows the empty state without an action for read-only members', () => {
    renderPane({ files: [] })
    expect(screen.getByText(/the archiv is empty/i)).toBeInTheDocument()
  })
})
