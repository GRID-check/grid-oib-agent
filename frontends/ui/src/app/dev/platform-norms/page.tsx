'use client'

/**
 * Dev preview for the platform norm catalog. Renders the REAL NormRegistry on
 * fixture data so the rebuilt surface — SectionCard chrome, DataToolbar with
 * the rank/scope/open-review filters, the entry table with its staleness and
 * review signals, and the editing Sheet — can be reviewed and screenshotted
 * without a backend.
 *
 * A module-scope fetch shim (browser + dev only) serves the registry envelope
 * and the RIS verify call. Not linked from anywhere; 404s outside development.
 */

import { useEffect } from 'react'
import { NormRegistry } from '@/features/platform/components/norm-registry'

/** The remaining state building acts — enough rows that the pager appears. */
const stateAct = (
  id: string,
  short: string,
  title: string,
  bundesland: string,
  verifiedAt: string,
) => ({
  id,
  title,
  short,
  rank: 'landesgesetz',
  bundesland,
  topics: ['Bewilligung'],
  relevance: 'hoch',
  application: `Lr${short.slice(0, 4)}`,
  document_number: `Lr${id.slice(-4)}0000`,
  source_url: '',
  citation_url: `https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=Lr${id.slice(-4)}0000`,
  full_law_url: '',
  aliases: [],
  verify: { title_query: title, exclude: [] },
  verified_at: verifiedAt,
})

const ENTRIES = [
  {
    id: 'oib-rl2-2023',
    title: 'OIB-Richtlinie 2 — Brandschutz (Ausgabe 2023)',
    short: 'OIB-RL 2',
    rank: 'verordnung',
    bundesland: '',
    topics: ['Brandschutz', 'Fluchtwege'],
    relevance: 'hoch',
    application: 'BrKons',
    document_number: 'NOR40251234',
    source_url: '',
    citation_url: 'https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=NOR40251234',
    full_law_url: 'https://ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20001234',
    aliases: ['OIB 2', 'Richtlinie 2'],
    binding_note: 'In allen Bundesländern durch Verweis verbindlich gestellt.',
    verify: { title_query: 'OIB-Richtlinie 2', exclude: ['Entwurf'], gesetzesnummer: '20001234' },
    verified_at: '2026-05-12',
  },
  {
    id: 'bauo-wien',
    title: 'Bauordnung für Wien',
    short: 'BO Wien',
    rank: 'landesgesetz',
    bundesland: 'Wien',
    topics: ['Bewilligung', 'Bebauungsbestimmungen'],
    relevance: 'hoch',
    application: 'LrW',
    document_number: 'LrW40009876',
    source_url: '',
    citation_url: 'https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=LrW40009876',
    full_law_url: 'https://ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006',
    aliases: ['Wiener Bauordnung'],
    review_note: 'Novelle LGBl. 2026/14 einarbeiten — §§ 60 ff. prüfen.',
    verify: { title_query: 'Bauordnung für Wien', exclude: [] },
    verified_at: '2024-02-03',
  },
  {
    id: 'bauo-noe',
    title: 'NÖ Bauordnung 2014',
    short: 'NÖ BO',
    rank: 'landesgesetz',
    bundesland: 'Niederösterreich',
    topics: ['Bewilligung'],
    relevance: 'hoch',
    application: 'LrNO',
    document_number: 'LrNO40004321',
    source_url: '',
    citation_url: 'https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=LrNO40004321',
    full_law_url: '',
    aliases: [],
    verify: { title_query: 'NÖ Bauordnung 2014', exclude: [] },
    verified_at: '2026-06-30',
  },
  {
    id: 'bauo-stmk',
    title: 'Steiermärkisches Baugesetz',
    short: 'Stmk BauG',
    rank: 'landesgesetz',
    bundesland: 'Steiermark',
    topics: ['Bewilligung', 'Abstände'],
    relevance: 'mittel',
    application: 'LrStmk',
    document_number: 'LrStmk40001111',
    source_url: '',
    citation_url: 'https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=LrStmk40001111',
    full_law_url: '',
    aliases: [],
    verify: { title_query: 'Steiermärkisches Baugesetz', exclude: [] },
    verified_at: '',
  },
  {
    id: 'ma37-merkblatt-fluchtwege',
    title: 'MA 37 — Merkblatt Fluchtwege im Bestand',
    short: 'MA 37 FW',
    rank: 'behoerdliche_info',
    bundesland: 'Wien',
    topics: ['Fluchtwege', 'Bestand'],
    relevance: 'mittel',
    application: '',
    document_number: '',
    source_url: 'https://www.wien.gv.at/wohnen/baupolizei/merkblatt-fluchtwege.html',
    citation_url: '',
    full_law_url: '',
    aliases: [],
    review_note: 'Stand 2024 — bei der Baupolizei nachfragen, ob eine Neufassung vorliegt.',
    verified_at: '2025-11-08',
  },
  {
    id: 'oenorm-b-1600',
    title: 'ÖNORM B 1600 — Barrierefreies Bauen',
    short: 'ÖNORM B 1600',
    rank: 'norm_extern',
    bundesland: '',
    topics: ['Barrierefreiheit'],
    relevance: 'mittel',
    application: '',
    document_number: '',
    source_url: 'https://www.austrian-standards.at/oenorm-b-1600',
    citation_url: '',
    full_law_url: '',
    aliases: ['B 1600'],
    binding_note: 'Kein Volltext — nur über Austrian Standards beziehbar.',
    verified_at: '2026-01-20',
  },
  stateAct('bauo-ooe', 'OÖ BauO', 'Oö. Bauordnung 1994', 'Oberösterreich', '2026-04-11'),
  stateAct('bautg-sbg', 'Sbg BauTG', 'Salzburger Bautechnikgesetz', 'Salzburg', '2025-09-02'),
  stateAct('bauo-tirol', 'Tir BO', 'Tiroler Bauordnung 2022', 'Tirol', '2026-03-19'),
  stateAct('baug-vbg', 'Vbg BauG', 'Vorarlberger Baugesetz', 'Vorarlberg', '2023-08-15'),
  stateAct('bauo-ktn', 'Ktn BO', 'Kärntner Bauordnung 1996', 'Kärnten', '2026-02-27'),
  stateAct('bauo-bgld', 'Bgld BauG', 'Burgenländisches Baugesetz 1997', 'Burgenland', ''),
]

