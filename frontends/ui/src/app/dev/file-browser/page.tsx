'use client'

/**
 * Dev preview for the Files browser. Two fixtures:
 *
 *  1. The default card grid (`FileBrowserPane`) — the shared raised FileCard in
 *     its home surface, with the folder quick-filter chip row.
 *  2. The folder-TREE composition — the real `ViewToggleButton` pair, the tree
 *     band wrapper (same responsive classes the workspace uses) around the real
 *     `FolderTreePane`, plus a standalone `FileSearchBar` with a live query so
 *     the enlarged clear (X) hit target is visible.
 *
 * The tree fixture is the evidence for the mobile touch-target work on the
 * folder tree, view toggle, filter chips, and search-bar clear button. A
 * module-scope fetch shim 404s thumbnails so the SVG sketch fallback renders.
 * 404s outside development.
 */

import { type JSX, useState } from 'react'
import { notFound } from 'next/navigation'
import { FileBrowserPane } from '@/features/documents/components/file-browser-pane'
import { FolderTreePane } from '@/features/documents/components/folder-tree-pane'
import { ViewToggleButton } from '@/features/documents/components/project-file-workspace'
import { FileSearchBar } from '@/features/documents/components/file-search-bar'
import { LayoutGrid, ListTree } from 'lucide-react'
import type { FileItem, FolderItem } from '@/features/documents/components/project-file-workspace'

function makeFile(id: string, filename: string, summary: string, extra: Record<string, unknown> = {}): FileItem {
  return {
    id,
    filename,
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
      // p7 simulates a GENUINE thumbnail failure (5xx) → distinct error tile;
      // every other thumbnail 404s → warm "no thumbnail" placeholder.
      if (/\/api\/documents\/p7\/thumbnail$/.test(url)) return new Response(null, { status: 500 })
      if (/\/api\/documents\/.+\/thumbnail$/.test(url)) return new Response(null, { status: 404 })
      return real(input, init)
    }
  }
}

export default function FileBrowserDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
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
          <div
            role="group"
            aria-label="Ansicht"
            className="flex items-center rounded-lg border bg-card p-0.5 shadow-2xs"
          >
            <ViewToggleButton active={view === 'cards'} onClick={() => setView('cards')} label="Kacheln" icon={LayoutGrid} />
            <ViewToggleButton active={view === 'tree'} onClick={() => setView('tree')} label="Ordner" icon={ListTree} />
          </div>
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
