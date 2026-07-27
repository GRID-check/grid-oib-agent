'use client'

/**
 * Herleitung dev preview: renders the REAL ChatThinking (reasoning trace)
 * expanded, with fixture steps/sources/citations, so the redesigned graph can be
 * reviewed and screenshotted (visual/registry.mjs → `herleitung`). Not linked
 * anywhere and 404s outside development.
 *
 * `?variant=` selects the captured scenario:
 *   - (none)   → framing → parallel sources → assessment (findings converge).
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

const citations: CitationSource[] = [
  {
    id: 'c1',
    content: '',
    timestamp: new Date('2024-01-15T14:30:00'),
    kind: 'baurecht',
    lane: 'baurecht_oib',
    laneLabel: 'OIB-Richtlinie',
  },
  {
    id: 'c2',
    content: '',
    timestamp: new Date('2024-01-15T14:30:00'),
    kind: 'baurecht',
    lane: 'baurecht_ris',
    laneLabel: 'Bundesrecht',
  },
]

const defaultCommon = {
  steps: [step],
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
    variant === 'branches' ? branchesCommon : variant === 'live' ? liveCommon : defaultCommon
  const label =
    variant === 'branches'
      ? '/dev/herleitung?variant=branches — sources → branches (no findings)'
      : variant === 'live'
        ? '/dev/herleitung?variant=live — mid-stream turn (live status + chips)'
        : '/dev/herleitung — reasoning graph (desktop + mobile)'

  return (
    <main className="min-h-dvh bg-background px-4 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <h1 className="font-mono text-xs text-muted-foreground" data-testid="herleitung-preview">
          {label}
        </h1>
        <ChatThinking {...common} />
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
