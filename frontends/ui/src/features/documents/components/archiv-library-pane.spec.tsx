import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { useTranslations } from '@/i18n'
import { useFileSearch } from '../hooks/use-file-search'
import { ArchivLibraryPane } from './archiv-library-pane'
import { FileSearchField } from './file-search'
import type { FileItem } from './project-file-workspace'

const baseFile: Omit<FileItem, 'id' | 'filename'> = {
  displayName: null,
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
    displayName: null,
    tags: ['Brandschutz'],
    summary: 'Fassadenschnitt mit Attikadetail.',
  },
  { ...baseFile, id: 'a3', filename: 'notes.pdf' },
]

type PaneProps = Parameters<typeof ArchivLibraryPane>[0]

/**
 * The pane with the header band that owns its search — the workspace's job now,
 * since the field moved up out of the listing. Mounting both halves keeps these
 * tests about the behaviour they were written for and pins that the two still
 * talk to each other.
 */
function Harness(paneProps: Partial<Omit<PaneProps, 'search'>>) {
  const t = useTranslations('archiv')
  const search = useFileSearch({ endpoint: '/api/archiv/documents/search' })
  return (
    <>
      <FileSearchField
        value={search.query}
        onChange={search.setQuery}
        onSubmit={search.submit}
        onClear={search.clear}
        placeholder={t('library.searchPlaceholder')}
        searchLabel={t('library.searchLabel')}
        resetLabel={t('library.resetSearch')}
      />
      <ArchivLibraryPane
        files={files}
        selectedFileId={null}
        onSelectFile={vi.fn()}
        isLoading={false}
        {...paneProps}
        search={search}
      />
    </>
  )
}

function renderPane(overrides: Partial<Omit<PaneProps, 'search'>> = {}) {
  return render(<Harness {...overrides} />)
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
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
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
    expect(screen.getByRole('button', { name: 'Gutachten' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

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

  it('shapes the loading state like the loaded pane, so nothing moves when content arrives', () => {
    const { container } = renderPane({ isLoading: true })
    const busy = container.querySelector('[aria-busy="true"]')
    expect(busy).not.toBeNull()

    // Both bands of the real pane are present as placeholders: the category-chip
    // row and a full grid of card cells. (The search row is no longer one of
    // them — the field lives in the header band above, which is always drawn.)
    // The skeleton before this had a bar over six cells, so the chip row and
    // every card jumped position the moment the Archiv loaded.
    const bands = busy!.children
    expect(bands).toHaveLength(2)
    expect(bands[0].querySelectorAll('[data-slot="skeleton"]')).toHaveLength(4)
    expect(bands[1].querySelectorAll('.rounded-xl.border')).toHaveLength(8)
  })
})

describe('ArchivLibraryPane — result transitions', () => {
  it('marks which kind of result is on screen, and re-keys the region when that changes', async () => {
    const user = userEvent.setup()
    renderPane()

    // The key on this region is what cross-fades browse → nothing-found; it is
    // deliberately NOT keyed on the query, so filtering leaves the cards (and
    // their thumbnail requests) mounted.
    const region = screen.getByTestId('archiv-results')
    expect(region).toHaveAttribute('data-view', 'grid')

    await user.type(screen.getByRole('textbox', { name: /search archiv documents/i }), 'brand')
    expect(screen.getByTestId('archiv-results')).toBe(region)
    expect(region).toHaveAttribute('data-view', 'grid')

    await user.type(screen.getByRole('textbox', { name: /search archiv documents/i }), 'zzzz')
    expect(screen.getByTestId('archiv-results')).toHaveAttribute('data-view', 'no-match')
    expect(screen.getByTestId('archiv-results')).not.toBe(region)
  })
})
