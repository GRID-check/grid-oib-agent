/**
 * AgentResponse Component
 *
 * Displays a completed agent response in the chat area.
 * Used for short answers that don't need the full report panel.
 * Left-aligned with distinct styling from user messages.
 */

'use client'

import { type FC, memo, useCallback } from 'react'
import { Check, ChevronRight, MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useShallow } from 'zustand/react/shallow'
import { useTranslations } from '@/i18n'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { formatTime } from '@/shared/utils/format-time'
import { useLayoutStore } from '@/features/layout/store'
import { GridCards } from '@/features/grid-cards/components/GridCards'
import type { GridCard } from '@/shared/cards/schemas'
import type { CitationSource } from '../types'
import { useChatStore } from '../store'
import { useLoadJobData } from '../hooks'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AnswerSourcesRow } from './AnswerSourcesRow'
import { MemoryNotedChip } from './MemoryNotedChip'
import { ConfidenceChip } from './ConfidenceChip'
import { AnswerFeedback } from './AnswerFeedback'

export interface AgentResponseProps {
  /** Response content from the agent */
  content: string
  /** Timestamp of the response (Date or ISO string from persisted state) */
  timestamp?: Date | string
  /** Whether to show a button to view the full report */
  showViewReport?: boolean
  /** Display variant - 'default' has box styling, 'inline' has no box (for use inside containers) */
  variant?: 'default' | 'inline'
  /** Deep research job ID for loading report data on-demand */
  jobId?: string
  /** Whether this message has active (streaming) deep research */
  isDeepResearchActive?: boolean
  /** Job status for determining button behavior */
  deepResearchJobStatus?: 'submitted' | 'running' | 'success' | 'failure' | 'interrupted'
  /** Grid cards to render before the response content */
  cards?: GridCard[]
  /**
   * Citations already collected for this answer (deep-research path). Drives
   * the "Belegt durch" chip row — renders nothing when absent (no fake chips).
   */
  citations?: CitationSource[]
  /** Conversation this response belongs to (for the "Piloti noted N" memory chip) */
  conversationId?: string | null
  /** The assistant's guarded self-assessed answer confidence (shallow answers only) */
  answerConfidence?: 'low' | 'medium' | 'high'
  /**
   * Why the self-assessed confidence was capped (WP-A transparency extra) —
   * `'ungrounded'` or `'quote_unverified'` add the matching cap explanation to
   * the ConfidenceChip tooltip (PB-9).
   */
  answerConfidenceCappedReason?: 'ungrounded' | 'quote_unverified'
  /**
   * Citation-verification result: how many citations were removed as
   * unverifiable, with de-duplicated reasons. Renders a muted note under the
   * "Belegt durch" sources row when present.
   */
  citationsRemoved?: { count: number; reasons: string[] }
  /**
   * Whether the self-assessment ConfidenceChip renders (WorkOS
   * `chat-confidence-chip` flag, FB-6). Defaults to true so the feature stays
   * visible with flag enforcement off (fail-open) and existing callers/specs
   * are unaffected.
   */
  showConfidenceChip?: boolean
  /**
   * Client-side message identifier of this answer — keys the per-answer
   * thumbs feedback row (WS-7). No feedback row renders when absent (e.g.
   * legacy callers), so existing usages are unaffected.
   */
  messageId?: string
  /**
   * Whether the per-answer thumbs feedback row renders (WorkOS
   * `answer-feedback` flag). Defaults to true (fail-open, matching the other
   * flag props) — the row still requires a `messageId` to appear.
   */
  showAnswerFeedback?: boolean
  /**
   * Whether this answer is still streaming (C6). Drives the blinking caret at
   * the end of the answer body and the partial-markdown stabilizer in the
   * MarkdownRenderer. Threaded from `message.isStreaming` by ChatArea.
   */
  isStreaming?: boolean
  /**
   * Which path the turn took after intent classification (WP-A transparency
   * extra). `'meta'` marks a conversational / clarifying reply (greetings,
   * capability questions, Rückfragen) — rendered with a quiet neutral "Hinweis"
   * role tab so it reads clearly apart from a substantive Baurecht answer
   * (`'shallow'`/`'deep'`, the ink "Ergebnis" tab). Absent/`'error'` fall back
   * to the "Ergebnis" treatment, so existing callers render exactly as before.
   */
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
}

/** Blinking caret shown at the tail of a still-streaming answer (C6). */
const StreamingCaret: FC = () => (
  <span
    aria-hidden="true"
    className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse rounded-full bg-foreground/70 align-baseline"
  />
)

