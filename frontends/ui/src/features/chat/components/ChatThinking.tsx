/**
 * ChatThinking — collapsible Herleitung panel (click-dummy overhaul).
 *
 * Collapsed: status + "Herleitung · n Zwischenschritte · m Quellen".
 * Expanded: the connected reasoning-chain (`ReasoningChain`) — the framing node,
 * the parallel Quellen fan-out, the assessment node, and (when a live HITL
 * choice exists) the next-steps branches, plus the technical NAT-step tail.
 * Every node binds to real streamed data or is hidden; nothing is fabricated.
 */

'use client'

import { type FC, useMemo } from 'react'
import { ChevronDown, CheckCircle2, AlertTriangle, Clock } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { motion } from '@/components/motion'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type { ThinkingStep, CitationSource } from '../types'
import { deriveTraceSourceCards } from '../lib/trace-lanes'
import { ReasoningChain, type ChoicePrompt } from './reasoning'
import { buildContextChips } from './reasoning/context'

export interface ChatThinkingProps {
  /** Array of thinking steps to display */
  steps: ThinkingStep[]
  /** Whether thinking is in progress (shows spinner when true, check when done) */
  isThinking?: boolean
  /** Whether the response was interrupted (page refresh / browser close mid-stream) */
  isInterrupted?: boolean
  /** Whether waiting for user response (HITL prompt pending) */
  isWaiting?: boolean
  /** Data sources that were enabled for this query */
  enabledDataSources?: string[]
  /** Files that were available for this query */
  messageFiles?: Array<{ id: string; fileName: string }>
  /** Verbatim text of the triggering user message (framing node reframe). */
  userQuestion?: string
  /** The turn's answer confidence, if answered (assessment node). */
  answerConfidence?: 'low' | 'medium' | 'high'
  /** The turn's structured citations, if any (assessment node). */
  citations?: CitationSource[]
  /** A live HITL multiple-choice prompt for this turn (next-steps node). */
  choicePrompt?: ChoicePrompt
  /** Respond to the HITL choice prompt. */
  onChoiceRespond?: (promptId: string, choice: string) => void
}

export const ChatThinking: FC<ChatThinkingProps> = ({
  steps,
  isThinking = true,
  isInterrupted = false,
  isWaiting = false,
  enabledDataSources = [],
  messageFiles = [],
  userQuestion = '',
  answerConfidence,
  citations,
  choicePrompt,
  onChoiceRespond,
}) => {
  const t = useTranslations('chat')

  const sourceCards = useMemo(() => deriveTraceSourceCards(steps), [steps])
  // Unique source cards (hits + gaps) — bar "m Quellen", not sum of Treffer.
  const sourceCount = sourceCards.length

  // Basis footer: the data sources + files this query ran against, shown as
  // clean pills and always visible (no expand needed).
  const contextChips = useMemo(
    () => buildContextChips(enabledDataSources, messageFiles, t),
    [enabledDataSources, messageFiles, t]
  )

  const hasSignal =
    steps.length > 0 ||
    enabledDataSources.length > 0 ||
    messageFiles.length > 0 ||
    Boolean(answerConfidence) ||
    (citations?.length ?? 0) > 0 ||
    Boolean(choicePrompt) ||
    userQuestion.trim().length > 0

  if (!hasSignal) {
    return null
  }

  const summaryLabel = t('thinking.herleitungSummary', {
    steps: steps.length,
    sources: sourceCount,
  })

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 w-full rounded-2xl bg-muted/50 shadow-xs duration-200 ease-out">
      <Collapsible>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group flex w-full cursor-pointer items-center justify-between rounded-2xl px-4 pb-4 pt-3 text-left outline-none transition-colors duration-200 ease-out focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label={summaryLabel}
          >
            <span className="flex items-center gap-2">
              {isThinking ? (
                <>
                  <Spinner size="sm" label={t('thinking.inProgress')} />
                  <motion.span
                    className="text-sm font-semibold text-foreground"
                    animate={{ opacity: [0.4, 1, 0.4] }}
                    transition={{ repeat: Infinity, duration: 1.6, ease: 'easeInOut' }}
                  >
                    {t('thinking.working')}
                  </motion.span>
                </>
              ) : isWaiting ? (
                <>
                  <span className="text-brand">
                    <Clock className="h-5 w-5" />
                  </span>
                  <span className="text-foreground text-sm font-semibold">
                    {t('thinking.waiting')}
                  </span>
                </>
              ) : isInterrupted ? (
                <>
                  <span className="text-warning">
                    <AlertTriangle className="h-5 w-5" />
                  </span>
                  <span className="text-foreground text-sm font-semibold">
                    {t('thinking.interrupted')}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-success">
                    <CheckCircle2 className="h-5 w-5" />
                  </span>
                  <span className="text-foreground text-sm font-semibold">
                    {t('thinking.done')}
                  </span>
                </>
              )}
            </span>

            <span className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">{summaryLabel}</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </span>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="border-base border-t px-4 pb-4 pt-4">
            <ReasoningChain
              steps={steps}
              userQuestion={userQuestion}
              answerConfidence={answerConfidence}
              citations={citations}
              choicePrompt={choicePrompt}
              onChoiceRespond={onChoiceRespond}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Basis footer — the data sources + files this query ran against, always
          visible as clean pills (does not require expanding the Herleitung). */}
      {contextChips.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border/60 px-4 pb-4 pt-3">
          <span className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {t('thinking.selectedDataSources')}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {contextChips.map((chip) => (
              <span
                key={chip}
                className="whitespace-nowrap rounded-full bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
              >
                {chip}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
