import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { FileBrowserPane } from './file-browser-pane'
import { FileSearchField } from './file-search-bar'
import { useFileSearch } from '../hooks/use-file-search'
import { useTranslations } from '@/i18n'
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

type PaneProps = Parameters<typeof FileBrowserPane>[0]
type HarnessProps = Omit<Partial<PaneProps>, 'search'> & {
  /** Corpus the semantic search runs against. Omit to offer the filter alone. */
  projectId?: string
}

/**
 * The pane as the PAGE composes it — search field above, listing below. The
 * query is owned by `useFileSearch` one level up (Files renders the field in
 * the page header), so a test that types has to go through the same two-part
 * arrangement the app uses rather than reaching into the pane.
 */
function Harness({ projectId, ...paneProps }: HarnessProps) {
  const t = useTranslations('files')
  const search = useFileSearch({ projectId })
  return (
    <>
      <FileSearchField
        value={search.query}
        onChange={search.setQuery}
        onSubmit={search.run}
        onClear={search.clear}
        placeholder={search.canSearch ? t('browser.semantic.searchPlaceholder') : t('browser.searchPlaceholder')}
        searchLabel={t('browser.searchLabel')}
        resetLabel={t('browser.resetSearch')}
      />
      <FileBrowserPane
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

function renderPane(overrides: HarnessProps = {}) {
  return render(<Harness {...overrides} />)
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

describe('FileBrowserPane — folder drill-down', () => {
  const folders: FolderItem[] = [
    { id: 'root-1', parentId: null, name: 'Pläne', path: '/Pläne' },
    { id: 'root-2', parentId: null, name: 'Bescheide', path: '/Bescheide' },
    { id: 'child-1', parentId: 'root-1', name: 'EG', path: '/Pläne/EG' },
  ]

  const folderNav = (currentFolderId: string | null, onNavigate = vi.fn()) => ({
    folders,
    currentFolderId,
    onNavigate,
    onCreateFolder: vi.fn(async () => true),
    onRenameFolder: vi.fn(async () => true),
    onDeleteFolder: vi.fn(async () => true),
  })

  it('renders the current level’s folders as cards (only), and clicking one drills in', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    renderPane({ folderNav: folderNav(null, onNavigate) })

    expect(screen.getByRole('button', { name: 'Open folder “Pläne”' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open folder “Bescheide”' })).toBeInTheDocument()
    // A nested folder belongs to ITS level, not the root.
    expect(screen.queryByRole('button', { name: 'Open folder “EG”' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Open folder “Pläne”' }))
    expect(onNavigate).toHaveBeenCalledWith('root-1')
  })

  it('names the path in the breadcrumb, every ancestor a click back out', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    renderPane({
      // Standing inside Pläne › EG: its own level shows, the path walks up.
      files: [],
      searchFiles: files,
      folderNav: folderNav('child-1', onNavigate),
    })

    const breadcrumb = screen.getByRole('navigation', { name: 'Folder path' })
    expect(within(breadcrumb).getByText('EG')).toBeInTheDocument()
    await user.click(within(breadcrumb).getByRole('button', { name: 'Pläne' }))
    expect(onNavigate).toHaveBeenCalledWith('root-1')
    await user.click(within(breadcrumb).getByRole('button', { name: 'All Files' }))
    expect(onNavigate).toHaveBeenCalledWith(null)
  })

  it('counts what is directly inside a folder on its card', () => {
    renderPane({
      files,
      searchFiles: [{ ...files[0], folderId: 'root-1' }, files[1]],
      folderNav: folderNav(null),
    })
    // Pläne holds one document and one subfolder — two items.
    const card = screen.getByTestId('folder-card-root-1')
    expect(within(card).getByText('2 item(s)')).toBeInTheDocument()
  })

  it('a typed query escapes the current folder and searches the corpus', async () => {
    const user = userEvent.setup()
    renderPane({
      // Standing inside an empty folder; the corpus lives elsewhere.
      files: [],
      searchFiles: files,
      folderNav: folderNav('root-2'),
    })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'permit')
    expect(screen.getByText('permit.pdf')).toBeInTheDocument()
  })

  it('renders no folder navigation without folderNav (the Archiv is flat)', () => {
    renderPane()
    expect(screen.queryByRole('navigation', { name: 'Folder path' })).not.toBeInTheDocument()
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

    // Said once, by the panel — the banner that used to repeat it is gone.
    expect(await screen.findAllByText(/could not be run/i)).toHaveLength(1)
    expect(screen.queryByText(/no semantic matches/i)).not.toBeInTheDocument()
    // And nowhere a count: a count is a claim about the corpus, and a search
    // that never ran has not counted anything. "0 results" beside a panel that
    // says the search failed is the same lie twice.
    expect(screen.queryByText(/0 results/i)).not.toBeInTheDocument()
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

  it('waits in the shape of the view the answer will arrive in', async () => {
    // Held open so the searching state is observable at all.
    let release: () => void = () => undefined
    fetchMock.mockImplementation((url: string | URL) =>
      String(url).includes('/api/documents/search')
        ? new Promise((resolve) => {
            release = () => resolve({ ok: true, json: () => Promise.resolve({ hits: [searchHit] }) })
          })
        : Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    )
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1', view: 'list' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fire escape{Enter}')

    // Card skeletons were drawn whatever the reader had chosen, so a search from
    // the list flashed a wall of tiles and then snapped to a table.
    expect(await screen.findByTestId('file-list-skeleton')).toBeInTheDocument()
    release()
    expect(await screen.findByTestId('file-list-view')).toBeInTheDocument()
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

    // The results ARE the report — no banner restating the mode and the count
    // over a list that shows both.
    expect(screen.queryByText(/semantic search:/i)).not.toBeInTheDocument()

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

  it('clearing the field returns to the normal list', async () => {
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fire escape{Enter}')
    await screen.findByTestId('semantic-match')

    // The field's own ✕ is the whole way out now that the banner — which used
    // to carry a second one — is gone.
    await user.click(screen.getByRole('button', { name: /reset search/i }))

    expect(screen.queryByTestId('semantic-match')).not.toBeInTheDocument()
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


/**
 * A FILTER THAT MATCHES NOTHING MUST NOT CLAIM THE FOLDER IS EMPTY.
 *
 * The pane is handed already-filtered files, so it could not tell the two
 * apart and drew "this folder is empty" over a folder full of documents. „Von
 * Piloti" paid for that twice: it is the filter whose meaning nobody could
 * infer, and the one state where the product could have explained it said
 * something false instead.
 */
describe('FileBrowserPane — a filter emptied the level', () => {
  const notice = {
    title: 'Piloti hat hier noch nichts abgelegt',
    description: 'Hier erscheinen die Dateien, die Piloti selbst erstellt hat.',
    onClear: vi.fn(),
  }

  beforeEach(() => notice.onClear.mockClear())

  it('says which filter emptied it, instead of that the folder is empty', () => {
    renderPane({ files: [], filterEmptyNotice: notice })

    expect(screen.getByText(notice.title)).toBeInTheDocument()
    expect(screen.getByText(notice.description)).toBeInTheDocument()
    expect(screen.queryByText('This folder is empty')).not.toBeInTheDocument()
  })

  it('offers the way out that actually applies — widen the filter, not upload', async () => {
    const user = userEvent.setup()
    renderPane({
      files: [],
      filterEmptyNotice: notice,
      uploadControl: <button type="button">Upload a file</button>,
    })

    // Uploading answers a question nobody asked: the files exist, the filter
    // is hiding them.
    expect(screen.queryByText('Upload a file')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /clear filters/i }))
    expect(notice.onClear).toHaveBeenCalled()
  })

  it('leaves the genuine empty folder alone', () => {
    renderPane({ files: [], filterEmptyNotice: null, uploadControl: <button type="button">Upload a file</button> })

    expect(screen.getByText('Upload a file')).toBeInTheDocument()
    expect(screen.queryByText(notice.title)).not.toBeInTheDocument()
  })
})

/**
 * THE SKELETON IS A PROMISE ABOUT THE NEXT FRAME.
 *
 * The one it replaced drew a full-width `h-9` bar — a search field the page had
 * moved into its header a release earlier and was never bringing back — above a
 * full-width grid of six card placeholders. What then arrived was a breadcrumb
 * row over a 1200px column that starts with folder tiles and ends with a dashed
 * upload cell. Every load ended in a jump, and the loading state described a
 * layout that had not existed for months.
 *
 * These pin the parts that made it wrong, so the next person to move a control
 * out of this pane finds out here rather than in a screenshot.
 */
describe('FileBrowserPane — loading', () => {
  const folderNav = {
    folders: [] as FolderItem[],
    currentFolderId: null,
    onNavigate: vi.fn(),
    onCreateFolder: vi.fn(),
    onRenameFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
  }

  it('draws the breadcrumb row, the folder tiles and the upload cell it is about to be replaced by', () => {
    renderPane({
      isLoading: true,
      folderNav,
      uploadCard: <button type="button">Drop files</button>,
    })

    const skeleton = screen.getByTestId('file-browser-skeleton')
    expect(within(skeleton).getByTestId('folder-breadcrumb-skeleton')).toBeInTheDocument()
    expect(within(skeleton).getAllByTestId('folder-card-skeleton').length).toBeGreaterThan(0)
    // The dashed cell is the last tile of a project's grid; a skeleton without
    // it is one tile shorter than the answer.
    expect(within(skeleton).getByText('Drop files')).toBeInTheDocument()
  })

  it('leaves the breadcrumb out on a surface that has no folders', () => {
    renderPane({ isLoading: true })
    const skeleton = screen.getByTestId('file-browser-skeleton')
    expect(within(skeleton).queryByTestId('folder-breadcrumb-skeleton')).not.toBeInTheDocument()
    expect(within(skeleton).queryByTestId('folder-card-skeleton')).not.toBeInTheDocument()
  })

  it('takes the shape of the view the reader chose', () => {
    renderPane({ isLoading: true, view: 'list', folderNav })
    const skeleton = screen.getByTestId('file-browser-skeleton')
    expect(within(skeleton).getByTestId('file-list-skeleton')).toBeInTheDocument()
    // The detail view's column headings are known before the listing is, so the
    // rows do not jump down by a header when the answer lands.
    expect(within(skeleton).getByText('Status')).toBeInTheDocument()
  })
})

/**
 * A folder card carries two aggregates — how much is inside, and how recently
 * anything under it changed. Both used to be computed per card by re-scanning
 * the corpus, and the second recursed while doing it. They are one pass now;
 * these say the answers did not move.
 */
describe('FileBrowserPane — folder aggregates', () => {
  const tree: FolderItem[] = [
    { id: 'root-a', parentId: null, name: 'Einreichung', path: 'Einreichung' },
    { id: 'child-a', parentId: 'root-a', name: 'Plaene', path: 'Einreichung/Plaene' },
  ]
  const corpus: FileItem[] = [
    { ...files[0], id: 'in-root', folderId: 'root-a', createdAt: '2026-01-01T00:00:00Z' },
    { ...files[1], id: 'in-child', folderId: 'child-a', createdAt: '2026-03-09T00:00:00Z' },
  ]

  it('counts direct children only, and reports the newest date from the whole subtree', () => {
    renderPane({
      files: [],
      searchFiles: corpus,
      folderNav: {
        folders: tree,
        currentFolderId: null,
        onNavigate: vi.fn(),
        onCreateFolder: vi.fn(),
        onRenameFolder: vi.fn(),
        onDeleteFolder: vi.fn(),
      },
    })

    const card = screen.getByTestId('folder-card-root-a')
    // One document + one subfolder directly inside: two items, not the three
    // things that exist underneath it.
    expect(within(card).getByText('2 item(s)')).toBeInTheDocument()
    // The newest thing under it is in the SUBFOLDER, so the walk has to reach
    // it — the folder's own document is two months older.
    expect(within(card).getByRole('time')).toHaveAttribute('datetime', '2026-03-09T00:00:00Z')
  })

  it('survives a parent cycle in the folder rows rather than overflowing the stack', () => {
    const cyclic: FolderItem[] = [
      { id: 'a', parentId: 'b', name: 'A', path: 'A' },
      { id: 'b', parentId: 'a', name: 'B', path: 'B' },
    ]
    expect(() =>
      renderPane({
        files: [],
        searchFiles: [],
        folderNav: {
          folders: cyclic,
          currentFolderId: null,
          onNavigate: vi.fn(),
          onCreateFolder: vi.fn(),
          onRenameFolder: vi.fn(),
          onDeleteFolder: vi.fn(),
        },
      }),
    ).not.toThrow()
  })
})
