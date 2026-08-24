'use client'

/**
 * Dev preview for the platform base-knowledge manager (ADR-0016), rebuilt on the
 * shared admin primitives. Renders the REAL component with fixture data so the
 * corpus summary, the toolbar, the sortable table with its selection column and
 * the pagination can be reviewed and screenshotted without a backend. A
 * module-scope fetch shim (browser + dev only) serves the corpus status. Not
 * linked from anywhere and 404s outside development.
 */

import { BaseKnowledge } from '@/app/app/(shell)/platform/base-knowledge'

const DOC_CLASSES = [
  'oib_richtlinie',
  'oib_leitfaden',
  'oib_erlaeuterung',
  'oib_begriffe',
  'oib_referenz',
  'oib_aenderung',
  'norm_extern',
  'gesetz',
  'sonstiges',
]

const TITLES = [
  'OIB-Richtlinie 2 — Brandschutz, Ausgabe 2023',
  'OIB-Leitfaden Barrierefreiheit',
  'OIB-Erläuterungen zu Richtlinie 4',
  'OIB-Begriffsbestimmungen 2023',
  'OIB-Referenzdokument Energieausweis',
  'OIB-Änderungsdokument 2023/2019',
  'ÖNORM B 1600 — Barrierefreies Bauen',
  'Wiener Bauordnung — Konsolidierte Fassung',
  'Praxisnotiz Fluchtwegbreiten',
  'OIB-Richtlinie 3 — Hygiene, Ausgabe 2023',
  'OIB-Richtlinie 5 — Schallschutz, Ausgabe 2023',
  'ÖNORM B 8110-1 — Wärmeschutz',
  'Niederösterreichische Bautechnikverordnung',
  'Merkblatt Rauchwarnmelder',
]

// 14 rows: more than one page (10), so the pager is exercised in the shot.
const FILES = TITLES.map((title, index) => ({
  fileName: `base-dokument-${String(index + 1).padStart(2, '0')}.pdf`,
  state: index === 3 ? 'pending' : index === 8 ? 'stale' : 'ingested',
  origin: index >= 11 ? 'uploaded' : 'corpus',
  sizeBytes: 240_000 + index * 61_000,
  chunkCount: index === 3 ? 0 : 38 + index * 11,
  ingestedSha256: null,
  currentSha256: null,
  ingestedAt: '2026-07-14T09:00:00Z',
  summary: null,
  docClass: DOC_CLASSES[index % DOC_CLASSES.length],
  displayTitle: title,
}))

const STATUS = {
  collectionName: 'oib_base',
  collectionExists: true,
  collectionUpdatedAt: '2026-07-20T09:00:00Z',
  summary: {
    totalFiles: FILES.length,
    ingested: FILES.filter((f) => f.state === 'ingested').length,
    stale: FILES.filter((f) => f.state === 'stale').length,
    pending: FILES.filter((f) => f.state === 'pending').length,
    snapshot: 0,
    removed: 0,
    inconsistent: 0,
    totalChunks: FILES.reduce((sum, f) => sum + f.chunkCount, 0),
  },
  files: FILES,
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformKnowledgeShim?: boolean }
  if (!w.__platformKnowledgeShim) {
    w.__platformKnowledgeShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/knowledge-base')) {
        return Response.json(STATUS)
      }
      return real(input, init)
    }
  }
}

export default function PlatformKnowledgeDevPage(): JSX.Element {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-8" data-testid="platform-knowledge-preview">
      <div>
        <h1 className="text-lg font-semibold">Platform — Base knowledge</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Platform-owner surface: the shared OIB corpus every project grounds its answers on — search, filter,
          sort, select and page through it, with each document’s detail in a sheet.
        </p>
      </div>
      <BaseKnowledge />
    </main>
  )
}
