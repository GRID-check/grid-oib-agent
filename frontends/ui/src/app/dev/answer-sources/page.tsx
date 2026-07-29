'use client'

/**
 * Answer-sources dev preview: the "Belegt durch" provenance row, which is where
 * the two-level citation model becomes visible.
 *
 * The defect this surface existed to produce: an answer citing ONE Richtlinie
 * at four pages rendered FOUR rows — the first complete (display title, OIB
 * badge, indigo accent, openable) and the rest degraded to a raw corpus
 * filename with no badge and the wrong tint, because the structured citations
 * were deduplicated to the DOCUMENT level and then matched one-to-one against
 * the answer's written source list, which is at the LOCUS level.
 *
 * Each block below is a case that used to break, rendered through the real
 * component with fixture data:
 *
 *   1. ONE DOCUMENT, FOUR PAGES — one chip, "S. 5, 12, 18, 22", markers 1–4.
 *      Every inline [N] anchors to it; nothing is degraded and nothing is lost.
 *   2. MIXED PROVENANCE — OIB corpus, RIS, Büroarchiv, project upload and a web
 *      page side by side, each in its own family with its authority badge.
 *   3. WRITTEN LIST ONLY — the answer's `## Quellen` section with no structured
 *      wire at all. This is the case that produced the raw filenames; it now
 *      resolves to the same title, tint and badge as the structured path.
 *   4. NO SOURCES — the honest "Lücke" row a substantive but ungrounded answer
 *      must show instead of quietly rendering nothing.
 *
 * Not linked anywhere; the `/dev` server layout 404s it outside development.
 */

import type { FC, ReactNode } from 'react'
import { AnswerSourcesRow } from '@/features/chat/components/AnswerSourcesRow'
import type { CitationSource } from '@/features/chat/types'
import type { ReportSourceEntry } from '@/features/layout/lib/report-citations'

const at = new Date('2026-07-28T14:30:00')

const OIB_FILE = 'oib-rl_2.1_ausgabe_mai_2023.pdf'

/** One structured wire source — one LOCUS of a document. */
const locus = (page: number, number: number): CitationSource => ({
  id: `oib-${page}`,
  content: `[KB] ${OIB_FILE}, p.${page}`,
  citationKey: `${OIB_FILE}, p.${page}`,
  documentId: `doc:oib_knowledge:${OIB_FILE}`,
  fileName: OIB_FILE,
  collection: 'oib_knowledge',
  title: 'OIB-Richtlinie 2.1, Ausgabe Mai 2023',
  origin: 'kb',
  kind: 'baurecht',
  lane: 'baurecht_oib',
  laneLabel: 'OIB-Richtlinie',
  sourceType: 'knowledge_layer',
  page,
  number,
  isCited: true,
  timestamp: at,
})

/** The same loci as the answer's written `## Quellen` list spells them. */
const writtenEntry = (page: number, number: number): ReportSourceEntry => ({
  number,
  markdown: `${OIB_FILE}, p.${page}`,
  sourceKind: 'kb',
})

const mixed: CitationSource[] = [
  locus(5, 1),
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
    collection: 'archiv_demo',
    title: 'Attika-Standarddetail',
    origin: 'kb',
    kind: 'buero',
    lane: 'buero',
    laneLabel: 'Büroarchiv',
    page: 2,
    number: 3,
    isCited: true,
    timestamp: at,
  },
  {
    id: 'projekt',
    content: '[KB] Brandschutzkonzept_Bauteil_A.pdf, p.7',
    citationKey: 'Brandschutzkonzept_Bauteil_A.pdf, p.7',
    fileName: 'Brandschutzkonzept_Bauteil_A.pdf',
    collection: 'proj_demo',
    origin: 'kb',
    kind: 'projekt',
    lane: 'projekt',
    laneLabel: 'Projektwissen',
    page: 7,
    number: 4,
    isCited: true,
    timestamp: at,
  },
  {
    id: 'web',
    url: 'https://www.wko.at/oe/gewerbe-handwerk/garagen',
    content: '[Web] Stellplatzverordnung — Überblick',
    title: 'Stellplatzverordnung — Überblick',
    origin: 'web',
    kind: 'web',
    lane: 'web',
    number: 5,
    isCited: true,
    timestamp: at,
  },
]

const Block: FC<{ title: string; note: string; children: ReactNode }> = ({
  title,
  note,
  children,
}) => (
  <section className="flex flex-col gap-2">
    <div>
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      <p className="max-w-2xl text-xs text-muted-foreground">{note}</p>
    </div>
    <div className="rounded-lg border bg-card p-4">{children}</div>
  </section>
)

export default function AnswerSourcesPreview() {
  return (
    <div
      data-testid="answer-sources-preview"
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-8"
    >
      <Block
        title="One document, four pages"
        note="One chip for one Richtlinie, carrying every [N] the prose uses; the pages it was read at are one click away in its popover. This rendered as FOUR rows — one complete, three degraded to a raw filename with no badge and the wrong tint."
      >
        <AnswerSourcesRow
          citations={[locus(5, 1), locus(12, 2), locus(18, 3), locus(22, 4)]}
          sourceEntries={[
            writtenEntry(5, 1),
            writtenEntry(12, 2),
            writtenEntry(18, 3),
            writtenEntry(22, 4),
          ]}
          anchorPrefix="answer-source-preview-a-"
          routingDecision="deep"
        />
      </Block>

      <Block
        title="Mixed provenance"
        note="Each family in its own tint with its authority badge: OIB corpus, RIS legal source, Büroarchiv, project upload, web page."
      >
        <AnswerSourcesRow
          citations={mixed}
          anchorPrefix="answer-source-preview-b-"
          routingDecision="deep"
        />
      </Block>

      <Block
        title="Written source list only — no structured wire"
        note="The answer's own ## Quellen section, with nothing from the citation wire. This is the case that produced raw filenames; it now resolves to the same title, tint and badge as the structured path."
      >
        <AnswerSourcesRow
          sourceEntries={[writtenEntry(9, 1), writtenEntry(14, 2)]}
          anchorPrefix="answer-source-preview-c-"
          routingDecision="shallow"
        />
      </Block>

      <Block
        title="No sources — the honest gap"
        note="A substantive answer that cites nothing says so, in the neutral family. It never hides its lack of grounding."
      >
        <AnswerSourcesRow routingDecision="shallow" />
      </Block>
    </div>
  )
}
