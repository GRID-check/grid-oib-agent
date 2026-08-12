'use client'

/**
 * Dev preview for the org Archiv surface — the whole sheet, not just the grid:
 * the back control, the Büroarchiv identity row with its document count, and the
 * library pane inside the raised frame the real page renders. That is what the
 * screenshot evidence has to show, since the premium pass changed the chrome
 * around the cards rather than the cards themselves (which stay comparable with
 * `/dev/file-browser`).
 *
 * `?state=loading` renders the loading pane instead, which is the other half of
 * the evidence: the skeleton has to hold the SAME geometry as the loaded pane,
 * so the two screenshots line up band for band.
 *
 * The return trail is seeded with a project visit, so the back control shows what
 * it shows in the app — the NAME of the project the reader came out of.
 *
 * A module-scope fetch shim 404s thumbnails so the SVG sketch fallback renders.
 * 404s outside development.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { Archive } from 'lucide-react'
// Imported from the module, not the shell barrel: the barrel also exports the
// server-only OrgTopbar, which would drag `@/i18n/server` into this client page.
import { BackLink } from '@/components/shell/back-link'
import { CountPill } from '@/components/ui/count-pill'
import { sourceTint } from '@/lib/ui/source-tint'
import { writeTrail } from '@/lib/navigation/return-trail'
import { ArchivLibraryPane } from '@/features/documents/components/archiv-library-pane'
import type { FileItem } from '@/features/documents/components/project-file-workspace'

function makeFile(
  id: string,
  filename: string,
  summary: string,
  tags: string[],
  extra: Record<string, unknown> = {}
): FileItem {
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
  makeFile('a1', 'Referenzprojekt_Stadthaus-Wien.pdf', 'Vergleichbares Wohngebäude der GK 4.', [
    'Wohnbau',
    'Referenz',
  ]),
  makeFile('a2', 'Detailkatalog_Treppen.pdf', 'Regeldetails für Treppenläufe und Geländer.', [
    'Detail',
    'Treppen',
  ]),
  makeFile(
    'a3',
    'Brandschutz-Musterkonzept.pdf',
    'Musterkonzept Brandschutz für GK 4–5.',
    ['Brandschutz', 'Muster'],
    {
      contentType: 'application/pdf',
    }
  ),
  makeFile(
    'a4',
    'Fassadendetails_Nord.png',
    'Fassadendetails Nordansicht.',
    ['Detail', 'Fassade'],
    {
      contentType: 'image/png',
    }
  ),
  makeFile('a5', 'Statik_Standardpositionen.pdf', 'Standard-Statikpositionen und Lastannahmen.', [
    'Statik',
  ]),
  makeFile(
    'a6',
    'Ausschreibung_Vorlage.docx',
    'Ausschreibungsvorlage Rohbau.',
    ['Ausschreibung', 'Vorlage'],
    {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }
  ),
]

const OFFICE_TINT = sourceTint('office')

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  // Seed the tab's return trail at module scope — before the first render, so
  // the back control reads it on its own first effect — with the case the
  // preview is evidence for: the reader came here from a project, and the
  // control names that project rather than offering a generic listing.
  writeTrail([
    { path: '/app/projects/p1/files', label: 'Stadthaus Wien' },
    { path: window.location.pathname },
  ])

  const w = window as unknown as { __archivShim?: boolean }
  if (!w.__archivShim) {
    w.__archivShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
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
  // Read after mount (not during render) so the fixture is identical on server
  // and client — the same rule the other /dev previews follow.
  const [isLoading, setIsLoading] = useState(false)
  useEffect(() => {
    setIsLoading(new URLSearchParams(window.location.search).get('state') === 'loading')
  }, [])

  return (
    <main className="mx-auto flex max-w-6xl flex-col p-6">
      <BackLink fallbackHref="/app/projects" fallbackLabel="Back to projects" />
      <div className="shadow-xs mt-3 flex h-[820px] flex-col overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between gap-4 border-b px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="shadow-2xs flex size-9 shrink-0 items-center justify-center rounded-xl"
              style={OFFICE_TINT}
              aria-hidden
            >
              <Archive className="size-[18px]" />
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="text-foreground truncate text-[15px] font-semibold tracking-tight">
                  Archiv
                </h1>
                {!isLoading && <CountPill>{FILES.length}</CountPill>}
              </div>
              <p className="text-muted-foreground truncate text-xs">
                Shared documents available to every project in your organization
              </p>
            </div>
          </div>
        </div>
        <div className="scroll-fade-bottom flex-1 overflow-y-auto">
          <ArchivLibraryPane
            files={FILES}
            selectedFileId={selected}
            onSelectFile={setSelected}
            isLoading={isLoading}
          />
        </div>
      </div>
    </main>
  )
}
