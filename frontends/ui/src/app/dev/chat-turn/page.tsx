'use client'

/**
 * Chat-turn dev preview: renders a COMPLETE turn the way ChatArea composes it —
 * the user question (UserMessage), the reasoning trace (ChatThinking / Herleitung)
 * and the cited answer (AgentResponse, default "Ergebnis" card) — with fixture
 * data and no backend, so the hero message/answer presentation can be reviewed
 * and screenshotted (visual/registry.mjs → `chat-turn`) in light + dark, desktop
 * + mobile. Not linked anywhere and 404s outside development.
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
  },
]

const question =
  'Wie viele Rettungswege brauche ich für ein Bürogebäude der Gebäudeklasse 4 in Wien?'

const answer = `Für ein Bürogebäude der **Gebäudeklasse 4** sind in der Regel **zwei voneinander unabhängige Fluchtwege** erforderlich.

- **Erster Fluchtweg** — ein baulicher Rettungsweg über ein Sicherheitstreppenhaus.
- **Zweiter Fluchtweg** — ein zweiter baulicher Weg oder eine über die Feuerwehr anleiterbare Stelle.

Die maximale Fluchtweglänge bis zum sicheren Bereich beträgt **40 m** (OIB-RL 2, Pkt. 3.2).`

function Turn({ width, label }: { width: string; label: string }) {
  const thinking = {
    steps: [step],
    isThinking: false as const,
    defaultOpen: false,
    userQuestion: question,
    answerConfidence: 'high' as const,
    citations,
    enabledDataSources: ['OIB-Korpus', 'RIS', 'Projektdokumente'],
    messageFiles: [{ id: 'f1', fileName: 'Grundriss_EG.pdf' }],
    routingDecision: 'shallow' as const,
    routingReason:
      'konkrete Frage zu OIB-Richtlinie 2 (Brandschutz), kein Bedarf für Tiefenrecherche',
  }

  return (
    <div className={width}>
      <div className="mb-2 font-mono text-xs text-muted-foreground">{label}</div>
      <div className="flex flex-col gap-5 rounded-2xl border bg-background p-5">
        <UserMessage content={question} timestamp={new Date('2024-01-15T14:30:00')} />
        <ChatThinking {...thinking} />
        <AgentResponse
          content={answer}
          timestamp={new Date('2024-01-15T14:30:12')}
          citations={citations}
          answerConfidence="high"
          routingDecision="shallow"
          messageId="msg-a1"
        />
      </div>
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
          /dev/chat-turn — full turn: question → Herleitung → cited answer
        </h1>
        <Turn width="w-full" label="↓ desktop column" />
        <Turn width="w-[390px] max-w-full" label="↓ mobile width (390px)" />
      </div>
    </main>
  )
}
