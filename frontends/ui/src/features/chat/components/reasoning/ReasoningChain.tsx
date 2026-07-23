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

import { type FC, useMemo, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import { useLayoutStore } from '@/features/layout/store'
import { formatTime } from '@/shared/utils/format-time'
import type { ThinkingStep, CitationSource } from '../../types'
import { deriveTraceSourceCards } from '../../lib/trace-lanes'
import { ChainConnectors, type ChainConnector } from './ChainConnectors'
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

/** A visible node plus the connector that leads into it. */
interface RenderedNode {
  key: string
  connector: ChainConnector | null
  columns?: number
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
  const containerRef = useRef<HTMLDivElement>(null)

  const sourceCards = useMemo(() => deriveTraceSourceCards(steps), [steps])

  const hasSources = sourceCards.length > 0
  const hasFindings = Boolean(answerConfidence) || (citations?.length ?? 0) > 0
  const hasBranches = Boolean(choicePrompt && choicePrompt.options.length > 0)

  const nodes: RenderedNode[] = []

  // Node 1 — Framing (always leads the chain; no connector above it).
  nodes.push({
    key: 'framing',
    connector: null,
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

  // Node 2 — Quellen fan-out.
  if (hasSources) {
    nodes.push({
      key: 'sources',
      connector: 'fan-out',
      columns: sourceCards.length,
      render: (order) => <SourceFanOutNode t={t} cards={sourceCards} order={order} />,
    })
  }

  // Node 3 — Assessment. Fan-in when it converges out of the sources grid.
  if (hasFindings) {
    nodes.push({
      key: 'findings',
      connector: hasSources ? 'fan-in' : 'line',
      columns: sourceCards.length,
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
      connector: 'line',
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

  // Remeasure connectors whenever the visible node set (or source count) changes.
  const signature = `${nodes.map((n) => n.key).join('|')}:${sourceCards.length}`

  return (
    <div ref={containerRef} className="relative flex w-full flex-col gap-8">
      {/* Dynamic connectors are drawn BEHIND the nodes from their real measured
          positions (see ChainConnectors); the gap-8 spine gives them room. */}
      <ChainConnectors containerRef={containerRef} signature={signature} />

      {nodes.map((node, i) => (
        <div
          key={node.key}
          data-chain-node
          data-chain-connector={node.connector ?? ''}
          className="relative z-10"
        >
          {node.render(i)}
        </div>
      ))}

      {showTechnicalReasoning && steps.length > 0 && (
        <div className="relative z-10 border-t border-base pt-1">
          <TechnicalSteps steps={steps} t={t} />
        </div>
      )}
    </div>
  )
}
