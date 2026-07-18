/**
 * AgentResponse Component
 *
 * Displays a completed agent response in the chat area.
 * Used for short answers that don't need the full report panel.
 * Left-aligned with distinct styling from user messages.
 */

'use client'

import { type FC, useCallback } from 'react'
import { ChevronRight } from 'lucide-react'
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
}

/**
 * Agent response bubble component for completed responses
 */
export const AgentResponse: FC<AgentResponseProps> = ({
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
  showConfidenceChip = true,
  messageId,
  showAnswerFeedback = true,
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

        {/* Response Content rendered as markdown */}
        <MarkdownRenderer content={content} />

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

        {/* Footer chips: self-assessed confidence + what Piloti recorded this turn */}
        <div className="flex flex-wrap items-center gap-2">
          {showConfidenceChip && <ConfidenceChip confidence={answerConfidence} />}
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

  // Default variant - with box styling
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex w-full justify-start duration-200">
      <div className="flex max-w-[85%] flex-col">
        <div className="flex flex-col gap-2 overflow-hidden break-words rounded-2xl rounded-bl-md bg-card p-4">
          {/* Optional Grid cards rendered before the markdown body */}
          {hasCards && <GridCards cards={cards} projectId={projectId} />}

          {/* Response Content rendered as markdown */}
          <MarkdownRenderer content={content} />

          {/* Optional action button stays inside the bubble */}
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
        </div>

        {/* Footer chips: self-assessed confidence + what Piloti recorded this turn */}
        <div className="mt-1.5 flex flex-wrap items-center justify-start gap-2 px-1">
          {showConfidenceChip && <ConfidenceChip confidence={answerConfidence} />}
          <MemoryNotedChip projectId={projectId} conversationId={conversationId} />
        </div>

        {/* Per-answer thumbs feedback (WS-7, `answer-feedback` flag) */}
        {showAnswerFeedback && messageId && (
          <AnswerFeedback messageId={messageId} conversationId={conversationId} className="mt-1.5 px-1" />
        )}

        {/* Timestamp outside bubble, right-aligned */}
        {timestamp && (
          <span className="text-subtle mr-3 mt-1 self-end text-xs">
            {formatTime(timestamp)}
          </span>
        )}
      </div>
    </div>
  )
}
