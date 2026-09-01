'use client'

/**
 * Dev preview for the Files browser — the Finder-style drill-down that
 * replaced the folder tree. Fixtures:
 *
 *  1. The default browser: breadcrumb path row ("All Files › …"), folder cards
 *     beside file cards at the current level, the New-folder popover, and the
 *     cards/list view toggle. Clicking a folder card drills in; the breadcrumb
 *     walks back out.
 *  2. A flat reference grid (no `folderNav`) — the Archiv's presentation.
 *  3. A standalone `FileSearchBar` with a live query so the enlarged clear (X)
 *     hit target is visible.
 *
 * A module-scope fetch shim 404s thumbnails so the SVG sketch fallback
 * renders. 404s outside development.
 *
 * `?variant=search-failed` renders the state a semantic search lands in when it
 * could not RUN. The hook fails open to an empty hit list so the pane cannot
 * crash, and it says which of the two happened — but nothing read that flag, so
 * a backend timeout rendered as "no semantic matches for <query>": the pane told
 * the reader something about their own corpus that it had no way of knowing, and
 * offered them a reset for it. The fixture makes the search endpoint 500 and
 * runs a query, which is the only way to see the state at all.
 *
 * `?variant=search-list` is a semantic search answered in the DETAIL view. The
 * view toggle used to be read only on the un-searched branch, so pressing Enter
 * threw a reader who had chosen the list back into cards. The fixture's hits are
 * deliberately not in upload order, so the shot also shows the ranking surviving
 * into a view whose default sort is newest-first.
 *
 * `?variant=folder-rename` and `?variant=folder-menu` render the two states a
 * folder card only reaches through an interaction: its name swapped for an
 * in-place editor, and the per-card ⋯ menu that gets it there. Both drive
 * themselves — the rename editor is internal component state, and the card
 * controls are hover-revealed on a pointer device, so a fixture that merely
 * rendered the grid would be a picture of neither.
 *
 * `?variant=uploading` renders the moment right after a batch lands, which is
 * the one row where the cards are NOT all the same shape: a document that is
 * still being read has no AI summary yet, while its neighbours do. That is the
 * state the grid used to render badly — the shorter card kept its natural
 * height inside a stretched grid cell and its size · time footer floated in the
 * middle of the tile with dead space underneath. One card in the fixture also
 * has its page thumbnail already rendered while the badge still says
 * "Processing", because a PDF preview is produced at upload time and the rest of
 * ingestion runs after it.
 */

