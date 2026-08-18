'use client'

/**
 * Dev preview for the Files browser. Two fixtures:
 *
 *  1. The default card grid (`FileBrowserPane`) — the shared raised FileCard in
 *     its home surface, with the folder quick-filter chip row.
 *  2. The folder-TREE composition — the same segmented `ToggleGroup` the
 *     workspace uses, the tree band wrapper (same responsive classes) around
 *     the real `FolderTreePane`, plus a standalone `FileSearchBar` with a live
 *     query so the enlarged clear (X) hit target is visible.
 *
 * The tree fixture is the evidence for the mobile touch-target work on the
 * folder tree, view toggle, filter chips, and search-bar clear button. A
 * module-scope fetch shim 404s thumbnails so the SVG sketch fallback renders.
 * 404s outside development.
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

import { useState } from 'react'
import { notFound, useSearchParams } from 'next/navigation'
import { FileBrowserPane } from '@/features/documents/components/file-browser-pane'
import { FolderTreePane } from '@/features/documents/components/folder-tree-pane'
import { FileSearchBar } from '@/features/documents/components/file-search-bar'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { LayoutGrid, ListTree } from 'lucide-react'
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
  makeFile('p1', 'Brandschutzkonzept_Wohnbau-Nord.pdf', 'Brandschutzkonzept für den Wohnbau Nord (GK 4).', {
    fileSize: 3_800_000,
  }),
  makeFile('p2', 'Fluchtwegplan_EG-2OG.pdf', 'Fluchtwegplan für Erdgeschoss bis 2. Obergeschoss.', {
    fileSize: 1_200_000,
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
  makeFile('u3', 'Lageplan_Bestand.pdf', 'Lageplan des Bestands mit Grundstücksgrenzen und Zufahrt.', {
    fileSize: 3_100_000,
  }),
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
  return <FileBrowserFixtures />
}

/**
 * The grid a second after an upload: unsettled cards (no summary yet) sharing a
 * row with settled ones. Every tile has to reach the bottom of its cell, so the
 * size · time footers line up across the row whatever the card carries above it.
 */
function JustUploadedFixture(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)

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
          hasFolderSelected={false}
          projectId="proj-demo"
        />
      </div>
    </main>
  )
}

function FileBrowserFixtures(): JSX.Element {
  const [selected, setSelected] = useState<string | null>('p2')
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [view, setView] = useState<'cards' | 'tree'>('tree')
  // A non-empty query so the search bar's clear (X) target renders in the shot.
  const [treeSearch, setTreeSearch] = useState('Brandschutz')

  const noopCreate = async () => false

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
      <div>
        <h1 className="text-lg font-semibold">Files browser — folder tree + touch targets</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Tree view, view toggle, folder chips and search-clear at their mobile tap sizes.
        </p>
      </div>

      {/* Folder-TREE composition — mirrors ProjectFileWorkspace's tree layout so
          the folder rows, add-subfolder control, view toggle and tree band
          height reflect the real workspace on mobile. */}
      <div className="flex h-[720px] flex-col overflow-hidden rounded-xl border">
        {/* Action bar with the real card/tree view toggle. */}
        <div className="flex items-center justify-end gap-4 border-b px-4 py-3">
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(value) => {
              if (value === 'cards' || value === 'tree') setView(value)
            }}
            segmented
            size="icon-sm"
            aria-label="Ansicht"
          >
            <ToggleGroupItem value="cards" aria-label="Kacheln" title="Kacheln">
              <LayoutGrid />
            </ToggleGroupItem>
            <ToggleGroupItem value="tree" aria-label="Ordner" title="Ordner">
              <ListTree />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {/* Stacks on mobile (tree band on top), splits on md+ — same as workspace. */}
        <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
          <div className="max-h-72 w-full shrink-0 overflow-y-auto border-b md:max-h-none md:w-60 md:border-b-0 md:border-r">
            <FolderTreePane
              folders={FOLDERS}
              selectedFolderId={selectedFolderId}
              onSelectFolder={setSelectedFolderId}
              onCreateFolder={noopCreate}
              isLoading={false}
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            <FileBrowserPane
              files={selectedFolderId ? FILES.filter((f) => f.folderId === selectedFolderId) : FILES}
              selectedFileId={selected}
              onSelectFile={setSelected}
              isLoading={false}
              hasFolderSelected={selectedFolderId !== null}
              projectId="proj-demo"
              folders={FOLDERS}
              selectedFolderId={selectedFolderId}
              onSelectFolder={setSelectedFolderId}
            />
          </div>
        </div>
      </div>

      {/* Search-bar clear (X) at its enlarged tap size — needs a live query. */}
      <div>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Suche — Löschen (X)</h2>
        <div className="overflow-hidden rounded-xl border">
          <FileSearchBar
            value={treeSearch}
            onChange={setTreeSearch}
            onSubmit={() => {}}
            onClear={() => setTreeSearch('')}
            placeholder="Dokumente durchsuchen"
            searchLabel="Suche"
            resetLabel="Suche zurücksetzen"
            canSearch={false}
            runLabel="Suchen"
            isSearching={false}
            semanticActive={false}
            bannerText=""
            resetSemanticLabel="Zurücksetzen"
            onResetSemantic={() => setTreeSearch('')}
            bannerTestId="dev-semantic-banner"
          />
        </div>
      </div>

      {/* Card grid in its home surface (unchanged reference fixture). */}
      <div className="h-[820px] overflow-hidden rounded-xl border">
        <FileBrowserPane
          files={FILES}
          selectedFileId={selected}
          onSelectFile={setSelected}
          isLoading={false}
          hasFolderSelected={false}
          projectId="proj-demo"
        />
      </div>
    </main>
  )
}
