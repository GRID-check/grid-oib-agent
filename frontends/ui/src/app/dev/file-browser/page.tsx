'use client'

/**
 * Dev preview for the Files browser — the whole page, not just the listing:
 * the real `PageHeader` in the band `ProjectSectionFrame` gives it, carrying
 * the real `FileWorkspaceActions`, and below it the content column the grid is
 * held to. The pane alone stopped being a picture of the screen when its search
 * moved into that header.
 *
 * A module-scope fetch shim 404s thumbnails so the SVG sketch fallback renders.
 * 404s outside development.
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
 * `?variant=folder-tiles` is the shelf one level down: the trail out, the
 * subfolders the chip row could never reach, and the dashed tile that makes
 * another folder at the level being looked at.
 *
 * `?variant=folder-rename` and `?variant=folder-menu` render the two states a
 * folder tile only reaches through an interaction: a tile turned into its own
 * name field, and the ⋯ menu that gets it there. Both drive themselves — the
 * rename editor is internal component state, and the trigger is hover-revealed
 * on a pointer device, so a fixture that merely rendered the shelf would be a
 * picture of neither.
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
import { FileBrowserPane } from '@/features/documents/components/file-browser-pane'
import {
  FileWorkspaceActions,
  FileWorkspaceSearchField,
  type FileWorkspaceView,
} from '@/features/documents/components/file-workspace-actions'
import { useFileSearch, type FileSearchState } from '@/features/documents/hooks/use-file-search'
import { ShellContent } from '@/components/shell'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { UploadCloud } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FileItem, FolderItem } from '@/features/documents/components/project-file-workspace'

function makeFile(
  id: string,
  filename: string,
  summary: string,
  extra: Record<string, unknown> = {}
): FileItem {
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
  // Filed documents, so the folder tiles carry real counts — and so
  // Brandschutz's own count includes the one that sits in its subfolder.
  makeFile(
    'p1',
    'Brandschutzkonzept_Wohnbau-Nord.pdf',
    'Brandschutzkonzept für den Wohnbau Nord (GK 4).',
    {
      fileSize: 3_800_000,
      folderId: 'f-brand',
    }
  ),
  makeFile('p2', 'Fluchtwegplan_EG-2OG.pdf', 'Fluchtwegplan für Erdgeschoss bis 2. Obergeschoss.', {
    fileSize: 1_200_000,
    folderId: 'f-brand-plan',
  }),
  makeFile('p3', 'Grundriss_Regelgeschoss.dwg', 'CAD-Grundriss des Regelgeschosses.', {
    contentType: 'application/acad',
    fileSize: 5_600_000,
    folderId: 'f-arch',
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
  makeFile(
    'u3',
    'Lageplan_Bestand.pdf',
    'Lageplan des Bestands mit Grundstücksgrenzen und Zufahrt.',
    {
      fileSize: 3_100_000,
    }
  ),
  makeFile('u4', 'Bauphysik_Nachweis.pdf', 'Bauphysikalischer Nachweis für die Außenbauteile.', {
    fileSize: 2_200_000,
  }),
]

// Root + nested folders so the tree renders indentation, expand rows, and the
// per-row add-subfolder hit target.
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
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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
              {
                ...FILES[1],
                snippet: 'Die nutzbare Fluchtwegbreite beträgt mindestens 1,20 m.',
                page: 2,
                score: 0.93,
              },
              {
                ...FILES[0],
                snippet: 'Der zweite Fluchtweg führt über die Nordfassade.',
                page: 11,
                score: 0.71,
              },
              {
                ...FILES[4],
                snippet: 'Lastannahmen für den Fluchtbalkon nach ÖNORM B 1991.',
                page: 7,
                score: 0.38,
              },
            ],
          })
        }
      }
      return real(input, init)
    }
  }
}

/**
 * The chrome the Files page now puts AROUND the browsing pane: the section
 * header — the REAL `PageHeader`, in a band with the real classes
 * `ProjectSectionFrame` gives it — carrying the REAL `FileWorkspaceActions`,
 * and below it the content column the listing is held to.
 *
 * The pane alone is no longer a picture of the screen, because its search moved
 * up into that header. The actions row is the shared component rather than a
 * lookalike on purpose: what needs proving on a phone is that a search field,
 * two toggle groups and an upload button WRAP inside a `shrink-0` action slot,
 * and a copy of the row here would only prove it about the copy.
 */
