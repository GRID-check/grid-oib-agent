import { useMemo } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { useTranslations } from '@/i18n'
import { useFileSearch } from '../hooks/use-file-search'
import { FileBrowserPane } from './file-browser-pane'
import { FileSearchField } from './file-search'
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

/**
 * The pane WITH the chrome that owns its search — which is the workspace's job
 * now, not the pane's. The field moved into the page header, so a spec that
 * mounted the pane alone could no longer type a query at all; mounting the same
 * two pieces the workspace mounts keeps these tests about the behaviour they
 * were written for, and additionally pins that the two halves still talk.
 */
function Harness({
  projectId,
  ...paneProps
}: { projectId?: string } & Partial<Omit<PaneProps, 'search'>>) {
  const t = useTranslations('files')
  const extraBody = useMemo(() => ({ projectId }), [projectId])
  const search = useFileSearch({
    endpoint: '/api/documents/search',
    extraBody,
    canSearch: projectId !== undefined,
  })
  return (
    <>
      <FileSearchField
        value={search.query}
        onChange={search.setQuery}
        onSubmit={search.submit}
        onClear={search.clear}
        placeholder={t('browser.searchPlaceholder')}
        searchLabel={t('browser.searchLabel')}
        resetLabel={t('browser.resetSearch')}
      />
      <FileBrowserPane
        files={files}
        allFiles={files}
        selectedFileId={null}
        onSelectFile={vi.fn()}
        isLoading={false}
        hasFolderSelected={false}
        {...paneProps}
        search={search}
      />
    </>
  )
}

