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
import { motion, AnimatePresence } from '@/components/motion'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type { ThinkingStep, CitationSource } from '../types'
import { deriveTraceSourceCards } from '../lib/trace-lanes'
import { deriveLiveActivity } from '../lib/live-activity'
import { useElapsedSeconds, formatElapsed } from '../hooks/use-elapsed-seconds'
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
  /** Routing path this turn took after intent classification (framing node). */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  /** Verbatim classifier "why" for the routing decision (framing node). */
  routingReason?: string
  /** Set when this turn escalated shallow→deep — framing-node narration. */
  escalationReason?: string
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
  routingDecision,
  routingReason,
  escalationReason,
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

  // Live status: what the assistant is doing right now (derived from the newest
  // streamed step) plus a seconds-elapsed cue, so a slow turn reads as active
  // work in progress rather than a frozen spinner.
  const liveActivity = deriveLiveActivity(steps, t)
  const activityLabel = liveActivity ?? t('thinking.working')
  const elapsedSeconds = useElapsedSeconds(isThinking)

  const hasSignal =
    steps.length > 0 ||
    enabledDataSources.length > 0 ||
    messageFiles.length > 0 ||
    Boolean(answerConfidence) ||
    (citations?.length ?? 0) > 0 ||
    Boolean(choicePrompt) ||
    Boolean(routingDecision && routingReason?.trim()) ||
    Boolean(escalationReason?.trim()) ||
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
            className="group relative flex w-full cursor-pointer items-center justify-between rounded-2xl px-4 pb-4 pt-3 text-left outline-none transition-colors duration-200 ease-out focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label={summaryLabel}
          >
            <span className="flex min-w-0 items-center gap-2">
              {isThinking ? (
                <>
                  <Spinner size="sm" label={t('thinking.inProgress')} />
                  {/* The live activity phrase cross-fades as each new step
                      arrives, and shimmers while it holds — a quiet cue that
                      work is actively moving during a long wait. */}
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={activityLabel}
                      className="animate-text-shimmer truncate text-sm font-semibold"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={{ duration: 0.2, ease: 'easeOut' }}
                      aria-live="polite"
                    >
                      {activityLabel}
                    </motion.span>
                  </AnimatePresence>
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

            <span className="flex shrink-0 items-center gap-2">
              {isThinking && elapsedSeconds > 0 && (
                <span
                  className="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground"
                  aria-label={t('thinking.elapsedAria', { seconds: elapsedSeconds })}
                >
                  {formatElapsed(elapsedSeconds)}
                </span>
              )}
              <span className="text-xs text-muted-foreground">{summaryLabel}</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </span>

            {/* Slim indeterminate sweep along the header's lower edge — a
                progress-like motion that guides the eye while thinking. */}
            {isThinking && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-4 bottom-1.5 h-0.5 overflow-hidden rounded-full bg-foreground/5"
              >
                <span className="animate-progress-sweep block h-full w-1/3 rounded-full bg-foreground/30" />
              </span>
            )}
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
              routingDecision={routingDecision}
              routingReason={routingReason}
              escalationReason={escalationReason}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Mid-turn drop notice: a silent reconnect can leave a turn without any
          response. The collapsed header only shows a muted "Interrupted" chip,
          which does not tell the user what to do — so surface a compact,
          always-visible line prompting a resend (protocol-robustness item 4). */}
      {isInterrupted && (
        <div className="flex items-start gap-2 border-t border-border/60 px-4 pb-3 pt-2.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
          <span className="text-[12px] leading-relaxed text-muted-foreground" role="status">
            {t('thinking.interruptedNotice')}
          </span>
        </div>
      )}

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
                className="whitespace-nowrap rounded-md bg-secondary px-2.5 py-1 text-[11px] font-medium text-muted-foreground"
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
