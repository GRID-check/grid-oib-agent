'use client'

/**
 * Dev preview for the Files browser grid (FileBrowserPane) so the shared,
 * raised FileCard can be reviewed/screenshotted in the file-browser context
 * without a backend. A module-scope fetch shim 404s thumbnails so the
 * deterministic SVG sketch fallback renders. 404s outside development.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'
import { FileBrowserPane } from '@/features/documents/components/file-browser-pane'
import type { FileItem } from '@/features/documents/components/project-file-workspace'

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
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __fileBrowserShim?: boolean }
  if (!w.__fileBrowserShim) {
    w.__fileBrowserShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Files browser — shared FileCard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The same raised card used by the chat surfacing grid and the Archiv library.
        </p>
      </div>
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