function FilesFixtureFrame({
  search,
  view = 'cards',
  onView,
  testId,
  className,
  children,
}: {
  search: FileSearchState
  view?: FileWorkspaceView
  onView?: (view: FileWorkspaceView) => void
  testId?: string
  className?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div
      className={cn('flex flex-col overflow-hidden rounded-xl border', className)}
      data-testid={testId}
    >
      {/* Same classes ProjectSectionFrame gives its header band. */}
      <div className="bg-background shrink-0 border-b px-4 py-4 md:px-8">
        <PageHeader
          title="Dateien"
          subtitle="Unterlagen, auf die Piloti seine Antworten in diesem Projekt stützt."
          breadcrumb={
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <span>Stadthaus Wien</span>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>Dateien</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
          }
          action={
            <FileWorkspaceActions
              search={search}
              view={view}
              onViewChange={(next) => onView?.(next)}
              upload={
                <Button type="button" className="gap-1.5">
                  <UploadCloud className="size-4" aria-hidden />
                  Hochladen
                </Button>
              }
            />
          }
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ShellContent width="wide" className="py-4 md:py-6">
          {children}
        </ShellContent>
      </div>
    </div>
  )
}

/** The project search, shimmed by the module-scope fetch guard above. */
function useDevFileSearch(): FileSearchState {
  return useFileSearch({ endpoint: '/api/documents/search', extraBody: { projectId: 'proj-demo' } })
}

export default function FileBrowserDevPage(): JSX.Element {
  const variant = useSearchParams()?.get('variant') ?? 'default'
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  if (variant === 'uploading') return <JustUploadedFixture />
  if (variant === 'search-failed') return <SearchFailedFixture />
  if (variant === 'search-list') return <SearchInListViewFixture />
  if (variant === 'folder-tiles') return <FolderTilesFixture />
  if (variant === 'folder-rename') return <FolderCrudFixture mode="rename" />
  if (variant === 'folder-menu') return <FolderCrudFixture mode="menu" />
  return <FileBrowserFixtures />
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
  const search = useDevFileSearch()
  useSelfDrivenSearch('file-browser-search-list', 'Fluchtwegbreite')

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">
          Files browser — a search answered in the detail view
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          The ranking survives into a list whose own default is newest-first, and every row shows
          the passage that matched.
        </p>
      </div>

      <FilesFixtureFrame
        search={search}
        view="list"
        testId="file-browser-search-list"
        className="h-[560px]"
      >
        <FileBrowserPane
          files={FILES}
          allFiles={FILES}
          selectedFileId={selected}
          onSelectFile={setSelected}
          isLoading={false}
          hasFolderSelected={false}
          search={search}
          searchField={<FileWorkspaceSearchField search={search} />}
          view="list"
        />
      </FilesFixtureFrame>
    </main>
  )
}

/**
 * The folder shelf's two interaction-only states.
 *
 * `mode="menu"` opens the ⋯ menu on a tile — which is also the only way to SEE
 * that control on a pointer device, since it is hover-revealed
 * (`data-[state=open]:opacity-100` keeps the trigger lit while its menu is up).
 * `mode="rename"` goes one step further and picks Rename, so the tile is
 * replaced in place by its own name field — same box, same cell, same width as
 * the folder it stands in for. The two cannot share a page: the rename input
 * commits on blur, so opening a menu anywhere else would end the rename.
 *
 * These states used to belong to the folder TREE, which was the only home
 * folder management had. The tree is gone; the actions came with the folders.
 */
