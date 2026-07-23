/**
 * ReasoningChain — the connected "Herleitung" node chain that replaces the flat
 * source-card body inside ChatThinking (click-dummy overhaul).
 *
 * Lays the visible nodes out vertically, threads a thin connector INTO each
 * downstream node (fan-out into the sources grid, fan-in out of it), and keeps
 * the technical NAT-step list as a collapsible tail. Which nodes appear is
 * driven purely by real data — see `nodes.tsx` for the per-node contract; no
 * node ever renders fabricated content.
 */

'use client'

import { type FC, useMemo } from 'react'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import { useLayoutStore } from '@/features/layout/store'
import { formatTime } from '@/shared/utils/format-time'
import type { ThinkingStep, CitationSource } from '../../types'
import { deriveTraceSourceCards } from '../../lib/trace-lanes'
import {
  FramingNode,
  SourceFanOutNode,
  FindingsNode,
  BranchesNode,
  type ChoicePrompt,
} from './nodes'

export interface ReasoningChainProps {
  steps: ThinkingStep[]
  /** Verbatim text of the triggering user message (Node 1 reframe source). */
  userQuestion: string
  answerConfidence?: 'low' | 'medium' | 'high'
  citations?: CitationSource[]
  /** Live HITL multiple-choice prompt for this turn, if any (Node 4). */
  choicePrompt?: ChoicePrompt
  onChoiceRespond?: (promptId: string, choice: string) => void
  /** Routing path this turn took after intent classification (framing node). */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  /** Verbatim classifier "why" for the routing decision (framing node). */
  routingReason?: string
  /** Set when this turn escalated shallow→deep — framing-node narration. */
  escalationReason?: string
}

/** A visible node in the reasoning timeline. */
interface RenderedNode {
  key: string
  render: (order: number) => React.ReactNode
}

const TechnicalSteps: FC<{ steps: ThinkingStep[]; t: Translator }> = ({ steps, t }) => (
  <Collapsible>
    <CollapsibleTrigger asChild>
      <button
        type="button"
        className="group flex w-full items-center justify-between rounded-lg py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {t('thinking.stepsHeading')}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>{steps.length}</span>
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
        </span>
      </button>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div role="list" aria-label={t('thinking.stepsLabel')} className="pt-1">
        {steps.map((step) => {
          const isWorkflowRoot = step.functionName === 'chat_deepresearcher_agent'
          const isFunctionStep = step.isTopLevel === true
          const indentClass = isWorkflowRoot
            ? ''
            : isFunctionStep
              ? 'pl-4 border-l-2 border-base ml-1'
              : 'pl-8 border-l-2 border-base ml-1'
          return (
            <div
              key={step.id}
              className={`flex w-full items-center justify-between py-1.5 ${indentClass}`}
              role="listitem"
            >
              <span className="min-w-0 truncate text-sm text-foreground">{step.displayName}</span>
              <span className="shrink-0 pl-4 text-xs text-muted-foreground">
                {formatTime(step.timestamp)}
              </span>
            </div>
          )
        })}
      </div>
    </CollapsibleContent>
  </Collapsible>
)

export const ReasoningChain: FC<ReasoningChainProps> = ({
  steps,
  userQuestion,
  answerConfidence,
  citations,
  choicePrompt,
  onChoiceRespond,
  routingDecision,
  routingReason,
  escalationReason,
}) => {
  const t = useTranslations('chat')
  // Raw NAT step list is a power-user opt-in (profile setting). The default
  // trace is the user-friendly node chain — never "which agent is running".
  const showTechnicalReasoning = useLayoutStore((s) => s.showTechnicalReasoning)

  const sourceCards = useMemo(() => deriveTraceSourceCards(steps), [steps])

  const hasSources = sourceCards.length > 0
  const hasFindings = Boolean(answerConfidence) || (citations?.length ?? 0) > 0
  const hasBranches = Boolean(choicePrompt && choicePrompt.options.length > 0)

  const nodes: RenderedNode[] = []

  // Node 1 — Framing (always leads the chain).
  nodes.push({
    key: 'framing',
    render: (order) => (
      <FramingNode
        t={t}
        userQuestion={userQuestion}
        order={order}
        routingDecision={routingDecision}
        routingReason={routingReason}
        escalationReason={escalationReason}
      />
    ),
  })

  // Node 2 — Quellen fan-out (parallelism reads as the grid within this step).
  if (hasSources) {
    nodes.push({
      key: 'sources',
      render: (order) => <SourceFanOutNode t={t} cards={sourceCards} order={order} />,
    })
  }

  // Node 3 — Assessment (confidence + citations).
  if (hasFindings) {
    nodes.push({
      key: 'findings',
      render: (order) => (
        <FindingsNode
          t={t}
          answerConfidence={answerConfidence}
          citations={citations}
          order={order}
        />
      ),
    })
  }

  // Node 4 — Next steps (live HITL choice only).
  if (hasBranches && choicePrompt) {
    nodes.push({
      key: 'branches',
      render: (order) => (
        <BranchesNode
          t={t}
          prompt={choicePrompt}
          onRespond={onChoiceRespond ?? (() => {})}
          order={order}
        />
      ),
    })
  }

  return (
    // Calm vertical timeline: ONE continuous rail with a marker per step, left
    // gutter = pl-6. This replaces the old measured-SVG fan-out/fan-in overlay,
    // which re-threaded on every reflow/text-wrap/stream tick and visibly fought
    // the layout at narrow widths. Reads as a competent analyst's steps; the
    // parallel Quellen fan-out now reads as the grid WITHIN its own step.
    <div className="relative flex w-full flex-col gap-6 pl-6">
      {/* The rail — a single hairline behind the markers, inset from top/bottom
          so it starts and ends at the first/last marker rather than floating. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-3 left-[9px] top-2 w-px bg-border"
      />

      {nodes.map((node, i) => (
        <div key={node.key} className="relative">
          {/* Marker dot seated on the rail, aligned with the node's tab strip. */}
          <span
            aria-hidden="true"
            className="absolute -left-[21px] top-1 flex size-3.5 items-center justify-center rounded-full border border-border bg-card shadow-2xs"
          >
            <span className="size-1.5 rounded-full bg-muted-foreground/70" />
          </span>
          {node.render(i)}
        </div>
      ))}

      {showTechnicalReasoning && steps.length > 0 && (
        <div className="border-t border-base pt-2">
          <TechnicalSteps steps={steps} t={t} />
        </div>
      )}
    </div>
  )
}
