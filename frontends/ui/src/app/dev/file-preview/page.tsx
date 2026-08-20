'use client'

/**
 * Dev preview for the FilePreviewDialog (the one file-preview modal used across
 * the app). Renders the REAL dialog OPEN with a rich fixture — a long
 * multi-paragraph summary, many key-value props, several tags and a populated
 * visual-details section — so the responsive scroll behavior is genuinely
 * exercised: on the mobile sheet ALL metadata must be reachable below the capped
 * preview, and on desktop the split's two columns must scroll independently.
 *
 * A module-scope fetch shim (browser + dev only) serves the preview URL and the
 * visual-details payload so the pane renders fully backend-free. Not linked from
 * anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { use } from 'react'
import { FilePreviewDialog } from '@/features/documents/components/file-preview-dialog'
import type { FileItem } from '@/features/documents/components/project-file-workspace'

// A visible "document page" so the left preview renders something real (not a
// blank iframe) in the screenshot. Encoded as an SVG data URI, backend-free.
const PAGE_SVG =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="700" viewBox="0 0 520 700">
       <rect width="520" height="700" fill="#ffffff"/>
       <rect x="40" y="48" width="240" height="16" rx="3" fill="#1f2937"/>
       <rect x="40" y="76" width="150" height="10" rx="3" fill="#9ca3af"/>
       <rect x="40" y="128" width="440" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="150" width="440" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="172" width="360" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="230" width="440" height="220" rx="6" fill="none" stroke="#c7cdd6" stroke-width="2" stroke-dasharray="6 6"/>
       <path d="M120 400 L200 300 L280 360 L360 280 L440 380" fill="none" stroke="#6b7280" stroke-width="3"/>
       <rect x="40" y="500" width="440" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="522" width="400" height="8" rx="3" fill="#d1d5db"/>
       <rect x="40" y="544" width="420" height="8" rx="3" fill="#d1d5db"/>
     </svg>`
  )

const FIXTURE: FileItem = {
  id: 'dev-doc-1',
  filename: 'Brandschutzkonzept_Wohnbau-Nord_Gebaeudeklasse-4.pdf',
  displayName: null,
  fileSize: 4_820_000,
  contentType: 'image/png',
  status: 'ready',
  folderId: null,
  createdAt: '2026-06-14T09:00:00Z',
  errorMessage: null,
  summary:
    'Brandschutzkonzept für den Wohnbau Nord (Gebäudeklasse 4) nach OIB-Richtlinie 2 (2023). ' +
    'Das Dokument weist die beiden voneinander unabhängigen Fluchtwege je Nutzungseinheit nach: ' +
    'der erste über den notwendigen Flur ins nördliche Sicherheitstreppenhaus, der zweite über die ' +
    'anleiterbaren Fenster der Feuerwehr an der Ostfassade. Die maximale Gehweglänge im notwendigen ' +
    'Flur beträgt 34 m und liegt damit unter dem Grenzwert von 40 m. ' +
    'Brandabschnitte sind mit REI 90 Trennwänden ausgeführt; die Wohnungstrennwände erreichen REI 60. ' +
    'Der Nachweis der Rauchableitung erfolgt über die Rauch- und Wärmeabzugsanlage im Treppenhaus ' +
    'mit einer aerodynamisch wirksamen Öffnungsfläche von 1,0 m². ' +
    'Löschwasserversorgung, Feuerwehraufstellflächen und die Kennzeichnung der Rettungswege sind ' +
    'im Lageplan Blatt 3 dokumentiert und mit der örtlichen Feuerwehr abgestimmt.',
  pageCount: 24,
  chunkCount: 58,
  contentTypes: ['text', 'table', 'drawing', 'image', 'chart'],
  tags: [
    'Grundriss',
    'Brandschutz',
    'Standsicherheit',
    'Nutzungssicherheit/Barrierefreiheit',
    'Schallschutz',
  ],
}

/**
 * The same pane holding a document PILOTI wrote, which is the state nothing had
 * ever photographed.
 *
 * Every difference from `FIXTURE` above is a consequence of one decision — a
 * machine-authored document is deliberately never dispatched to `/v1/ingest`
 * (`lib/documents/generated.ts`) — and the pane has to stay honest about all of
 * them at once:
 *
 *   - `status: 'stored'` is the only status `isNeverIndexedStatus` accepts. It
 *     is what greys „Piloti dazu fragen" and swaps its hint from „Sobald die
 *     Datei zitierbar ist" (a promise of a wait) to a sentence saying there is
 *     no wait coming.
 *   - `authoredBy: 'agent'` is what draws „Von Piloti erstellt" under the name.
 *   - No summary, no chunks, no tags, no content types — those are ingestion
 *     output, and no ingestion ran. Inventing them here would photograph a
 *     „Von Piloti indexiert" rail that the real document can never show.
 *   - The filename is the real shape `generatedFilename` produces:
 *     `slug(title)-YYYY-MM-DD.pdf`, lower-case, umlauts folded, from a title
 *     the model itself wrote.
 */
const GENERATED_FIXTURE: FileItem = {
  id: 'dev-doc-generated',
  filename: 'fluchtweglaengen-gebaeudeklasse-4-2026-06-14.pdf',
  displayName: null,
  fileSize: 128_400,
  contentType: 'application/pdf',
  status: 'stored',
  authoredBy: 'agent',
  folderId: null,
  createdAt: '2026-06-14T09:00:00Z',
  errorMessage: null,
  summary: null,
  pageCount: 6,
  chunkCount: 0,
  contentTypes: [],
  tags: [],
}

// Install the fetch shim at module scope (before any component effect fires) so
// the pane's preview / visual-details fetches always resolve. Idempotent +
// dev/browser-guarded.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __filePreviewShim?: boolean }
  if (!w.__filePreviewShim) {
    w.__filePreviewShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (/\/api\/documents\/.+\/preview$/.test(url)) {
        return Response.json({ url: PAGE_SVG })
      }
      if (/\/api\/documents\/.+\/visual-details$/.test(url)) {
        return Response.json({
          details: [
            {
              page: 3,
              contentType: 'drawing',
              drawingType: 'Lageplan',
              scale: '1:500',
              text: 'Lageplan mit Feuerwehraufstellflächen, Löschwasserentnahmestellen und Zufahrten.',
            },
            {
              page: 7,
              contentType: 'drawing',
              drawingType: 'Grundriss',
              scale: '1:100',
              text: 'Regelgeschoss mit eingetragenen Fluchtwegen und Brandabschnittsgrenzen (REI 90).',
            },
          ],
        })
      }
      return real(input, init)
    }
  }
}

export default function FilePreviewDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): JSX.Element {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }
  // `?authored=agent` swaps in the document Piloti wrote. One route rather than
  // two so the two states are photographed through the same dialog, with the
  // same shim and the same props — the only variable is the file.
  const authored = use(searchParams).authored

  return (
    <FilePreviewDialog
      file={authored === 'agent' ? GENERATED_FIXTURE : FIXTURE}
      projectId="proj-demo"
      projectName="Wohnbau Nord — Linz"
      canManage
      // Keep the modal open for the screenshot (fixture state is constant).
      onClose={() => {}}
    />
  )
}
