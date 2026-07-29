'use client'

/**
 * Citation-interaction dev preview: what happens when you actually USE a
 * citation, rendered through the real `AgentResponse`.
 *
 * The three things this surface exists to show, all of which were missing:
 *
 *   1. AN INLINE `[N]` IS A CITATION, NOT A SCROLL LINK. It is tinted by the
 *      provenance family of the source it names, so a claim backed by binding
 *      law and one backed by a web page do not look identical mid-sentence.
 *      Clicking previews it in place — document, authority, page, passage —
 *      instead of moving the page and leaving the reader to work out where
 *      they landed.
 *   2. THE CHIP ANSWERS BACK. Activating a marker marks its chip, so the link
 *      between the claim in the prose and the source under it is something you
 *      SEE. Previously eight near-identical chips and a silent scroll.
 *   3. THE PASSAGES ARE REACHABLE. A document read at four pages opens with a
 *      Fundstellen rail; each page is a button, and the one you are reading is
 *      marked. Before, the viewer opened at whichever page happened to be first
 *      and there was no way to reach the other three.
 *
 * Not linked anywhere; the `/dev` server layout 404s it outside development.
 */

import { useEffect, type FC, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
import type { CitationSource } from '@/features/chat/types'

const at = new Date('2026-07-28T14:30:00')
const OIB = 'oib-rl_2.1_ausgabe_mai_2023.pdf'

/** One structured wire source — one LOCUS of a document. */
const locus = (page: number, number: number, snippet?: string): CitationSource => ({
  id: `oib-${page}`,
  content: snippet ? `[KB] ${OIB}, p.${page}\n${snippet}` : `[KB] ${OIB}, p.${page}`,
  citationKey: `${OIB}, p.${page}`,
  documentId: `doc:oib_knowledge:${OIB}`,
  fileName: OIB,
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

const citations: CitationSource[] = [
  locus(
    5,
    1,
    'Garagen mit mehr als 250 m² Nutzfläche sind mit einer mechanischen Entlüftung auszustatten.'
  ),
  locus(12, 2, 'Der zweite Fluchtweg darf über eine Außentreppe geführt werden.'),
  locus(18, 3),
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
    number: 4,
    isCited: true,
    timestamp: at,
  },
]

/**
 * An answer whose prose cites the SAME Richtlinie at three pages plus a legal
 * source — the shape that made the old interaction impossible to follow.
 */
const answer = [
  'Für eine Garage dieser Größe sind zwei Fluchtwege erforderlich [1]. Der zweite',
  'darf als Außentreppe ausgeführt werden [2], sofern die Rauchableitung den',
  'Anforderungen der Richtlinie entspricht [3]. In Wien ist diese Richtlinie über',
  'die Bauordnung verbindlich gestellt [4].',
  '',
  '## Quellen',
  `- [1] [KB] ${OIB}, p.5`,
  `- [2] [KB] ${OIB}, p.12`,
  `- [3] [KB] ${OIB}, p.18`,
  '- [4] [RIS] Bauordnung für Wien § 108 — https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006',
].join('\n')

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
    {children}
  </section>
)

/**
 * Opens a marker's peek before the screenshot harness captures.
 *
 * The harness captures a page at rest, so the popover and the document dialog —
 * the two surfaces this work actually adds — never appeared in any committed
 * screenshot. `?open=peek` clicks the first marker once the answer has
 * rendered, which is the only way to get those states on film.
 */
const OpenOnLoad: FC = () => {
  const params = useSearchParams()
  const which = params?.get('open')

  useEffect(() => {
    if (!which) return
    // One frame after paint: the marker exists only once the markdown body and
    // the citation scope have both rendered.
    const timer = window.setTimeout(() => {
      const markers = document.querySelectorAll<HTMLButtonElement>('[data-citation-marker]')
      const target = which === 'dialog' ? markers[1] : markers[0]
      target?.click()
    }, 150)
    return () => window.clearTimeout(timer)
  }, [which])

  return null
}

export default function CitationInteractionPreview() {
  return (
    <div
      data-testid="citation-interaction-preview"
      className="mx-auto flex w-full max-w-4xl flex-col gap-8 p-8"
    >
      <OpenOnLoad />
      <Block
        title="Inline markers are citations"
        note="Each [N] is tinted by the provenance family of the source it names — three OIB passages and one binding legal source, distinguishable mid-sentence. Clicking one previews the document, its authority, its page and the passage itself, and marks the chip it belongs to."
      >
        <AgentResponse
          content={answer}
          messageId="preview-1"
          citations={citations}
          routingDecision="deep"
          answerConfidence="high"
        />
      </Block>

      <Block
        title="The same answer, inline variant"
        note="The compact bubble used inside a running thread. Same markers, same chips, same behaviour — a citation must not depend on which shell renders it."
      >
        <AgentResponse
          content={answer}
          messageId="preview-2"
          citations={citations}
          routingDecision="deep"
          variant="inline"
        />
      </Block>
    </div>
  )
}
