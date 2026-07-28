'use client'

/**
 * Source-list dev preview: the research panel's citation list (CitationCard),
 * the surface that used to render each source as an INDEPENDENT card — no
 * provenance tint, no authority badge, no page, and inert for anything without
 * a URL, which is every knowledge-base document.
 *
 * It now renders through the same component as the answer's "Belegt durch"
 * chips (`SourcePreviewChip`, `variant="card"`), so this preview is the
 * evidence that one source looks and behaves the same in both places:
 *
 *   • an OIB corpus document — indigo `oib` accent, "OIB" badge, openable;
 *   • a RIS legal source     — law tint, "RIS" badge, links out;
 *   • an org Archiv document — office tint, openable (was unopenable at all);
 *   • a project upload       — project tint, openable;
 *   • a web page             — neutral tint, links out;
 *   • a bare tool result     — neutral tint, WRENCH icon, no badge: a
 *                              computation, not a document.
 *
 * The first three are shown in the CITED state (check marker) and the rest as
 * merely discovered, which is the distinction the panel's two sub-tabs make.
 *
 * Not linked anywhere; the `/dev` server layout 404s it outside development.
 */

import { CitationCard } from '@/features/layout/components/CitationCard'
import type { CitationSource } from '@/features/chat/types'

const at = new Date('2026-07-28T14:30:00')

const sources: CitationSource[] = [
  {
    id: 'oib',
    content: '[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.12',
    citationKey: 'oib-rl_2_ausgabe_mai_2023.pdf, p.12',
    fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
    page: 12,
    title: 'OIB-Richtlinie 2 – Brandschutz, Ausgabe Mai 2023',
    origin: 'kb',
    kind: 'baurecht',
    lane: 'baurecht_oib',
    laneLabel: 'OIB-Richtlinie',
    sourceType: 'knowledge_layer',
    collection: 'oib_knowledge',
    number: 1,
    isCited: true,
    timestamp: at,
  },
  {
    id: 'ris',
    url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006',
    content: '[RIS] Bauordnung für Wien § 108',
    title: 'Bauordnung für Wien § 108 — Fluchtwege',
    origin: 'ris',
    kind: 'baurecht',
    lane: 'baurecht_land',
    laneLabel: 'Landesrecht',
    bindingNote: 'Macht die OIB-Richtlinien in Wien verbindlich (WBTV 2020).',
    number: 2,
    isCited: true,
    timestamp: at,
  },
  {
    id: 'archiv',
    content: '[KB] Buero_Detail_Attika_Standard.pdf, p.2',
    citationKey: 'Buero_Detail_Attika_Standard.pdf, p.2',
    fileName: 'Buero_Detail_Attika_Standard.pdf',
    page: 2,
    title: 'Attika-Standarddetail (Büroarchiv)',
    origin: 'kb',
    kind: 'buero',
    lane: 'buero',
    laneLabel: 'Büroarchiv',
    sourceType: 'knowledge_layer',
    collection: 'archiv_demo',
    number: 3,
    isCited: true,
    timestamp: at,
  },
  {
    id: 'projekt',
    content: '[KB] Einreichplan_OG_rev04.pdf, p.4\nDer Einreichplan zeigt die Lage der Fluchtwege im Obergeschoss.',
    citationKey: 'Einreichplan_OG_rev04.pdf, p.4',
    fileName: 'Einreichplan_OG_rev04.pdf',
    page: 4,
    title: 'Einreichplan Obergeschoss, Rev. 04',
    origin: 'kb',
    kind: 'projekt',
    lane: 'projekt',
    laneLabel: 'Projektwissen',
    sourceType: 'knowledge_layer',
    collection: 'proj_demo',
    isCited: false,
    timestamp: at,
  },
  {
    id: 'web',
    url: 'https://www.oib.or.at/de/oib-richtlinien',
    content: '[Web] OIB-Richtlinien — Übersicht',
    title: 'OIB-Richtlinien — Übersicht',
    origin: 'web',
    kind: 'web',
    lane: 'web',
    laneLabel: 'Web',
    isCited: false,
    timestamp: at,
  },
]

export default function SourceListPreviewPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6" data-testid="source-list-preview">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">Quellen</h1>
        <p className="text-sm text-muted-foreground">
          One citation, one behaviour — the research panel’s source list renders through the same
          component as the answer’s provenance chips.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {sources.map((citation, index) => (
          <CitationCard key={citation.id} citation={citation} index={index + 1} />
        ))}
      </div>
    </div>
  )
}