import { useEffect, useRef, useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { FileBrowserPane, type FolderNavigation } from '@/features/documents/components/file-browser-pane'
import { FileSearchBar, FileSearchField } from '@/features/documents/components/file-search-bar'
import { useFileSearch } from '@/features/documents/hooks/use-file-search'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { LayoutGrid, List } from 'lucide-react'
import type { FileItem, FolderItem } from '@/features/documents/components/project-file-workspace'

function makeFile(id: string, filename: string, summary: string, extra: Record<string, unknown> = {}): FileItem {
  return {
    id,
    filename,
    displayName: null,
    fileSize: 2_400_000,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-06-14T09:00:00Z',
    errorMessage: null,
    summary,
    pageCount: 24,
    chunkCount: 48,
    contentTypes: ['text', 'table'],
    tags: null,
    ...extra,
  }
}

const FILES: FileItem[] = [
  // Filed documents — reachable by drilling into their folder, and countable
  // on its card ("2 items" on Brandschutz).
  makeFile('p1', 'Brandschutzkonzept_Wohnbau-Nord.pdf', 'Brandschutzkonzept für den Wohnbau Nord (GK 4).', {
    fileSize: 3_800_000,
    folderId: 'f-brand',
  }),
  makeFile('p2', 'Fluchtwegplan_EG-2OG.pdf', 'Fluchtwegplan für Erdgeschoss bis 2. Obergeschoss.', {
    fileSize: 1_200_000,
    folderId: 'f-brand-plan',
  }),
  makeFile('p3', 'Grundriss_Regelgeschoss.dwg', 'CAD-Grundriss des Regelgeschosses.', {
    contentType: 'application/acad',
    fileSize: 5_600_000,
  }),
  // Image with no thumbnail → the WARM placeholder (soft tile + format chip),
  // NOT a broken-image glyph.
  makeFile('p4', 'Fassadenschnitt_Nord.png', 'Fassadenschnitt der Nordseite mit Fluchtbalkon.', {
    contentType: 'image/png',
    fileSize: 4_100_000,
  }),
  makeFile('p5', 'Statik_Positionsplan.pdf', 'Positionsplan der Tragstruktur mit Lastannahmen.', {
    fileSize: 2_900_000,
    folderId: 'f-statik',
  }),
  makeFile('p6', 'Energieausweis.pdf', 'Energieausweis mit Heizwärmebedarf und Effizienzklasse.', {
    status: 'processing',
    fileSize: 900_000,
  }),
  // Image whose thumbnail genuinely FAILS to load (5xx) → the distinct
  // "Vorschau nicht verfügbar" treatment, separate from "no thumbnail".
  makeFile('p7', 'Baustellenfoto_Rohbau.jpg', 'Baustellenfoto des Rohbaus, Nordfassade.', {
    contentType: 'image/jpeg',
    fileSize: 5_300_000,
  }),
  // FORMAT BEATS THE NAME. „plan" matches anywhere in a filename, so these two
  // used to draw a floor-plan card — outer walls, partitions and a door swing —
  // over a Markdown note and a table. `Statik_Positionsplan.pdf` above is the
  // control: it is a PDF, it really can be a drawing, and it still reads as one.
  makeFile('p8', 'Projektplan_Sanierung.md', 'Ablauf der Sanierung in Phasen, mit offenen Punkten je Gewerk.', {
    contentType: 'text/markdown',
    fileSize: 31_000,
    pageCount: null,
    contentTypes: ['text'],
  }),
  makeFile('p9', 'Zeitplan_Gewerke.csv', 'Gewerke mit Start- und Endterminen je Bauabschnitt.', {
    contentType: 'text/csv',
    fileSize: 18_000,
    pageCount: null,
    contentTypes: ['table'],
  }),
]

/**
 * Stand-in for a rendered PDF first page — inline so the fixture needs no
 * backend and no committed binary. Shaped like a landscape drawing sheet, which
 * is what the card's thumbnail well actually has to crop.
 */
const PAGE_THUMBNAIL =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 260">
       <rect width="400" height="260" fill="#ffffff"/>
       <g fill="none" stroke="#1f2937" stroke-width="2">
         <path d="M40 220h320"/>
         <path d="M110 220V80l90-46 90 46v140"/>
         <path d="M110 174h180M110 128h180M110 80h180"/>
         <rect x="140" y="182" width="34" height="38"/>
         <rect x="226" y="182" width="34" height="38"/>
       </g>
       <g fill="none" stroke="#9ca3af" stroke-width="1.5">
         <path d="M40 226l10-10M64 226l10-10M88 226l10-10M302 226l10-10M326 226l10-10M350 226l10-10"/>
         <circle cx="62" cy="118" r="18"/><path d="M62 136v34"/>
         <circle cx="344" cy="130" r="14"/><path d="M344 144v26"/>
       </g>
     </svg>`
  )

/**
 * The moment a batch lands: two documents still being read (no summary yet, one
 * of them already showing its page preview) beside two that have settled. The
 * settled cards carry a two-line description, so they set the row height and the
 * unsettled ones have to fill it.
 */
const UPLOADING_FILES: FileItem[] = [
  makeFile('u1', '240119_PerspektivischerSchnitt_Bauteil-A.pdf', '', {
    status: 'processing',
    summary: null,
    fileSize: 2_400_000,
  }),
  makeFile('u2', 'Baubeschreibung_Einreichung.pdf', '', {
    status: 'processing',
    summary: null,
    fileSize: 1_700_000,
  }),
  makeFile('u3', 'Lageplan_Bestand.pdf', 'Lageplan des Bestands mit Grundstücksgrenzen und Zufahrt.', {
    fileSize: 3_100_000,
  }),
  makeFile('u4', 'Bauphysik_Nachweis.pdf', 'Bauphysikalischer Nachweis für die Außenbauteile.', {
    fileSize: 2_200_000,
  }),
]

// Root + nested folders so the drill-down renders folder cards, counts, and a
// multi-level breadcrumb once Brandschutz › Fluchtwege is entered.
const FOLDERS: FolderItem[] = [
  { id: 'f-brand', parentId: null, name: 'Brandschutz', path: '/Brandschutz' },
  { id: 'f-brand-plan', parentId: 'f-brand', name: 'Fluchtwege', path: '/Brandschutz/Fluchtwege' },
  { id: 'f-statik', parentId: null, name: 'Statik', path: '/Statik' },
  { id: 'f-arch', parentId: null, name: 'Architektur', path: '/Architektur' },
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __fileBrowserShim?: boolean }
  if (!w.__fileBrowserShim) {
    w.__fileBrowserShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      // u1 already has its page preview while ingestion is still running — the
      // PDF thumbnail is produced at upload time, the summary much later.
      if (/\/api\/documents\/u1\/thumbnail$/.test(url)) {
        return Response.json({ url: PAGE_THUMBNAIL })
      }
      // p7 simulates a GENUINE thumbnail failure (5xx) → distinct error tile;
      // every other thumbnail 404s → warm "no thumbnail" placeholder.
      if (/\/api\/documents\/p7\/thumbnail$/.test(url)) return new Response(null, { status: 500 })
      if (/\/api\/documents\/.+\/thumbnail$/.test(url)) return new Response(null, { status: 404 })
      if (/\/api\/documents\/search$/.test(url)) {
        const variant = new URLSearchParams(window.location.search).get('variant')
        // The semantic search, refusing to run — see the `search-failed` variant.
        if (variant === 'search-failed') return new Response(null, { status: 500 })
        // A RANKED answer, deliberately out of upload order: the best match is
        // the oldest file in the set, so a list that re-sorted by date would
        // put it last and the ranking would be gone without a word.
        if (variant === 'search-list') {
          return Response.json({
            hits: [
              { ...FILES[1], snippet: 'Die nutzbare Fluchtwegbreite beträgt mindestens 1,20 m.', page: 2, score: 0.93 },
              { ...FILES[0], snippet: 'Der zweite Fluchtweg führt über die Nordfassade.', page: 11, score: 0.71 },
              { ...FILES[4], snippet: 'Lastannahmen für den Fluchtbalkon nach ÖNORM B 1991.', page: 7, score: 0.38 },
            ],
          })
        }
      }
      return real(input, init)
    }
  }
}

export default function FileBrowserDevPage(): JSX.Element {
  const variant = useSearchParams()?.get('variant') ?? 'default'
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  if (variant === 'uploading') return <JustUploadedFixture />
  if (variant === 'search-failed') return <SearchFailedFixture />
  if (variant === 'search-list') return <SearchInListViewFixture />
  if (variant === 'folder-rename') return <FolderCrudFixture mode="rename" />
  if (variant === 'folder-menu') return <FolderCrudFixture mode="menu" />
  return <FileBrowserFixtures />
}

/** Local folder-navigation state over the fixture's static folders. */
function useFixtureFolderNav(): FolderNavigation & { currentFolderId: string | null } {
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null)
  return {
    folders: FOLDERS,
    currentFolderId,
    onNavigate: setCurrentFolderId,
    onCreateFolder: async () => false,
    onRenameFolder: async () => true,
    onDeleteFolder: async () => true,
  }
}

/**
 * Types a query and submits it, the way the failed-search fixture does — this
 * state only exists THROUGH a search, and setting it directly would be a
 * picture of the state rather than the pane arriving in it.
 */
function useSelfDrivenSearch(testId: string, query: string): void {
  useEffect(() => {
    const input = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"] input`)
    if (!input) return
    // React tracks the input's value on the node, so a plain assignment is
    // swallowed; going through the prototype setter is what makes `input` fire.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const submit = window.requestAnimationFrame(() => {
      input.closest('form')?.requestSubmit()
    })
    return () => window.cancelAnimationFrame(submit)
  }, [testId, query])
}

