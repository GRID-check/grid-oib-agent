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
 *   - The filename is what `generatedFilename` actually returns for the title
 *     „Fluchtweglängen Gebäudeklasse 4", not what a German writer would type.
 *     The slugger NFKD-normalises and strips combining marks, so `ä` becomes
 *     `a` — NOT `ae`; only `ß` is transliterated, because it decomposes to
 *     nothing and would otherwise vanish mid-word. Hence `fluchtweglangen`,
 *     `gebaudeklasse`. Writing the German transliteration here would have made
 *     this preview disagree with every real filed report, which is the one
 *     thing a fixture must not do.
 */
const GENERATED_FIXTURE: FileItem = {
  id: 'dev-doc-generated',
  filename: 'fluchtweglangen-gebaudeklasse-4-2026-06-14.pdf',
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

/**
 * The three text-shaped documents, which are the formats that had no viewer at
 * all: they drew the same grey "download it to read it" page mock as a `.dwg`,
 * although the bytes ARE the content. Three fixtures rather than one, because
 * the whole argument for rendering them separately is that a Markdown checklist
 * read as headings and boxes is a checklist and read as asterisks is a diff.
 */
const TEXT_FIXTURES: Record<'markdown' | 'csv' | 'text', FileItem> = {
  markdown: {
    id: 'dev-doc-md',
    filename: 'Bueroablauf_Einreichplanung.md',
    displayName: null,
    fileSize: 2_140,
    contentType: 'text/markdown',
    status: 'ready',
    folderId: null,
    createdAt: '2026-06-14T09:00:00Z',
    errorMessage: null,
    summary: 'Interne Checkliste für die Einreichplanung, Stand Juni 2026.',
    pageCount: null,
    chunkCount: 4,
    contentTypes: ['text'],
    tags: ['Checkliste'],
  },
  csv: {
    id: 'dev-doc-csv',
    filename: 'U-Werte_Bauteilkatalog.csv',
    displayName: null,
    fileSize: 860,
    contentType: 'text/csv',
    status: 'ready',
    folderId: null,
    createdAt: '2026-06-14T09:00:00Z',
    errorMessage: null,
    summary: 'Bauteilkatalog mit U-Werten und den zugehörigen OIB-Anforderungen.',
    pageCount: null,
    chunkCount: 2,
    contentTypes: ['text', 'table'],
    tags: [],
  },
  text: {
    id: 'dev-doc-txt',
    filename: 'Protokoll_Bauverhandlung.txt',
    displayName: null,
    fileSize: 1_180,
    contentType: 'text/plain',
    status: 'ready',
    folderId: null,
    createdAt: '2026-06-14T09:00:00Z',
    errorMessage: null,
    summary: null,
    pageCount: null,
    chunkCount: 1,
    contentTypes: ['text'],
    tags: [],
  },
}

const MARKDOWN_BODY = `# Einreichplanung — Bürocheckliste

Gilt für alle Einreichungen in Oberösterreich ab **Juni 2026**.

## Vor der Abgabe

- [x] Lageplan mit Höhenkoten, Maßstab 1:500
- [x] Grundrisse aller Geschosse, 1:100
- [ ] Energieausweis nach OIB-RL 6
- [ ] Nachweis der zwei Fluchtwege je Nutzungseinheit (OIB-RL 2)

## Häufige Rückfragen der Behörde

| Thema | Fundstelle | Anmerkung |
| --- | --- | --- |
| Fluchtweglänge | OIB-RL 2, Pkt. 5.1.1 | max. 40 m im notwendigen Flur |
| Anleiterbarkeit | OIB-RL 2, Pkt. 5.2 | Ostfassade, Aufstellfläche prüfen |

> Bei Gebäudeklasse 4 ist das Sicherheitstreppenhaus früh mit der Feuerwehr
> abzustimmen — Nachbesserungen kosten hier regelmäßig zwei Wochen.
`

const CSV_BODY = `Bauteil;U-Wert [W/m²K];Anforderung OIB-6;Bewertung
Außenwand gegen Außenluft;0,20;0,35;erfüllt
Oberste Geschossdecke;0,15;0,20;erfüllt
Fenster (Uw);1,10;1,40;erfüllt
Kellerdecke;0,38;0,40;"knapp erfüllt, Nachweis beilegen"
Eingangstür;1,60;1,70;erfüllt
`

const TEXT_BODY = `Protokoll der Bauverhandlung
Wohnbau Nord, Linz — 14.06.2026, 09:00 Uhr

Anwesend:
  Bauwerberin      Wohnbau Nord GmbH, vertreten durch DI Huber
  Sachverständiger Amt der Oö. Landesregierung, DI Mayrhofer
  Nachbarn         Grundstück 412/3 und 412/7

Verhandlungsgegenstand
  Neubau eines Wohngebaeudes der Gebaeudeklasse 4 mit vier Wohneinheiten
  je Regelgeschoss, Errichtung in Brettsperrholz-Bauweise.

Ergebnis
  Keine Einwendungen der Nachbarn zur Bebauungshoehe. Der Sachverständige
  fordert die Vorlage des Rauchableitungsnachweises fuer das Treppenhaus
  binnen vier Wochen nach.
`

// Install the fetch shim at module scope (before any component effect fires) so
/**
 * A structured analysis exactly as the BFF hands it over (already normalized
 * to the display shape, snake_case only inside `segment`/`sheet` because that
 * is the ingestion schema's own vocabulary).
 */
const DEV_STRUCTURED = {
  schema_version: 4,
  registry: 'architecture+general@850c9b2d770a',
  segment: {
    domain: 'architecture',
    segment_type: 'floor_plan',
    title: 'Regelgeschoss',
    scale: '1:100',
    summary: 'Regelgeschoss mit vier Wohneinheiten um einen zentralen Erschließungskern.',
    entities: [
      { name: 'Wohnen/Essen', category: 'space', role: 'Aufenthalt', measure: '38,4 m²' },
      { name: 'Laubengang', category: 'circulation', role: 'Erschließung', measure: null },
      { name: 'Sicherheitstreppenhaus', category: 'circulation', role: null, measure: null },
      { name: 'Stützenraster 5,40 m', category: 'structure', role: null, measure: null },
      { name: 'Wärmepumpe Sole/Wasser', category: 'services', role: null, measure: null },
      {
        name: 'Schallschutz Wohnungstrennwand',
        category: 'building_physics',
        role: 'R′w 55 dB',
        measure: null,
      },
      { name: 'Brettsperrholz', category: 'material', role: null, measure: null },
    ],
    compositions: [
      {
        component: 'Außenwand',
        layers: [
          { material: 'Lärchenschalung', thickness: '24 mm', function: 'Witterungsschutz' },
          { material: 'Mineralwolle', thickness: '200 mm', function: 'Dämmung' },
          { material: 'Brettsperrholz', thickness: '100 mm', function: 'tragend' },
        ],
      },
    ],
    states: [
      { element: 'Bestandsmauer Hof', state: 'existing' },
      { element: 'Laubengang', state: 'new' },
    ],
    quantities: [
      {
        object: 'Bausubstanz erhalten',
        property: 'Anteil',
        value: '71',
        unit: '%',
        source: 'text',
        confidence: 'high',
      },
      {
        object: 'Wohneinheiten',
        property: 'Anzahl',
        value: '4',
        unit: null,
        source: 'visual',
        confidence: 'high',
      },
    ],
    relations: [
      { subject: 'Laubengang', relation: 'erschließt', object: 'alle vier Wohneinheiten' },
    ],
    annotations: ['5,40', '38,4 m²'],
    source: 'visual',
    confidence: 'medium',
  },
  document: {
    title: 'Wohnbau Nord',
    subtitle: 'Transformation eines Bestandsbaus',
    slogans: ['ABRISS STOPPEN'],
    author: 'Arch. DI Huber',
    institution: 'TU Wien',
    supervision: null,
    location: 'Linz',
    strategies: ['Bestandserhalt', 'Vorfertigung'],
    process_steps: ['Abriss stoppen', 'Bestand transformieren', 'gemeinschaftlich wohnen'],
  },
}

// the pane's preview / visual-details fetches always resolve. Idempotent +
// dev/browser-guarded.
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __filePreviewShim?: boolean }
  if (!w.__filePreviewShim) {
    w.__filePreviewShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (/\/api\/documents\/.+\/preview$/.test(url)) {
        return Response.json({ url: PAGE_SVG })
      }
      // The text route answers with the CONTENT, not a URL — the object store
      // publishes no CORS policy, so a presigned link is unreadable to a fetch.
      const textMatch = /\/api\/documents\/(.+)\/text$/.exec(url)
      if (textMatch) {
        const body =
          textMatch[1] === 'dev-doc-csv'
            ? CSV_BODY
            : textMatch[1] === 'dev-doc-txt'
              ? TEXT_BODY
              : MARKDOWN_BODY
        return Response.json({ text: body, truncated: textMatch[1] === 'dev-doc-txt' })
      }
      if (/\/api\/documents\/.+\/visual-details$/.test(url)) {
        return Response.json({
          details: [
            {
              page: 3,
              contentType: 'drawing',
              drawingType: 'site_plan',
              scale: '1:500',
              segment: 0,
              text: 'Lageplan mit Feuerwehraufstellflächen, Löschwasserentnahmestellen und Zufahrten.',
              structured: null,
            },
            // Two segments off ONE sheet — the case the per-drawing indexing
            // exists for — the second carrying the full structured analysis so
            // the advanced disclosure has something to show.
            {
              page: 7,
              contentType: 'drawing',
              drawingType: 'floor_plan',
              scale: '1:100',
              segment: 0,
              text: 'Regelgeschoss mit eingetragenen Fluchtwegen und Brandabschnittsgrenzen (REI 90).',
              structured: DEV_STRUCTURED,
            },
            {
              page: 7,
              contentType: 'drawing',
              drawingType: 'section',
              scale: '1:50',
              segment: 1,
              text: 'Querschnitt durch das Atrium mit Galerieebenen und Oberlicht.',
              structured: null,
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
  //
  // `?variant=markdown|csv|text` swaps in a text-shaped document, for the same
  // reason: same dialog, same shim, the file is the only variable. The `text`
  // one is served truncated on purpose — a viewer that silently shows the first
  // half of a document is worse than one that shows none of it, so the notice
  // under the page is part of the surface and has to be photographed.
  const params = use(searchParams)
  const authored = params.authored
  const variant = typeof params.variant === 'string' ? params.variant : undefined
  const textFixture =
    variant === 'markdown' || variant === 'csv' || variant === 'text'
      ? TEXT_FIXTURES[variant]
      : null

  return (
    <FilePreviewDialog
      file={textFixture ?? (authored === 'agent' ? GENERATED_FIXTURE : FIXTURE)}
      projectId="proj-demo"
      projectName="Wohnbau Nord — Linz"
      canManage
      // Keep the modal open for the screenshot (fixture state is constant).
      onClose={() => {}}
    />
  )
}
