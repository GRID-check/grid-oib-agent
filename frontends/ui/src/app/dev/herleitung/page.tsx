'use client'

/**
 * Herleitung dev preview: renders the REAL ChatThinking (reasoning trace)
 * expanded, with fixture steps/sources/citations, so the redesigned graph can be
 * reviewed and screenshotted (visual/registry.mjs → `herleitung`). Not linked
 * anywhere and 404s outside development.
 *
 * The desktop instance is wrapped in the SAME `w-[680px] max-w-full` box the
 * real thread uses (ChatArea's assistant-side spine). Without that the preview
 * rendered ~90px wider than production and made the fan-out look like it fitted
 * when in the real chat it did not.
 *
 * `?variant=` selects the captured scenario:
 *   - (none)   → framing → parallel sources → assessment (findings converge).
 *   - dense    → a research-heavy turn (9 documents across 5 lanes): more
 *     sources than fit in one row, so the fan packs into stacked COLUMNS
 *     instead of degrading to a single vertical chain.
 *   - branches → a live choice prompt WITHOUT findings, so the sources fan IN to
 *     the branches node directly (per-source handles, no single-point collapse);
 *     a long question + many branch options exercise the measured, content-driven
 *     layout (tall nodes must not overlap).
 *   - live     → a turn mid-stream: completed steps + an in-progress web search,
 *     so the live activity phrase, animated edges, executed-step chips (with the
 *     running pulse) and the elapsed pill all render.
 */

import { useEffect, useState } from 'react'
import { notFound } from 'next/navigation'
import { ChatThinking } from '@/features/chat/components/ChatThinking'
import type { ThinkingStep, CitationSource } from '@/features/chat/types'