/** A ranked semantic answer, rendered in the view the reader actually chose. */
function SearchInListViewFixture(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const search = useFileSearch({ projectId: 'proj-demo' })
  useSelfDrivenSearch('file-browser-search-list', 'Fluchtwegbreite')

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">Files browser — a search answered in the detail view</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The ranking survives into a list whose own default is newest-first, and every row shows the passage
          that matched.
        </p>
      </div>

      {/* Mirrors ProjectFileWorkspace's composition: the field lives in the
          header, one component above the pane it filters. */}
      <div className="flex h-[460px] flex-col overflow-hidden rounded-xl border" data-testid="file-browser-search-list">
        <div className="flex items-center justify-end border-b px-4 py-3">
          <FileSearchField
            className="w-72"
            value={search.query}
            onChange={search.setQuery}
            onSubmit={search.run}
            onClear={search.clear}
            placeholder="Dateien durchsuchen"
            searchLabel="Suche"
            resetLabel="Suche zurücksetzen"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          <FileBrowserPane
            files={FILES}
            selectedFileId={selected}
            onSelectFile={setSelected}
            isLoading={false}
            search={search}
            view="list"
          />
        </div>
      </div>
    </main>
  )
}

/**
 * The folder card's two interaction-only states.
 *
 * `mode="menu"` opens the ⋯ menu on a card — which is also the only way to SEE
 * the card controls on a pointer device, since they are hover-revealed
 * (`data-[state=open]:opacity-100` keeps the trigger lit while its menu is up).
 * `mode="rename"` goes one step further and picks Rename, so the card's name is
 * replaced in place by its own field. The two cannot share a page: the rename
 * input commits on blur, so opening a menu anywhere else would end the rename.
 */
