import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { FileBrowserPane } from './file-browser-pane'
import type { FileItem, FolderItem } from './project-file-workspace'

const files: FileItem[] = [
  {
    id: 'f1',
    filename: 'site-plan.pdf',
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
  {
    id: 'f2',
    filename: 'permit.pdf',
    displayName: null,
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
  it('renders one card per file with a content-aware skeleton thumbnail', async () => {
    renderPane()
    const cards = screen.getAllByTestId('file-card')
    expect(cards).toHaveLength(2)
    // Kind inference drives the thumbnail: "site-plan.pdf" → siteplan sketch.
    // The thumbnail request settles (a brief skeleton first) before the fallback.
    const sitePlanCard = cards.find((c) => within(c).queryByText('site-plan.pdf'))!
    expect(await within(sitePlanCard).findByTestId('document-kind-thumbnail')).toHaveAttribute(
      'data-kind',
      'siteplan'
    )
    // "permit.pdf" → official-notice sketch.
    const permitCard = cards.find((c) => within(c).queryByText('permit.pdf'))!
    expect(await within(permitCard).findByTestId('document-kind-thumbnail')).toHaveAttribute(
      'data-kind',
      'notice'
    )
  })

  it('shows the tinted extension chip, size and the ingestion status badge on each card', () => {
    renderPane()
    const cards = screen.getAllByTestId('file-card')
    const card = cards.find((c) => within(c).queryByText('site-plan.pdf'))!
    expect(within(card).getByText('PDF')).toBeInTheDocument()
    expect(within(card).getByText(/1 kB/)).toBeInTheDocument()
    // The ingestion-status badge is kept — critical info the dummy lacks.
    expect(within(card).getByText('Citable')).toBeInTheDocument()
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

describe('FileBrowserPane — semantic search (explicit run)', () => {
  const searchHit = {
    ...files[0],
    filename: 'site-plan.pdf',
    displayName: null,
    snippet: 'The second escape route runs along the north facade.',
    page: 4,
    score: 0.87,
  }

  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn((url: string | URL) => {
      const href = String(url)
      if (href.includes('/api/documents/search')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ hits: [searchHit] }) })
      }
      // Thumbnail probes and anything else: fall back to the SVG sketch.
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('says the search failed rather than reporting an empty corpus', async () => {
    // The hook fails OPEN — an empty hit list, never a crash — and reports
    // which of the two happened. Nothing read that flag, so a backend timeout
    // rendered as "no semantic matches for 'fire escape'": the pane told the
    // reader something about their own files that it had no way of knowing,
    // and offered them a reset for it.
    fetchMock.mockImplementation((url: string | URL) =>
      String(url).includes('/api/documents/search')
        ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
        : Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    )
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fire escape{Enter}')

    // The banner AND the panel both say it now, which is why this counts two.
    expect(await screen.findAllByText(/could not be run/i)).toHaveLength(2)
    expect(screen.queryByText(/no semantic matches/i)).not.toBeInTheDocument()
    // And the banner above it: a count is a claim about the corpus, and a
    // search that never ran has not counted anything. "0 results" over a panel
    // that says the search failed is the same lie twice.
    expect(await screen.findByTestId('semantic-banner')).not.toHaveTextContent(/0 results/i)
  })

  it('retries the SAME query, instead of only offering to give up', async () => {
    let attempt = 0
    fetchMock.mockImplementation((url: string | URL) => {
      const href = String(url)
      if (!href.includes('/api/documents/search')) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
      }
      attempt += 1
      return attempt === 1
        ? Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ hits: [searchHit] }) })
    })
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fire escape{Enter}')
    await user.click(await screen.findByRole('button', { name: /try again/i }))

    // The reader had already typed the query once; a "show all files" button
    // as the only way out asks them to start over.
    expect(await screen.findByTestId('semantic-match')).toBeInTheDocument()
    expect(attempt).toBe(2)
  })

  it('answers a search in the view the reader chose, not always in cards', async () => {
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1', view: 'list' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fire escape{Enter}')

    // The toggle was read only on the un-searched branch, so pressing Enter
    // threw a reader who had deliberately switched to the detail view back into
    // cards — and clearing the query threw them back again.
    expect(await screen.findByTestId('file-list-view')).toBeInTheDocument()
    expect(screen.queryByTestId('semantic-match')).not.toBeInTheDocument()
    // And the ranking survives into it: the score is on the row.
    expect(await screen.findByTestId('file-list-relevance')).toHaveTextContent('87%')
  })

  it('shows no search button (and no semantic call) without a projectId', () => {
    renderPane()
    expect(screen.queryByRole('button', { name: /^search$/i })).not.toBeInTheDocument()
  })

  it('keeps the instant substring filter working as you type, before any semantic run', async () => {
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'permit')
    expect(screen.getByText('permit.pdf')).toBeInTheDocument()
    expect(screen.queryByText('site-plan.pdf')).not.toBeInTheDocument()
    // Substring filtering never hits the semantic endpoint.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/documents/search'))).toBe(false)
  })

  it('runs the semantic search on Enter and renders the snippet, page and relevance', async () => {
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fire escape{Enter}')

    // Transparent banner naming the mode + result count for the query.
    const banner = await screen.findByTestId('semantic-banner')
    expect(banner).toHaveTextContent(/semantic search: 1 result for/i)
    expect(banner).toHaveTextContent(/fire escape/)

    // The match evidence: snippet + page + relevance percent.
    const match = await screen.findByTestId('semantic-match')
    expect(within(match).getByText(/second escape route/i)).toBeInTheDocument()
    expect(within(match).getByTestId('semantic-page')).toHaveTextContent(/page 4/i)
    expect(within(match).getByText('87%')).toBeInTheDocument()

    // The right endpoint was called with the query.
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/documents/search'))
    expect(JSON.parse((call?.[1] as RequestInit).body as string)).toMatchObject({
      q: 'fire escape',
      projectId: 'proj-1',
    })
  })

  it('reset returns to the normal list and clears the banner', async () => {
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fire escape{Enter}')
    await screen.findByTestId('semantic-banner')

    await user.click(screen.getByRole('button', { name: /show all files/i }))

    expect(screen.queryByTestId('semantic-banner')).not.toBeInTheDocument()
    // Back to the full list.
    expect(screen.getByText('site-plan.pdf')).toBeInTheDocument()
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
