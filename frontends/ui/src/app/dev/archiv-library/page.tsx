'use client'

/**
 * Dev preview for the Archiv library pane so its grid/search/category-chip chrome
 * can be compared side by side with the Files browser (`/dev/file-browser`) during
 * the file-experience unification. A module-scope fetch shim 404s thumbnails so
 * the SVG sketch fallback renders. 404s outside development.
 */

import { type JSX, useState } from 'react'
import { notFound } from 'next/navigation'
import { ArchivLibraryPane } from '@/features/documents/components/archiv-library-pane'
import type { FileItem } from '@/features/documents/components/project-file-workspace'

function makeFile(id: string, filename: string, summary: string, tags: string[], extra: Record<string, unknown> = {}): FileItem {
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
    tags,
    ...extra,
  }
}

const FILES: FileItem[] = [
  makeFile('a1', 'Referenzprojekt_Stadthaus-Wien.pdf', 'Vergleichbares Wohngebäude der GK 4.', ['Wohnbau', 'Referenz']),
  makeFile('a2', 'Detailkatalog_Treppen.pdf', 'Regeldetails für Treppenläufe und Geländer.', ['Detail', 'Treppen']),
  makeFile('a3', 'Brandschutz-Musterkonzept.pdf', 'Musterkonzept Brandschutz für GK 4–5.', ['Brandschutz', 'Muster'], {
    contentType: 'application/pdf',
  }),
  makeFile('a4', 'Fassadendetails_Nord.png', 'Fassadendetails Nordansicht.', ['Detail', 'Fassade'], {
    contentType: 'image/png',
  }),
  makeFile('a5', 'Statik_Standardpositionen.pdf', 'Standard-Statikpositionen und Lastannahmen.', ['Statik']),
  makeFile('a6', 'Ausschreibung_Vorlage.docx', 'Ausschreibungsvorlage Rohbau.', ['Ausschreibung', 'Vorlage'], {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }),
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __archivShim?: boolean }
  if (!w.__archivShim) {
    w.__archivShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (/\/api\/documents\/.+\/thumbnail$/.test(url)) return new Response(null, { status: 404 })
      return real(input, init)
    }
  }
}

export default function ArchivLibraryDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  const [selected, setSelected] = useState<string | null>(null)

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Archiv library — file experience</h1>
        <p className="mt-1 text-sm text-muted-foreground">Compare grid / search / chips with /dev/file-browser.</p>
      </div>
      <div className="h-[820px] overflow-hidden rounded-xl border">
        <ArchivLibraryPane files={FILES} selectedFileId={selected} onSelectFile={setSelected} isLoading={false} />
      </div>
    </main>
  )
}