const VERIFY_RESPONSE = {
  candidates: [
    {
      title: 'Bauordnung für Wien — Fassung vom 01.07.2026',
      document_number: 'LrW40011223',
      citation_url: 'https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=LrW40011223',
      full_law_url: 'https://ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006',
    },
    {
      title: 'Bauordnung für Wien — Fassung vom 01.01.2024',
      document_number: 'LrW40009876',
      citation_url: 'https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=LrW40009876',
      full_law_url: 'https://ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006',
    },
  ],
  verified_at: '2026-07-28',
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const w = window as unknown as { __platformNormsShim?: boolean }
  if (!w.__platformNormsShim) {
    w.__platformNormsShim = true
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith('/api/platform/norms/verify')) {
        return Response.json(VERIFY_RESPONSE)
      }
      if (url.startsWith('/api/platform/norms')) {
        // A PUT echoes a bumped version, so the preview can exercise the
        // save round-trip without a backend.
        if (init?.method === 'PUT') return Response.json({ version: 8 })
        return Response.json({
          version: 7,
          registry: { version: 1, corpus_collection: 'oib_knowledge', entries: ENTRIES },
        })
      }
      return real(input, init)
    }
  }
}

export default function PlatformNormsDevPage(): JSX.Element {
  return <Preview />
}

function Preview(): JSX.Element {
  // The authoring flow is what this preview exists to show — the list is
  // already covered by the section screenshot. There is no prop to open the
  // editor, so drive the real affordance once the catalog has loaded, exactly
  // as a reviewer would.
  useEffect(() => {
    let cancelled = false
    const open = (): void => {
      if (cancelled) return
      const button = Array.from(document.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim().startsWith('New entry'),
      )
      if (button) button.click()
      else window.setTimeout(open, 100)
    }
    const handle = window.setTimeout(open, 300)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [])

  return (
    <main
      className="mx-auto flex max-w-4xl flex-col gap-6 p-8"
      data-testid="platform-norms-preview"
    >
      <div>
        <h1 className="text-lg font-semibold">Platform — Norm catalog</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The curated pointers to Austrian building law, rebuilt on the shared admin primitives.
        </p>
      </div>
      <NormRegistry />
    </main>
  )
}