const step: ThinkingStep = {
  id: 'kb',
  userMessageId: 'msg-1',
  category: 'tools',
  functionName: 'knowledge_retrieval',
  displayName: 'Knowledge Retrieval',
  content: '',
  isComplete: true,
  timestamp: new Date('2024-01-15T14:30:00'),
  traceLanes: [
    {
      key: 'baurecht_oib',
      label: 'OIB-Richtlinie',
      hitCount: 3,
      signal: 'law',
      sources: [
        { name: 'OIB-RL_2_Brandschutz.pdf', detail: 'Fluchtwege, Pkt. 3.2' },
        { name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.18' },
      ],
    },
    {
      key: 'baurecht_ris',
      label: 'Bundesrecht',
      hitCount: 2,
      signal: 'law',
      sources: [{ name: 'Bauordnung für Wien', detail: '§ 108 Fluchtwege' }],
    },
    {
      key: 'projekt',
      label: 'Projektwissen',
      hitCount: 1,
      signal: 'project',
      sources: [{ name: 'Grundriss_EG.pdf', detail: 'Seite 2' }],
    },
    {
      key: 'buero',
      label: 'Büroarchiv',
      hitCount: 1,
      signal: 'office',
      sources: [{ name: 'Brandschutzkonzept_2023.pdf', detail: 'Referenzprojekt' }],
    },
  ],
}

/**
 * What the ANSWER cited, as opposed to what retrieval merely returned.
 *
 * These name the same documents the lanes above hold, so the fan-out can mark
 * which cards became `[1]` and `[2]` and leave the rest reading "gelesen, nicht
 * verwendet" — the distinction the trace could not draw while it was built from
 * the retrieval half alone.
 */
const citations: CitationSource[] = [
  {
    id: 'c1',
    content: '[KB] OIB-RL_2_Brandschutz.pdf, p.18',
    citationKey: 'OIB-RL_2_Brandschutz.pdf, p.18',
    fileName: 'OIB-RL_2_Brandschutz.pdf',
    collection: 'oib_knowledge',
    title: 'OIB-Richtlinie 2 – Brandschutz',
    origin: 'kb',
    timestamp: new Date('2024-01-15T14:30:00'),
    kind: 'baurecht',
    lane: 'baurecht_oib',
    laneLabel: 'OIB-Richtlinie',
    page: 18,
    number: 1,
    isCited: true,
  },
  {
    id: 'c2',
    content: '[RIS] Bauordnung für Wien § 108',
    url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=LrW&Gesetzesnummer=20000006',
    title: 'Bauordnung für Wien',
    origin: 'ris',
    timestamp: new Date('2024-01-15T14:30:00'),
    kind: 'baurecht',
    lane: 'baurecht_ris',
    laneLabel: 'Bundesrecht',
    number: 2,
    isCited: true,
  },
]

/**
 * The retrieval statuses the turn emitted, as the backend states them: a key
 * plus values, never a sentence. They drive the „Gesucht" list — the part of a
 * finished Herleitung that says what was actually asked of which corpus, and
 * which the panel used to show only while the turn was live and then discard.
 */
const retrievalSteps: ThinkingStep[] = [
  {
    ...step,
    id: 'retrieval-0',
    functionName: 'status:retrieval:0',
    displayName: 'status:retrieval:0',
    content: JSON.stringify({
      kind: 'status',
      channel: 'live',
      slot: 'retrieval:0',
      key: 'status.retrieval.withQuery',
      values: { corpus: 'knowledge', query: 'Rettungswege Gebäudeklasse 4 Büro' },
    }),
  },
  {
    ...step,
    id: 'retrieval-1',
    functionName: 'status:retrieval:1',
    displayName: 'status:retrieval:1',
    content: JSON.stringify({
      kind: 'status',
      channel: 'live',
      slot: 'retrieval:1',
      key: 'status.retrieval.withQuery',
      values: { corpus: 'ris', query: 'Wiener Bauordnung § 106 Fluchtwege' },
    }),
  },
]

const defaultCommon = {
  steps: [step, ...retrievalSteps],
  isThinking: false as const,
  defaultOpen: true,
  userQuestion:
    'Wie viele Rettungswege brauche ich für ein Bürogebäude der Gebäudeklasse 4 in Wien?',
  answerConfidence: 'high' as const,
  citations,
  enabledDataSources: ['OIB-Korpus', 'RIS', 'Projektdokumente'],
  messageFiles: [{ id: 'f1', fileName: 'Grundriss_EG.pdf' }],
  routingDecision: 'shallow' as const,
  routingReason:
    'konkrete Frage zu OIB-Richtlinie 2 (Brandschutz), kein Bedarf für Tiefenrecherche',
}

// Dense scenario: what a real Tiefenrecherche turn looks like — nine documents
// across five lanes. This is the case the old layout got wrong: the single-row
// fan needed ~1.4k px, did not fit the 680px thread column, and collapsed the
// whole graph into one vertical list. It must now pack into stacked columns.
const denseStep: ThinkingStep = {
  ...step,
  id: 'kb-dense',
  traceLanes: [
    {
      key: 'baurecht_oib',
      label: 'OIB-Richtlinie',
      hitCount: 5,
      signal: 'law',
      sources: [
        { name: 'oib-rl_2_ausgabe_mai_2023.pdf', detail: 'p.12' },
        { name: 'oib-rl_2.3_ausgabe_mai_2023.pdf', detail: 'p.4' },
        { name: 'oib-rl_4_ausgabe_mai_2023.pdf', detail: 'p.9' },
      ],
    },
    {
      key: 'baurecht_oib_erlaeuterung',
      label: 'OIB-Erläuterung',
      hitCount: 2,
      signal: 'law',
      sources: [{ name: 'erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf', detail: 'p.7' }],
    },
    {
      key: 'baurecht_ris',
      label: 'Bundesrecht',
      hitCount: 3,
      signal: 'law',
      sources: [
        { name: 'Bauordnung für Wien', detail: '§ 108 Fluchtwege' },
        { name: 'Wiener Garagengesetz', detail: '§ 4' },
      ],
    },
    {
      key: 'projekt',
      label: 'Projektwissen',
      hitCount: 2,
      signal: 'project',
      sources: [
        { name: 'Grundriss_EG.pdf', detail: 'Seite 2' },
        { name: 'Schnitt_A-A.pdf', detail: 'Seite 1' },
      ],
    },
    {
      key: 'buero',
      label: 'Büroarchiv',
      hitCount: 1,
      signal: 'office',
      sources: [{ name: 'Brandschutzkonzept_2023.pdf', detail: 'Referenzprojekt' }],
    },
  ],
}

const denseCommon = {
  ...defaultCommon,
  steps: [denseStep],
  routingDecision: 'deep' as const,
  routingReason:
    'mehrteilige Frage über Rettungswege, Garagen und Bestandsschutz — Tiefenrecherche über mehrere Richtlinien und Landesrecht',
}

// Branches scenario: a live choice prompt and NO findings, so the parallel
// sources converge directly onto the branches node. A long question and four
// branch options make the framing + branches nodes tall — the measured layout
// must place them without overlap.
const branchesCommon = {
  steps: [step],
  isThinking: false as const,
  defaultOpen: true,
  userQuestion:
    'Für ein sechsgeschossiges Bürogebäude der Gebäudeklasse 5 in Wien mit einer Bruttogeschossfläche von 1.200 m² pro Ebene: Wie viele bauliche Rettungswege sind nach OIB-Richtlinie 2 erforderlich, und welche Anforderungen gelten für die maximale Fluchtweglänge sowie die Ausbildung der Treppenhäuser?',
  enabledDataSources: ['OIB-Korpus', 'RIS', 'Projektdokumente'],
  routingDecision: 'deep' as const,
  routingReason:
    'mehrteilige Frage mit Bezug auf Geschossanzahl, Flächen und Treppenhausausbildung — Tiefenrecherche über mehrere OIB-Richtlinien erforderlich',
  escalationReason: 'shallow→deep',
  choicePrompt: {
    promptId: 'p-dev',
    text: 'Wie möchtest du die Rettungsweg-Prüfung fortsetzen?',
    options: [
      'Fluchtweglängen für jede Ebene einzeln prüfen',
      'Treppenhaus-Anforderungen (Sicherheitstreppenhaus) vertiefen',
      'Vergleich mit dem Referenzprojekt aus dem Büroarchiv',
      'Zusammenfassung aller OIB-Anforderungen als Checkliste',
    ],
    isResponded: false,
  },
}

// Live scenario: a turn mid-stream — a completed classification, the KB hit,
// and an in-progress web search. Exercises the live activity phrase (shown only
// while the step actually runs), the animated edges, the executed-step chips
// with the running pulse, and the elapsed-time pill.
const liveCommon = {
  steps: [
    {
      id: 'intent',
      userMessageId: 'msg-1',
      category: 'agents' as const,
      functionName: 'intent_classifier',
      displayName: 'Intent Classifier',
      content: '',
      isComplete: true,
      timestamp: new Date('2024-01-15T14:30:00'),
    },
    { ...step, id: 'kb' },
    {
      id: 'web',
      userMessageId: 'msg-1',
      category: 'tools' as const,
      functionName: 'web_search_tool',
      displayName: 'Web Search Tool',
      content: '',
      isComplete: false,
      timestamp: new Date('2024-01-15T14:30:05'),
    },
  ],
  isThinking: true as const,
  defaultOpen: true,
  userQuestion: defaultCommon.userQuestion,
  enabledDataSources: defaultCommon.enabledDataSources,
  routingDecision: 'shallow' as const,
  routingReason: defaultCommon.routingReason,
}

export default function HerleitungPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  // Read the requested variant after mount (not during render) so the fixture is
  // stable and screenshot-deterministic.
  const [variant, setVariant] = useState<string | null>(null)
  useEffect(() => {
    setVariant(new URLSearchParams(window.location.search).get('variant'))
  }, [])

  const common =
    variant === 'branches'
      ? branchesCommon
      : variant === 'live'
        ? liveCommon
        : variant === 'dense'
          ? denseCommon
          : defaultCommon
  const label =
    variant === 'branches'
      ? '/dev/herleitung?variant=branches — sources → branches (no findings)'
      : variant === 'live'
        ? '/dev/herleitung?variant=live — mid-stream turn (live status + chips)'
        : variant === 'dense'
          ? '/dev/herleitung?variant=dense — 9 sources, packed into stacked columns'
          : '/dev/herleitung — reasoning graph (desktop + mobile)'

  return (
    <main className="min-h-dvh bg-background px-4 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <h1 className="font-mono text-xs text-muted-foreground" data-testid="herleitung-preview">
          {label}
        </h1>
        {/* Same box the real thread gives the Herleitung (ChatArea's
            assistant-side spine) — the preview must not be wider than
            production, or the fan-out looks like it fits when it doesn't. */}
        <div className="w-[680px] max-w-full">
          <ChatThinking {...common} />
        </div>
        <div>
          <div className="mb-2 font-mono text-xs text-muted-foreground">↓ mobile width (380px)</div>
          <div className="w-[380px] max-w-full">
            <ChatThinking {...common} />
          </div>
        </div>
      </div>
    </main>
  )
}
