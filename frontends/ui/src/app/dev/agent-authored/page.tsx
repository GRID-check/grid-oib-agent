'use client'

/**
 * Dev preview for the agent-authored document surfaces — everything a reader
 * meets when Piloti has written a report into the project.
 *
 * Three blocks, in the order the reader meets them:
 *
 *  1. The filter strip, twice: at rest, and with `Unvergeben` + `Von Piloti`
 *     both engaged. The pair is the point — they are two questions (who is
 *     responsible / who wrote it) and they AND, which is what the lead clearing
 *     Unvergeben before an Einreichung actually asks.
 *  2. The card grid with a generated report among ordinary uploads: the quiet
 *     `Von Piloti erstellt` byline under the name, the neutral `Abgelegt`
 *     badge, and — in the footer, unchanged — the word `Unvergeben`. Provenance
 *     and responsibility on one card, never mistakable for each other.
 *  3. The preview pane for that report: the byline under the name, the
 *     assignment row two lines below it, and `Piloti dazu fragen` DISABLED with
 *     the hint that says why. That state is designed, not a gap — the report is
 *     deliberately not in the knowledge base.
 *
 * Pinned to German (`I18nProvider initialLocale="de" fixedLocale`): the copy
 * under review is the German copy, and without the pin the page renders in
 * whichever locale the capturing developer prefers. A module-scope fetch shim
 * (browser + dev only) 404s thumbnails so the deterministic SVG sketch fallback
 * renders, and serves the preview URL. 404s outside development.
 */

import { useState } from 'react'
import { notFound } from 'next/navigation'
import { I18nProvider } from '@/i18n'
import { FileBrowserPane } from '@/features/documents/components/file-browser-pane'
import { FileFilterStrip } from '@/features/documents/components/file-filter-strip'
import { FilePreviewPane } from '@/features/documents/components/file-preview-pane'
import type { FileItem } from '@/features/documents/components/project-file-workspace'

/** A rendered report page, inline, so the fixture needs no backend and no binary. */
const REPORT_PAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="700" viewBox="0 0 520 700">
       <rect width="520" height="700" fill="#ffffff"/>
       <rect x="40" y="44" width="300" height="18" rx="3" fill="#1f2937"/>
       <rect x="40" y="74" width="180" height="10" rx="3" fill="#9ca3af"/>
       <rect x="40" y="112" width="440" height="46" rx="4" fill="none" stroke="#c7cdd6" stroke-width="2"/>
       <rect x="54" y="128" width="220" height="9" rx="3" fill="#9ca3af"/>
       <rect x="40" y="192" width="440" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="214" width="440" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="236" width="330" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="286" width="200" height="12" rx="3" fill="#4b5563"/>
       <rect x="40" y="318" width="440" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="340" width="420" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="362" width="440" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="384" width="290" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="434" width="440" height="120" rx="4" fill="none" stroke="#c7cdd6" stroke-width="2" stroke-dasharray="6 6"/>
       <rect x="40" y="586" width="440" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="608" width="360" height="8" rx="3" fill="#d1d5db"/>
     </svg>`
  )

function makeFile(id: string, filename: string, summary: string, extra: Partial<FileItem> = {}): FileItem {
  return {
    id,
    filename,
    displayName: null,
    fileSize: 2_400_000,
    contentType: 'application/pdf',
    status: 'ready',
    folderId: null,
    createdAt: '2026-08-19T09:00:00Z',
    errorMessage: null,
    summary,
    pageCount: 24,
    chunkCount: 48,
    contentTypes: ['text', 'table'],
    tags: null,
    assignees: [],
    authoredBy: 'user',
    ...extra,
  }
}

/** The report Piloti wrote: never ingested, so `stored`, and nobody's yet. */
const GENERATED: FileItem = makeFile('g1', 'Tiefenrecherche_Fluchtwege-GK4.pdf', '', {
  status: 'stored',
  authoredBy: 'agent',
  fileSize: 780_000,
  // Everything below comes out of INGESTION, and this document was never
  // ingested: no summary, no page or chunk counts, no detected content types.
  // The fixture says so rather than inventing them, because the honest version
  // of this rail is what the preview has to look right with.
  summary: null,
  pageCount: null,
  chunkCount: null,
  contentTypes: null,
  createdAt: '2026-08-20T07:40:00Z',
})

const FILES: FileItem[] = [
  GENERATED,
  makeFile('p1', 'Brandschutzkonzept_Wohnbau-Nord.pdf', 'Brandschutzkonzept für den Wohnbau Nord (GK 4).', {
    fileSize: 3_800_000,
    assignees: [{ userId: 'u1', name: 'Anna Berger', email: 'anna@example.at', profilePictureUrl: null }],
  }),
  makeFile('p2', 'Fluchtwegplan_EG-2OG.pdf', 'Fluchtwegplan für Erdgeschoss bis 2. Obergeschoss.', {
    fileSize: 1_200_000,
  }),
  makeFile('p3', 'Energieausweis.pdf', 'Energieausweis mit Heizwärmebedarf und Effizienzklasse.', {
    status: 'processing',
    summary: '',
    fileSize: 900_000,
  }),
]

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __agentAuthoredShim?: boolean }
  if (!w.__agentAuthoredShim) {
    w.__agentAuthoredShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (/\/api\/documents\/.+\/thumbnail$/.test(url)) return new Response(null, { status: 404 })
      if (/\/api\/documents\/.+\/preview$/.test(url)) return Response.json({ url: REPORT_PAGE })
      if (/\/api\/assignments\/document\/.+\/candidates$/.test(url)) return Response.json({ candidates: [] })
      return real(input, init)
    }
  }
}

export default function AgentAuthoredDevPage(): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <AgentAuthoredFixtures />
    </I18nProvider>
  )
}

function AgentAuthoredFixtures(): JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-10 p-6" data-testid="agent-authored-preview">
      <div>
        <h1 className="text-lg font-semibold">Von Piloti erstellte Dateien</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Ein Bericht, den Piloti geschrieben hat, ist eine ganz normale unvergebene Datei — mit einer
          Zeile, die sagt, wer sie erstellt hat.
        </p>
      </div>

      {/* 1 — the strip, at rest and with both filters engaged. */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Filterleiste</h2>
        <div className="flex flex-col gap-3 rounded-xl border p-4">
          <FileFilterStrip
            canCollaborate
            assignmentFilter="all"
            onAssignmentFilterChange={() => {}}
            agentAuthoredOnly={false}
            onAgentAuthoredOnlyChange={() => {}}
          />
          <FileFilterStrip
            canCollaborate
            assignmentFilter="unassigned"
            onAssignmentFilterChange={() => {}}
            agentAuthoredOnly
            onAgentAuthoredOnlyChange={() => {}}
          />
        </div>
      </section>

      {/* 2 — the grid. First tile is the report; its footer still says Unvergeben. */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Dateien</h2>
        <div className="h-[460px] overflow-hidden rounded-xl border">
          <FileBrowserPane
            files={FILES}
            selectedFileId={selected}
            onSelectFile={setSelected}
            isLoading={false}
            projectId="proj-demo"
            showAssignment
          />
        </div>
      </section>

      {/* 3 — the preview: byline, assignment row, and Ask disabled with the
          hint that says why (hover the button to read it in a browser). */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Vorschau</h2>
        <div className="h-[620px] overflow-hidden rounded-xl border">
          <FilePreviewPane file={GENERATED} projectId="proj-demo" projectName="Wohnbau Nord — Linz" canCollaborate />
        </div>
      </section>
    </main>
  )
}
