'use client'

/**
 * Memory, made visible — dev preview (visual/registry.mjs → `memory-visibility`).
 * Not linked anywhere and 404s outside development.
 *
 * What these captures are evidence of is a single rule, applied four times:
 * memory states what was READ and never what was used, and it is never dressed
 * as evidence (ADR-0055). So each variant is photographed next to the thing it
 * must not be mistaken for.
 *
 * - `marker` — the collapsed line under an answer, expanded, beside a note
 *   saying it is not a citation. Grey is `--source-auto`, the one family that
 *   is not a corpus; no citation token appears anywhere on it.
 * - `herleitung` — the memory band under the knowledge levels, hairline-
 *   separated, saying "not evidence" before it says any number.
 * - `superseded` — the correction in the transcript: what was replaced, what
 *   replaced it, and the undo. The same notice molecule a mount uses.
 * - `proposal` — the organization proposal card, which now says WHY it is
 *   being asked (the blast radius) and WHO may accept it (`org:memory:write`).
 */

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

import { I18nProvider } from '@/i18n'
import { MemoryContextMarker } from '@/features/chat/components/MemoryContextMarker'
import { MemorySupersededNotice } from '@/features/chat/components/MemorySupersededNotice'
import { HerleitungLevels } from '@/features/chat/components/reasoning/HerleitungLevels'
import { HerleitungMemory } from '@/features/chat/components/reasoning/HerleitungMemory'
import { MemoryProposalCard } from '@/features/grid-cards/components/MemoryProposalCard'
import { SectionLabel } from '@/components/ui/section-label'
import { memoryBand } from '@/features/chat/lib/herleitung-levels'
import type { LevelGroup } from '@/features/chat/lib/herleitung-levels'
import type { MemoryContext } from '@/adapters/api/schemas'
import type { TurnMemoryItem } from '@/features/chat/lib/turn-memory'

const CONTEXT: MemoryContext = {
  carried: [
    { id: 'm1', kind: 'decision', content: 'Zwei Stiegenhäuser, Ost und West — Beschluss vom 14.03.' },
    { id: 'm2', kind: 'constraint', content: 'Bauklasse III, Gebäudehöhe maximal 16 m.' },
    { id: 'm3', kind: 'derived_fact', content: 'Fluchtweglänge im OG3 gemessen: 34,2 m.' },
  ],
  omitted: 44,
  total: 47,
  searched: 3,
}

/** The corpus bands, so the memory band is photographed BESIDE what it is not. */
const LEVELS: LevelGroup[] = [
  {
    level: 'law',
    signal: 'law',
    hitCount: 4,
    entries: [{ name: 'OIB-RL-2.pdf', laneLabel: 'OIB-Richtlinie' }],
    projects: [],
  },
  { level: 'office', signal: 'office', hitCount: 0, entries: [], projects: [] },
  { level: 'register', signal: 'project', hitCount: 0, entries: [], projects: [] },
  {
    level: 'project',
    signal: 'project',
    hitCount: 2,
    entries: [{ name: 'Einreichplan.pdf', laneLabel: 'Projektwissen' }],
    projects: [
      {
        projectId: 'p-see',
        projectName: 'Seestadt Nord',
        entries: [{ name: 'Einreichplan.pdf', laneLabel: 'Projektwissen' }],
      },
    ],
  },
  { level: 'conversation', signal: 'project', hitCount: 0, entries: [], projects: [] },
  { level: 'web', signal: 'auto', hitCount: 0, entries: [], projects: [] },
]

const SUPERSEDED: TurnMemoryItem & { supersedes: { id: string; content: string } } = {
  id: 'm-new',
  kind: 'constraint',
  content: 'Gebäudehöhe maximal 16 m (Bauklasse III).',
  provenance: 'distillation',
  supersedes: { id: 'm-old', content: 'Gebäudehöhe maximal 21 m (Bauklasse IV).' },
}

const Panel = ({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.ReactElement => (
  <section className="bg-card flex w-full flex-col gap-2 rounded-xl border p-4">
    <SectionLabel as="h2">{title}</SectionLabel>
    {children}
  </section>
)

const MemoryVisibilityPreview = (): React.ReactElement => {
  const variant = useSearchParams()?.get('variant') ?? 'marker'

  return (
    <main className="bg-background flex min-h-dvh items-start justify-center p-6">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        {variant === 'marker' && (
          <Panel title="Unter der Antwort">
            {/* Rendered inside its own surface rather than a whole answer card:
                what this shot is evidence of is the LINE — its grey, its
                wording and the fact that it sits apart from any citation. */}
            <MemoryContextMarker memoryContext={CONTEXT} projectId="p-see" defaultOpen />
          </Panel>
        )}

        {variant === 'herleitung' && (
          <Panel title="Herleitung">
            <HerleitungLevels groups={LEVELS} />
            <HerleitungMemory band={memoryBand(CONTEXT)} />
          </Panel>
        )}

        {variant === 'superseded' && (
          <Panel title="Im Verlauf">
            <MemorySupersededNotice item={SUPERSEDED} projectId="p-see" />
          </Panel>
        )}

        {variant === 'proposal' && (
          <Panel title="Vorschlag fürs Organisationsgedächtnis">
            <MemoryProposalCard
              title="Diese Erkenntnis merken?"
              content="Bei Bauklasse III rechnet das Büro die Gebäudehöhe ab Oberkante Gehsteig."
              kind="decision"
              confidence="high"
              messageId="msg-dev"
              cardKey="memory_proposal:0"
            />
          </Panel>
        )}
      </div>
    </main>
  )
}

export default function MemoryVisibilityPreviewPage(): React.ReactElement {
  return (
    <I18nProvider initialLocale="de" fixedLocale>
      <Suspense fallback={null}>
        <MemoryVisibilityPreview />
      </Suspense>
    </I18nProvider>
  )
}