function FolderCrudFixture({ mode }: { mode: 'menu' | 'rename' }): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const search = useDevFileSearch()
  const noop = async () => true

  // `reactStrictMode` runs an effect twice on mount, and Enter on the trigger
  // TOGGLES the menu — so an unguarded effect opened it and immediately shut it
  // again. The ref makes the drive run once; there is deliberately no cleanup,
  // because Strict Mode's cleanup would cancel the frame the first pass queued.
  const driven = useRef(false)
  useEffect(() => {
    if (driven.current) return
    driven.current = true
    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="folder-actions-f-brand"]'
    )
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
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">
          {mode === 'menu' ? 'Folder tiles — a folder’s own actions' : 'Folder tiles — renaming in place'}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {mode === 'menu'
            ? 'Rename and Delete on the folder itself, the destructive one carrying its own colour.'
            : 'The name is edited where it already is, not in a dialog that takes it off screen.'}
        </p>
      </div>

      <FilesFixtureFrame search={search} className="h-[420px]" testId="folder-crud-fixture">
        <FileBrowserPane
          files={FILES}
          allFiles={FILES}
          selectedFileId={selected}
          onSelectFile={setSelected}
          isLoading={false}
          hasFolderSelected={false}
          search={search}
          searchField={<FileWorkspaceSearchField search={search} />}
          folders={FOLDERS}
          selectedFolderId={selectedFolderId}
          onSelectFolder={setSelectedFolderId}
          onCreateFolder={async () => false}
          onRenameFolder={noop}
          onDeleteFolder={noop}
        />
      </FilesFixtureFrame>
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
  const search = useDevFileSearch()

  useEffect(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="file-browser-search-failed"] input'
    )
    if (!input) return
    // React tracks the input's value on the node, so a plain assignment is
    // swallowed; going through the prototype setter is what makes `input` fire
    // with the new value. Then SUBMIT the form — the run is a form submit
    // (Enter or the Search button), not a keydown the pane listens for.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, 'Fluchtweg')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const submit = window.requestAnimationFrame(() => {
      input.closest('form')?.requestSubmit()
    })
    return () => window.cancelAnimationFrame(submit)
  }, [])

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">Files browser — the search could not run</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Held apart from “no matches”, which is a statement about the reader’s own files.
        </p>
      </div>

      <FilesFixtureFrame search={search} testId="file-browser-search-failed" className="h-[560px]">
        <FileBrowserPane
          files={FILES}
          allFiles={FILES}
          selectedFileId={selected}
          onSelectFile={setSelected}
          isLoading={false}
          hasFolderSelected={false}
          search={search}
          searchField={<FileWorkspaceSearchField search={search} />}
        />
      </FilesFixtureFrame>
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
  const search = useDevFileSearch()

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">Files browser — a batch that just landed</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Two documents still being read (one with its page preview already rendered) beside two
          that have settled.
        </p>
      </div>

      <FilesFixtureFrame search={search} className="h-[600px]">
        <FileBrowserPane
          files={UPLOADING_FILES}
          allFiles={UPLOADING_FILES}
          selectedFileId={selected}
          onSelectFile={setSelected}
          isLoading={false}
          hasFolderSelected={false}
          search={search}
          searchField={<FileWorkspaceSearchField search={search} />}
        />
      </FilesFixtureFrame>
    </main>
  )
}

/**
 * Inside a folder: the trail that leads back out, the subfolder tiles that were
 * unreachable in the cards view before, and the documents filed at this level.
 *
 * The chip row this replaced could only ever show TOP-LEVEL folders, so a
 * subfolder existed only in the tree; and a chip said a name with nothing behind
 * it, where a tile says how much is inside — subfolders counted, which is why
 * Brandschutz is not empty even though its own level holds one file.
 */
function FolderTilesFixture(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>('f-brand')
  const search = useDevFileSearch()
  const inFolder = FILES.filter((f) => f.folderId === selectedFolderId)

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">Files browser — folders as objects</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          A folder tile carries what is inside it; the trail above is the way back out.
        </p>
      </div>

      <FilesFixtureFrame search={search} className="h-[640px]">
        <FileBrowserPane
          files={inFolder}
          allFiles={FILES}
          selectedFileId={selected}
          onSelectFile={setSelected}
          isLoading={false}
          hasFolderSelected={selectedFolderId !== null}
          search={search}
          searchField={<FileWorkspaceSearchField search={search} />}
          folders={FOLDERS}
          selectedFolderId={selectedFolderId}
          onSelectFolder={setSelectedFolderId}
        />
      </FilesFixtureFrame>
    </main>
  )
}

function FileBrowserFixtures(): JSX.Element {
  const [selected, setSelected] = useState<string | null>('p2')
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [view, setView] = useState<'cards' | 'list'>('cards')
  const search = useDevFileSearch()
  const noop = async () => true

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">Files browser — the page, not the pane</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Search in the header band, folders as tiles above the grid — the only home folder
          management has now — and the grid held to the app’s content column, so four previews fit a
          row instead of six stamps.
        </p>
      </div>

      {/* The browsing surface as the Files page composes it: header band with
          the search field and the view toggle, then the centred column. There
          are TWO views to toggle now, not three: the folder sidebar went when
          the folders became tiles on this surface, because it was the same
          navigation twice and one of the two cost a fifth of the width. */}
      <FilesFixtureFrame search={search} view={view} onView={setView} className="h-[880px]">
        <FileBrowserPane
          files={selectedFolderId ? FILES.filter((f) => f.folderId === selectedFolderId) : FILES}
          allFiles={FILES}
          selectedFileId={selected}
          onSelectFile={setSelected}
          isLoading={false}
          hasFolderSelected={selectedFolderId !== null}
          search={search}
          searchField={<FileWorkspaceSearchField search={search} />}
          view={view}
          folders={FOLDERS}
          selectedFolderId={selectedFolderId}
          onSelectFolder={setSelectedFolderId}
          onCreateFolder={noop}
          onRenameFolder={noop}
          onDeleteFolder={noop}
        />
      </FilesFixtureFrame>
    </main>
  )
}