function renderPane(overrides: { projectId?: string } & Partial<Omit<PaneProps, 'search'>> = {}) {
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

describe('FileBrowserPane — folder tiles', () => {
  const folders: FolderItem[] = [
    { id: 'root-1', parentId: null, name: 'Pläne', path: '/Pläne' },
    { id: 'root-2', parentId: null, name: 'Bescheide', path: '/Bescheide' },
    { id: 'child-1', parentId: 'root-1', name: 'EG', path: '/Pläne/EG' },
  ]

  it('shows the folders at THIS level as tiles and forwards selection', async () => {
    const user = userEvent.setup()
    const onSelectFolder = vi.fn()
    renderPane({ folders, selectedFolderId: null, onSelectFolder })

    const tiles = screen.getAllByTestId('folder-tile')
    expect(tiles.map((tile) => tile.getAttribute('data-folder-id'))).toEqual(['root-1', 'root-2'])
    // A nested folder belongs to its parent's level, not the root's.
    expect(screen.queryByText('EG')).not.toBeInTheDocument()

    await user.click(tiles[0])
    expect(onSelectFolder).toHaveBeenCalledWith('root-1')
  })

  it('opens the SUBfolders once inside a folder — the chip row could not reach them', () => {
    renderPane({
      folders,
      selectedFolderId: 'root-1',
      onSelectFolder: vi.fn(),
      hasFolderSelected: true,
    })
    const tiles = screen.getAllByTestId('folder-tile')
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toHaveAttribute('data-folder-id', 'child-1')
  })

  it('counts what is inside a folder, subfolders included', () => {
    // Nothing is filed at Pläne's own level — everything sits one step down. A
    // count that stopped at the direct children would call the folder empty.
    const filed = [
      { ...files[0], folderId: 'child-1' },
      { ...files[1], folderId: 'root-2' },
    ]
    renderPane({
      files: filed,
      allFiles: filed,
      folders,
      selectedFolderId: null,
      onSelectFolder: vi.fn(),
    })
    const plaene = screen
      .getAllByTestId('folder-tile')
      .find((t) => t.dataset.folderId === 'root-1')!
    expect(within(plaene).getByText('1 file')).toBeInTheDocument()
  })

  it('leads back out of a folder through the trail', async () => {
    const user = userEvent.setup()
    const onSelectFolder = vi.fn()
    renderPane({ folders, selectedFolderId: 'child-1', onSelectFolder, hasFolderSelected: true })

    const trail = screen.getByTestId('folder-trail')
    // Tiles only drill down, so without this a subfolder is a dead end for
    // anyone who is not in the tree view.
    await user.click(within(trail).getByRole('button', { name: 'Pläne' }))
    expect(onSelectFolder).toHaveBeenCalledWith('root-1')

    await user.click(within(trail).getByRole('button', { name: 'All Files' }))
    expect(onSelectFolder).toHaveBeenCalledWith(null)
  })

  it('renders no tiles and no trail without folders or handler', () => {
    renderPane()
    expect(screen.queryByTestId('folder-tiles')).not.toBeInTheDocument()
    expect(screen.queryByTestId('folder-trail')).not.toBeInTheDocument()
  })

  it('keeps the subfolders reachable in a folder that holds no documents of its own', () => {
    // The emptiness check used to run first and return before the tiles, so a
    // folder whose files all live one level down answered "nothing here" over
    // the folders that held them.
    renderPane({
      files: [],
      allFiles: files,
      folders,
      selectedFolderId: 'root-1',
      onSelectFolder: vi.fn(),
      hasFolderSelected: true,
    })
    expect(screen.getByTestId('folder-tile')).toHaveAttribute('data-folder-id', 'child-1')
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
        : Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
    )
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fire escape{Enter}')

    // The panel says which of the two happened, in the reader's own terms.
    expect(await screen.findByText(/could not be run/i)).toBeInTheDocument()
    expect(screen.queryByText(/no semantic matches/i)).not.toBeInTheDocument()
    // A count is a claim about the corpus, and a search that never ran has not
    // counted anything — so nothing on screen reports a number at all.
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
            release = () =>
              resolve({ ok: true, json: () => Promise.resolve({ hits: [searchHit] }) })
          })
        : Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
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

  it('runs no semantic search at all without a projectId', async () => {
    // There is no run button to hide any more, so Enter is the only way in —
    // and on a surface with no corpus to query it has to be a no-op rather
    // than a request to an endpoint that cannot answer.
    const user = userEvent.setup()
    renderPane()

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fire escape{Enter}')

    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/documents/search'))).toBe(
      false
    )
    expect(screen.queryByTestId('semantic-match')).not.toBeInTheDocument()
  })

  it('keeps the instant substring filter working as you type, before any semantic run', async () => {
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'permit')
    expect(screen.getByText('permit.pdf')).toBeInTheDocument()
    expect(screen.queryByText('site-plan.pdf')).not.toBeInTheDocument()
    // Substring filtering never hits the semantic endpoint.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/documents/search'))).toBe(
      false
    )
  })

  it('runs the semantic search on Enter and renders the snippet, page and relevance', async () => {
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fire escape{Enter}')

    // The hits ARE the answer: no tinted strip restating their count above
    // them, which is what pushed the listing down a row on every search.
    expect(screen.queryByTestId('semantic-banner')).not.toBeInTheDocument()

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

  it('leaves semantic mode through the field’s own clear', async () => {
    const user = userEvent.setup()
    renderPane({ projectId: 'proj-1' })

    await user.type(screen.getByRole('textbox', { name: /search files/i }), 'fire escape{Enter}')
    await screen.findByTestId('semantic-match')

    // With the banner gone this ✕ is the way out, so it has to be one.
    await user.click(screen.getByRole('button', { name: /reset search/i }))

    expect(screen.queryByTestId('semantic-match')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: /search files/i })).toHaveValue('')
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

describe('FileBrowserPane — managing folders from the tiles', () => {
  // The sidebar tree was folder management's only home: create, rename and
  // delete existed nowhere else. Retiring that view without moving them would
  // have retired them too, so these are the tests that used to live on the tree.
  const folders: FolderItem[] = [
    { id: 'root-1', parentId: null, name: 'Pläne', path: '/Pläne' },
    { id: 'child-1', parentId: 'root-1', name: 'EG', path: '/Pläne/EG' },
  ]

  function renderShelf(overrides: Partial<Omit<PaneProps, 'search'>> = {}) {
    return renderPane({
      folders,
      selectedFolderId: null,
      onSelectFolder: vi.fn(),
      onCreateFolder: vi.fn(async () => true),
      onRenameFolder: vi.fn(async () => true),
      onDeleteFolder: vi.fn(async () => true),
      ...overrides,
    })
  }

  it('creates a folder at the level being looked at, not always at the root', async () => {
    const user = userEvent.setup()
    const onCreateFolder = vi.fn(async () => true)
    // Inside "Pläne": the per-row "add subfolder" control went with the tree,
    // so the new-folder tile is what keeps a nested folder creatable at all.
    renderShelf({ onCreateFolder, selectedFolderId: 'root-1', hasFolderSelected: true })

    await user.click(screen.getByTestId('folder-create-tile'))
    await user.type(screen.getByTestId('folder-create-input'), 'Einreichung{Enter}')

    expect(onCreateFolder).toHaveBeenCalledWith('Einreichung', 'root-1')
  })

  it('keeps the typed name when the create is rejected', async () => {
    const user = userEvent.setup()
    // Nobody should have to type a name twice because the server was busy.
    renderShelf({ onCreateFolder: vi.fn(async () => false) })

    await user.click(screen.getByTestId('folder-create-tile'))
    await user.type(screen.getByTestId('folder-create-input'), 'Bescheide{Enter}')

    expect(screen.getByTestId('folder-create-input')).toHaveValue('Bescheide')
  })

  it('renames in the tile the reader is already looking at', async () => {
    const user = userEvent.setup()
    const onRenameFolder = vi.fn(async () => true)
    renderShelf({ onRenameFolder })

    await user.click(screen.getByTestId('folder-actions-root-1'))
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }))

    const field = screen.getByTestId('folder-rename-input-root-1')
    expect(field).toHaveValue('Pläne')
    await user.clear(field)
    await user.type(field, 'Planung{Enter}')
    expect(onRenameFolder).toHaveBeenCalledWith('root-1', 'Planung')
  })

  it('treats Escape as a cancel and an unchanged name as nothing to do', async () => {
    const user = userEvent.setup()
    const onRenameFolder = vi.fn(async () => true)
    renderShelf({ onRenameFolder })

    await user.click(screen.getByTestId('folder-actions-root-1'))
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }))
    await user.keyboard('{Enter}')
    // Enter on an untouched field is not a round trip.
    expect(onRenameFolder).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('folder-actions-root-1'))
    await user.click(await screen.findByRole('menuitem', { name: /rename/i }))
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('folder-rename-input-root-1')).not.toBeInTheDocument()
    expect(onRenameFolder).not.toHaveBeenCalled()
  })

  it('offers the delete on the folder itself', async () => {
    const user = userEvent.setup()
    const onDeleteFolder = vi.fn(async () => true)
    renderShelf({ onDeleteFolder })

    await user.click(screen.getByTestId('folder-actions-root-1'))
    await user.click(await screen.findByTestId('folder-delete-root-1'))
    expect(onDeleteFolder).toHaveBeenCalledWith('root-1')
  })

  it('shows no folder actions at all when the surface passes no handlers', () => {
    renderPane({ folders, selectedFolderId: null, onSelectFolder: vi.fn() })
    expect(screen.queryByTestId('folder-actions-root-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('folder-create-tile')).not.toBeInTheDocument()
  })

  it('offers the new-folder tile in a project that has no folders yet', () => {
    // An empty project is exactly where somebody wants to make the first one,
    // and the emptiness check used to return before the shelf was drawn.
    renderShelf({ folders: [] })
    expect(screen.getByTestId('folder-create-tile')).toBeInTheDocument()
  })

  it('says the folders could not be loaded rather than drawing an empty shelf', () => {
    // A project whose folders failed to arrive is not a project without
    // folders, and the difference is the reader's whole model of where their
    // documents are.
    renderShelf({ foldersError: <span data-testid="folders-load-error">Folders failed</span> })
    expect(screen.getByTestId('folders-load-error')).toBeInTheDocument()
    expect(screen.queryByTestId('folder-tiles')).not.toBeInTheDocument()
  })
})