function FolderCrudFixture({ mode }: { mode: 'menu' | 'rename' }): JSX.Element {
  const folderNav = useFixtureFolderNav()
  const search = useFileSearch({ projectId: 'proj-demo' })

  // `reactStrictMode` runs an effect twice on mount, and Enter on the trigger
  // TOGGLES the menu — so an unguarded effect opened it and immediately shut it
  // again. The ref makes the drive run once; there is deliberately no cleanup,
  // because Strict Mode's cleanup would cancel the frame the first pass queued.
  const driven = useRef(false)
  useEffect(() => {
    if (driven.current) return
    driven.current = true
    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="folder-actions-f-brand"]')
    if (!trigger) return
    // Driven by KEYBOARD, not `.click()`: the trigger opens on pointerdown,
    // which a synthetic click never produces. Enter opens the menu and moves
    // focus to the first item, so a second Enter picks Rename — the same two
    // keystrokes a reader who never touches the mouse would use.
    const press = (node: Element | null) =>
      node?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    trigger.focus()
    press(trigger)
    if (mode === 'menu') return
    // The menu content is portaled and mounts a frame later.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => press(document.activeElement))
    })
  }, [mode])

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">
          {mode === 'menu' ? 'Folder card — the card’s own actions' : 'Folder card — renaming in place'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === 'menu'
            ? 'Rename and Delete on the folder itself, the destructive one carrying its own colour.'
            : 'The name is edited where it already is, not in a dialog that takes it off screen.'}
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border" data-testid="folder-crud-fixture">
        <FileBrowserPane
          files={[]}
          searchFiles={FILES}
          selectedFileId={null}
          onSelectFile={() => {}}
          isLoading={false}
          search={search}
          folderNav={folderNav}
        />
      </div>
    </main>
  )
}

/**
 * A semantic search that could not run.
 *
 * It drives itself — types the query and submits it — because this state is
 * only reachable THROUGH a search, and a fixture that set it directly would be
 * a picture of the state rather than the pane arriving in it.
 */
function SearchFailedFixture(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const search = useFileSearch({ projectId: 'proj-demo' })
  useSelfDrivenSearch('file-browser-search-failed', 'Fluchtweg')

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">Files browser — the search could not run</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Held apart from “no matches”, which is a statement about the reader’s own files.
        </p>
      </div>

      {/* Mirrors ProjectFileWorkspace's composition: the field lives in the
          header, one component above the pane it filters. */}
      <div className="flex h-[460px] flex-col overflow-hidden rounded-xl border" data-testid="file-browser-search-failed">
        <div className="flex items-center justify-end border-b px-4 py-3">
          <FileSearchField
            className="w-72"
            value={search.query}
            onChange={search.setQuery}
            onSubmit={search.run}
            onClear={search.clear}
            placeholder="Dateien durchsuchen"
            searchLabel="Suche"
            resetLabel="Suche zurücksetzen"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          <FileBrowserPane
            files={FILES}
            selectedFileId={selected}
            onSelectFile={setSelected}
            isLoading={false}
            search={search}
          />
        </div>
      </div>
    </main>
  )
}

