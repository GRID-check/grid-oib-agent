'use client'

/**
 * Chat-turn dev preview: renders a COMPLETE turn the way ChatArea composes it —
 * the user question (UserMessage), the reasoning trace (ChatThinking / Herleitung)
 * and the cited answer (AgentResponse, default "Ergebnis" card) — with fixture
 * data and no backend.
 *
 * Two states are rendered so the transition endpoints are both screenshot-able
 * (visual/registry.mjs → `chat-turn`), in light + dark, desktop + mobile:
 *   • LIVE      — isThinking, the Herleitung auto-EXPANDED (the streaming
 *                 reasoning graph is the spectacle), the answer still absent.
 *   • COMPLETED — the Herleitung auto-COLLAPSED to the one-line bar, the cited
 *                 answer card dominant, with sources + confidence shown ONCE on
 *                 the answer (deduped out of the reasoning assessment node).
 *
 * The fixture answer deliberately ends in a written "## Quellen" section, the way
 * a verified backend answer does: it must NOT render as a second source list —
 * AgentResponse folds it into the one numbered "Belegt durch" block.
 *
 * Not linked anywhere and 404s outside development.
 */

import { notFound } from 'next/navigation'
import { UserMessage } from '@/features/chat/components/UserMessage'
import { ChatThinking } from '@/features/chat/components/ChatThinking'
import { AgentResponse } from '@/features/chat/components/AgentResponse'
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
  ],
}

const citations: CitationSource[] = [
  {
    id: 'c1',
    content: '',
    timestamp: new Date('2024-01-15T14:30:00'),
    isCited: true,
    kind: 'baurecht',
    lane: 'baurecht_oib',
    laneLabel: 'OIB-Richtlinie',
    fileName: 'OIB-RL_2_Brandschutz.pdf',
    title: 'OIB-Richtlinie 2 · Brandschutz',
    page: 18,
    number: 1,
  },
  {
    id: 'c2',
    content: '',
    timestamp: new Date('2024-01-15T14:30:00'),
    isCited: true,
    kind: 'baurecht',
    lane: 'baurecht_ris',
    laneLabel: 'Bundesrecht',
    title: 'Bauordnung für Wien § 108',
    url: 'https://www.ris.bka.gv.at/',
    number: 2,
  },
]

const question =
  'Wie viele Rettungswege brauche ich für ein Bürogebäude der Gebäudeklasse 4 in Wien?'

const answer = `Für ein Bürogebäude der **Gebäudeklasse 4** sind in der Regel **zwei voneinander unabhängige Fluchtwege** erforderlich.

- **Erster Fluchtweg** — ein baulicher Rettungsweg über ein Sicherheitstreppenhaus.
- **Zweiter Fluchtweg** — ein zweiter baulicher Weg oder eine über die Feuerwehr anleiterbare Stelle.

Die maximale Fluchtweglänge bis zum sicheren Bereich beträgt **40 m** [1]; § 108 BO Wien verlangt zusätzlich den zweiten Weg [2].

## Quellen
- [1] [KB] OIB-RL_2_Brandschutz.pdf, p.18
- [2] [RIS] Bauordnung für Wien § 108 — https://www.ris.bka.gv.at/`

const commonThinking = {
  steps: [step],
  userQuestion: question,
  enabledDataSources: ['OIB-Korpus', 'RIS', 'Projektdokumente'],
  messageFiles: [{ id: 'f1', fileName: 'Grundriss_EG.pdf' }],
  routingDecision: 'shallow' as const,
  routingReason:
    'konkrete Frage zu OIB-Richtlinie 2 (Brandschutz), kein Bedarf für Tiefenrecherche',
}

/**
 * The LIVE turn: the assistant is still working. The Herleitung is auto-EXPANDED
 * (the streaming reasoning graph is the focus) and no answer card exists yet.
 */
function LiveTurn() {
  return (
    <div className="flex flex-col gap-5 rounded-2xl border bg-background p-5">
      <div className="font-mono text-xs text-muted-foreground">↓ LIVE — thinking, Herleitung expanded, answer absent</div>
      <UserMessage content={question} timestamp={new Date('2024-01-15T14:30:00')} />
      <div className="w-[680px] max-w-full">
        <ChatThinking
          {...commonThinking}
          isThinking
          autoOpen
          answerConfidence="high"
          citations={citations}
        />
      </div>
    </div>
  )
}

/**
 * The COMPLETED turn: the answer has landed. The Herleitung has auto-COLLAPSED to
 * the one-line bar and the cited answer card is dominant — sources + confidence
 * shown ONCE, on the answer.
 */
function CompletedTurn() {
  return (
    <div className="flex flex-col gap-5 rounded-2xl border bg-background p-5">
      <div className="font-mono text-xs text-muted-foreground">↓ COMPLETED — Herleitung collapsed, answer dominant</div>
      <UserMessage content={question} timestamp={new Date('2024-01-15T14:30:00')} />
      <div className="w-[680px] max-w-full">
        <ChatThinking
          {...commonThinking}
          isThinking={false}
          autoOpen={false}
          answerConfidence="high"
          citations={citations}
        />
      </div>
      <AgentResponse
        content={answer}
        timestamp={new Date('2024-01-15T14:30:12')}
        citations={citations}
        answerConfidence="high"
        answerConfidenceReason="OIB-RL 2 direkt als Quelle belegt"
        routingDecision="shallow"
        messageId="msg-a1"
      />
    </div>
  )
}

export default function ChatTurnPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  return (
    <main className="min-h-dvh bg-muted/30 px-4 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
        <h1 className="font-mono text-xs text-muted-foreground" data-testid="chat-turn-preview">
          /dev/chat-turn — live (reasoning expanded) → completed (answer-dominant)
        </h1>
        <LiveTurn />
        <CompletedTurn />
      </div>
    </main>
  )
}
