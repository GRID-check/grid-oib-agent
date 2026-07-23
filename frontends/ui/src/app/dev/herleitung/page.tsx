'use client'

/**
 * Herleitung dev preview: renders the REAL ChatThinking (reasoning trace)
 * expanded, with fixture steps/sources/citations, so the redesigned timeline can
 * be reviewed and screenshotted (visual/registry.mjs → `herleitung`). Not linked
 * anywhere and 404s outside development.
 */

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

export default function HerleitungPreviewPage() {
  if (process.env.NODE_ENV !== 'development') {
    notFound()
  }

  const common = {
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

  return (
    <main className="min-h-dvh bg-background px-4 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <h1 className="font-mono text-xs text-muted-foreground" data-testid="herleitung-preview">
          /dev/herleitung — reasoning graph (desktop + mobile)
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