/**
 * The grid a second after an upload: unsettled cards (no summary yet) sharing a
 * row with settled ones. Every tile has to reach the bottom of its cell, so the
 * size · time footers line up across the row whatever the card carries above it.
 */
function JustUploadedFixture(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const search = useFileSearch({ projectId: 'proj-demo' })

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">Files browser — a batch that just landed</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Two documents still being read (one with its page preview already rendered) beside two that have settled.
        </p>
      </div>

      <div className="h-[420px] overflow-hidden rounded-xl border">
        <FileBrowserPane
          files={UPLOADING_FILES}
          selectedFileId={selected}
          onSelectFile={setSelected}
          isLoading={false}
          search={search}
        />
      </div>
    </main>
  )
}

function FileBrowserFixtures(): JSX.Element {
  const [selected, setSelected] = useState<string | null>('p3')
  const [view, setView] = useState<'cards' | 'list'>('cards')
  const folderNav = useFixtureFolderNav()
  const search = useFileSearch({ projectId: 'proj-demo' })
  const flatSearch = useFileSearch({ projectId: 'proj-demo' })
  // A non-empty query so the search bar's clear (X) target renders in the shot.
  const [barSearch, setBarSearch] = useState('Brandschutz')

  const levelFiles = FILES.filter((f) => (f.folderId ?? null) === folderNav.currentFolderId)

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">Files browser — folder drill-down</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Breadcrumb path, folder cards beside the files, New-folder popover, and the cards/list toggle.
          Click a folder card to enter it; the path walks back out.
        </p>
      </div>

      {/* The drill-down browser — mirrors ProjectFileWorkspace's composition:
          view toggle and search field in the header band, the field's own
          results rendered by the pane below it. */}
      <div className="flex h-[720px] flex-col overflow-hidden rounded-xl border">
        <div className="flex flex-wrap items-center justify-end gap-2 border-b px-4 py-3">
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(value) => {
              if (value === 'cards' || value === 'list') setView(value)
            }}
            segmented
            size="icon-sm"
            aria-label="Ansicht"
          >
            <ToggleGroupItem value="cards" aria-label="Kacheln" title="Kacheln">
              <LayoutGrid />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label="Liste" title="Liste">
              <List />
            </ToggleGroupItem>
          </ToggleGroup>
          <FileSearchField
            className="w-64"
            value={search.query}
            onChange={search.setQuery}
            onSubmit={search.run}
            onClear={search.clear}
            placeholder="Dateien durchsuchen"
            searchLabel="Suche"
            resetLabel="Suche zurücksetzen"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          <FileBrowserPane
            files={levelFiles}
            searchFiles={FILES}
            selectedFileId={selected}
            onSelectFile={setSelected}
            isLoading={false}
            search={search}
            view={view}
            folderNav={folderNav}
          />
        </div>
      </div>

      {/* Search-bar clear (X) at its enlarged tap size — needs a live query. */}
      <div>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Suche — Löschen (X)</h2>
        <div className="overflow-hidden rounded-xl border">
          <FileSearchBar
            value={barSearch}
            onChange={setBarSearch}
            onSubmit={() => {}}
            onClear={() => setBarSearch('')}
            placeholder="Dokumente durchsuchen"
            searchLabel="Suche"
            resetLabel="Suche zurücksetzen"
            canSearch={false}
            runLabel="Suchen"
            isSearching={false}
            semanticActive={false}
            bannerText=""
            resetSemanticLabel="Zurücksetzen"
            onResetSemantic={() => setBarSearch('')}
            bannerTestId="dev-semantic-banner"
          />
        </div>
      </div>

      {/* Flat reference grid (no folderNav) — the Archiv's presentation. */}
      <div className="h-[820px] overflow-hidden rounded-xl border">
        <FileBrowserPane
          files={FILES}
          selectedFileId={selected}
          onSelectFile={setSelected}
          isLoading={false}
          search={flatSearch}
        />
      </div>
    </main>
  )
}