/**
 * Muted note under the "Belegt durch" row: citation verification removed one or
 * more citations from this answer as unverifiable (WP-A `citations_removed`).
 * The de-duplicated reasons hang off a tooltip so the row stays quiet by
 * default. Renders nothing when nothing was removed.
 */
const CitationsRemovedNote: FC<{ citationsRemoved?: { count: number; reasons: string[] } }> = ({
  citationsRemoved,
}) => {
  const t = useTranslations('chat')
  if (!citationsRemoved || citationsRemoved.count <= 0) return null

  const label = t('answerSources.citationsRemoved', { count: citationsRemoved.count })
  const reasons = citationsRemoved.reasons?.filter((r) => r.trim().length > 0) ?? []

  const text = (
    <span className="text-[11px] leading-relaxed text-muted-foreground" role="note">
      {label}
    </span>
  )

  if (reasons.length === 0) {
    return <div className="mt-1.5">{text}</div>
  }

  return (
    <div className="mt-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="cursor-help rounded-xs text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label={label}
          >
            <span className="text-[11px] leading-relaxed text-muted-foreground underline decoration-dotted underline-offset-2">
              {label}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.05em]">
            {t('answerSources.citationsRemovedReasonsLabel')}
          </span>
          <ul className="list-disc space-y-0.5 pl-4">
            {reasons.map((reason, i) => (
              <li key={i}>{reason}</li>
            ))}
          </ul>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * Agent response bubble component for completed responses
 */
const AgentResponseComponent: FC<AgentResponseProps> = ({
  content,
  timestamp,
  showViewReport = false,
  variant = 'default',
  jobId,
  isDeepResearchActive = false,
  deepResearchJobStatus,
  cards,
  citations,
  conversationId,
  answerConfidence,
  answerConfidenceCappedReason,
  citationsRemoved,
  showConfidenceChip = true,
  messageId,
  showAnswerFeedback = true,
  isStreaming = false,
  routingDecision,
}) => {
  const t = useTranslations('chat')
  const openRightPanel = useLayoutStore((s) => s.openRightPanel)
  const setResearchPanelTab = useLayoutStore((s) => s.setResearchPanelTab)
  const projectId = useChatStore((s) => s.projectId)

  const { reportContent, deepResearchJobId, isDeepResearchStreaming, deepResearchStreamLoaded } =
    useChatStore(useShallow((s) => ({
      reportContent: s.reportContent,
      deepResearchJobId: s.deepResearchJobId,
      isDeepResearchStreaming: s.isDeepResearchStreaming,
      deepResearchStreamLoaded: s.deepResearchStreamLoaded,
  })))
  const reconnectToActiveJob = useChatStore((s) => s.reconnectToActiveJob)
  const { loadResearchPanelTab, isLoading, error } = useLoadJobData()

  // Determine if we should show the action button
  // Show "View Progress" for active jobs, "View Report" for completed jobs
  const isJobActive = isDeepResearchActive || deepResearchJobStatus === 'submitted' || deepResearchJobStatus === 'running'
  const isJobComplete = deepResearchJobStatus === 'success' || deepResearchJobStatus === 'failure' || deepResearchJobStatus === 'interrupted'
  const shouldShowButton = showViewReport || (jobId && (isJobActive || isJobComplete))
  const buttonText = isJobActive ? t('agentResponse.viewProgress') : t('agentResponse.viewReport')

  // Check if a different job is currently streaming (in progress)
  const isAnotherJobStreaming = isDeepResearchStreaming && deepResearchJobId && deepResearchJobId !== jobId

  const handleViewReport = useCallback(async () => {
    // For active jobs, ensure stream is connected and open the panel
    if (isJobActive) {
      // Reconnect to active job if not already streaming this job
      if (!isDeepResearchStreaming || deepResearchJobId !== jobId) {
        await reconnectToActiveJob()
      }
      setResearchPanelTab('tasks')
      openRightPanel('research')
      return
    }

    // If another job is actively streaming, just open the panel to show current progress
    // Don't load this report's data as it would interrupt the active research
    if (isAnotherJobStreaming) {
      setResearchPanelTab('tasks')
      openRightPanel('research')
      return
    }

    // For completed jobs, check if we have ALL research data for THIS specific job
    // Important: must verify job ID matches to avoid showing wrong data
    const hasExistingDataForThisJob =
      jobId &&
      deepResearchJobId === jobId &&
      deepResearchStreamLoaded &&
      reportContent &&
      reportContent.trim().length > 0

    if (hasExistingDataForThisJob) {
      setResearchPanelTab('report')
      openRightPanel('research')
      return
    }

    if (jobId) {
      await loadResearchPanelTab(jobId, 'report')
    } else {
      setResearchPanelTab('report')
      openRightPanel('research')
    }
  }, [jobId, deepResearchJobId, reportContent, deepResearchStreamLoaded, isJobActive, isAnotherJobStreaming, isDeepResearchStreaming, loadResearchPanelTab, reconnectToActiveJob, setResearchPanelTab, openRightPanel])

  const hasCards = cards && cards.length > 0

  // Guard against null, undefined, empty, or literal "null" string content
  // when no cards are present. Cards can render even with empty text.
  if ((!content || !content.trim() || content === 'null') && !hasCards) {
    return null
  }

  // Inline variant - no box styling (for use inside containers like thinking process)
  if (variant === 'inline') {
    return (
      <div className="flex w-full flex-col gap-2 overflow-hidden break-words">
        {/* Optional Grid cards rendered before the markdown body */}
        {hasCards && <GridCards cards={cards} projectId={projectId} />}

        {/* Response Content rendered as markdown (with streaming caret). While
            streaming, the markdown block + its last child are forced inline so
            the caret trails the final glyph instead of dropping to a new line. */}
        <div
          className={
            isStreaming
              ? '[&>.markdown-content>*:last-child]:inline [&>.markdown-content]:inline'
              : undefined
          }
        >
          <MarkdownRenderer content={content} isStreaming={isStreaming} />
          {isStreaming && <StreamingCaret />}
        </div>

        {/* Optional action button */}
        {shouldShowButton && (
          <div className="mt-1 flex items-center justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleViewReport}
              disabled={isLoading}
              aria-label={isLoading ? t('agentResponse.loading') : buttonText}
              title={error ? t('agentResponse.errorTitle', { message: error }) : isLoading ? t('agentResponse.loading') : buttonText}
            >
              <span className="flex items-center gap-1">
                {isLoading ? (
                  <>
                    <Spinner size="sm" label={t('agentResponse.loadingLabel')} className="h-3 w-3" />
                    <span className="text-xs">{t('agentResponse.loading')}</span>
                  </>
                ) : (
                  <>
                    <span className="text-xs">{buttonText}</span>
                    <ChevronRight className="h-3 w-3" aria-hidden="true" />
                  </>
                )}
              </span>
            </Button>
          </div>
        )}

        {/* "Belegt durch": provenance chips for sources this answer carries */}
        <AnswerSourcesRow citations={citations} cards={cards} />
        <CitationsRemovedNote citationsRemoved={citationsRemoved} />

        {/* Footer chips: self-assessed confidence + what Piloti recorded this turn */}
        <div className="flex flex-wrap items-center gap-2">
          {showConfidenceChip && (
            <ConfidenceChip
              confidence={answerConfidence}
              cappedReason={answerConfidenceCappedReason}
            />
          )}
          <MemoryNotedChip projectId={projectId} conversationId={conversationId} />
        </div>

        {/* Per-answer thumbs feedback (WS-7, `answer-feedback` flag) */}
        {showAnswerFeedback && messageId && (
          <AnswerFeedback messageId={messageId} conversationId={conversationId} className="mt-0.5" />
        )}

        {/* Timestamp outside content, right-aligned */}
        {timestamp && (
          <span className="text-subtle mr-3 mt-1 self-end text-xs">
            {formatTime(timestamp)}
          </span>
        )}
      </div>
    )
  }

  // Default variant — the click-dummy "Ergebnis" card: a role tab over a
  // tinted shell whose white inner block carries the composed answer, then a
  // "Belegt durch" provenance row and the feedback row, hairline-separated.
  //
  // A `meta`-routed turn (conversational reply / clarifying Rückfrage) swaps the
  // ink "Ergebnis" tab for a quiet neutral "Hinweis" tab so it reads clearly
  // apart from a substantive Baurecht answer — the only visual change; anatomy,
  // spacing and provenance rows are identical. Any other routing (shallow/deep/
  // error) or an absent signal keeps the "Ergebnis" tab (fail-open).
  const isMeta = routingDecision === 'meta'
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 mx-auto flex w-[680px] max-w-full flex-col duration-200">
      {/* Role tab — uppercase 10.5/600. Substantive answer: near-black action
          fill + check. Meta reply: quiet secondary fill + conversation icon. */}
      {isMeta ? (
        <div className="ml-[14px] inline-flex w-fit items-center gap-1.5 rounded-t-[7px] bg-secondary px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-secondary-foreground">
          <MessageCircle className="size-2.5" strokeWidth={2.6} aria-hidden="true" />
          {t('roles.note')}
        </div>
      ) : (
        <div className="ml-[14px] inline-flex w-fit items-center gap-1.5 rounded-t-[7px] bg-primary px-2.5 py-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-primary-foreground">
          <Check className="size-2.5" strokeWidth={2.6} aria-hidden="true" />
          {t('roles.result')}
        </div>
      )}

      {/* Shell: subtle surface + hairline + soft shadow, corners clipped. A meta
          reply sits on a quieter muted surface with a lighter shadow so the
          whole card — not just the tab — reads as the calmer, non-result kind. */}
      <div
        className={
          isMeta
            ? 'overflow-hidden rounded-[12px] border border-input bg-muted/50 shadow-sm'
            : 'overflow-hidden rounded-[12px] border border-input bg-input-background shadow-md'
        }
      >
        {/* White inner block — the answer body sits flat here (dummy anatomy) */}
        <div className="flex flex-col gap-2 break-words rounded-b-[10px] bg-card px-[22px] pb-[18px] pt-[19px] shadow-sm">
          {/* Optional Grid cards rendered before the markdown body */}
          {hasCards && <GridCards cards={cards} projectId={projectId} />}

          {/* Response Content rendered as markdown (with streaming caret) */}
          <div
            className={
              isStreaming
                ? '[&>.markdown-content>*:last-child]:inline [&>.markdown-content]:inline'
                : undefined
            }
          >
            <MarkdownRenderer content={content} isStreaming={isStreaming} />
            {isStreaming && <StreamingCaret />}
          </div>

          {/* Optional action button stays inside the block */}
          {shouldShowButton && (
            <div className="mt-1 flex items-center justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleViewReport}
                disabled={isLoading}
                aria-label={isLoading ? t('agentResponse.loading') : buttonText}
                title={error ? t('agentResponse.errorTitle', { message: error }) : isLoading ? t('agentResponse.loading') : buttonText}
              >
                <span className="flex items-center gap-1">
                  {isLoading ? (
                    <>
                      <Spinner size="sm" label={t('agentResponse.loadingLabel')} className="h-3 w-3" />
                      <span className="text-xs">{t('agentResponse.loading')}</span>
                    </>
                  ) : (
                    <>
                      <span className="text-xs">{buttonText}</span>
                      <ChevronRight className="h-3 w-3" aria-hidden="true" />
                    </>
                  )}
                </span>
              </Button>
            </div>
          )}
        </div>

        {/* "Belegt durch": provenance chips for sources this answer carries.
            Sits on the tinted shell below the white block. */}
        <div className="px-[22px] pb-3 pt-[11px]">
          <AnswerSourcesRow citations={citations} cards={cards} />
          <CitationsRemovedNote citationsRemoved={citationsRemoved} />
          {/* Footer chips: self-assessed confidence + what Piloti recorded */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {showConfidenceChip && (
              <ConfidenceChip
                confidence={answerConfidence}
                cappedReason={answerConfidenceCappedReason}
              />
            )}
            <MemoryNotedChip projectId={projectId} conversationId={conversationId} />
          </div>
        </div>

        {/* Per-answer thumbs feedback (WS-7) — own row with a divider so it
            reads as its own thing, not a trailing afterthought */}
        {showAnswerFeedback && messageId && (
          <>
            <div className="mx-[22px] border-t border-border/70" />
            <AnswerFeedback
              messageId={messageId}
              conversationId={conversationId}
              className="px-[22px] pb-[16px] pt-[14px]"
            />
          </>
        )}
      </div>

      {/* Timestamp outside the card, right-aligned */}
      {timestamp && (
        <span className="text-subtle mr-3 mt-1 self-end text-xs">{formatTime(timestamp)}</span>
      )}
    </div>
  )
}

/**
 * Memoized so only the streaming answer bubble re-renders as tokens arrive
 * (its `content`/`isStreaming` change); every completed answer above it stays
 * put. React.memo's default shallow prop compare is sufficient here — the
 * props are primitives plus stable store-derived arrays/objects.
 */
export const AgentResponse = memo(AgentResponseComponent)
AgentResponse.displayName = 'AgentResponse'
