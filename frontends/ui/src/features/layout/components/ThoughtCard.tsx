/**
 * ThoughtCard Component
 *
 * Card displaying LLM inference activity including model name, streaming content,
 * and thinking/reasoning output (thought traces).
 *
 * SSE Events:
 * - llm.start: Creates card, shows model name and "thinking..." state
 * - llm.chunk: Appends streaming token to content (real-time display)
 * - llm.end: Completes card with final output and thinking metadata
 */

'use client'

import { type FC, useState } from 'react'
import { ChevronDown, MessageSquare } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { useLocale, useTranslations } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import { getWorkflowLabel } from '../lib/workflow-names'

/** Thought trace information from SSE events */
export interface ThoughtInfo {
  /** Unique identifier for this thought trace */
  id: string
  /** LLM model name */
  modelName: string
  /** Streaming or final output content */
  content: string
  /** Chain-of-thought reasoning (from metadata.thinking) */
  thinking?: string
  /**
   * Which part of the run this inference belongs to — the backend's raw role
   * id ("researcher-agent"). Named for the reader by `getWorkflowLabel`; it is
   * an identifier, never something to print.
   */
  workflow?: string
  /** Whether currently receiving chunks */
  isStreaming: boolean
  /** When inference started */
  timestamp?: Date | string
  /**
   * Token usage info (from llm.end). Recorded, deliberately not rendered.
   *
   * `600ea144` renamed the row to „Textmenge" and said in its own message that
   * the rename was a description rather than a fix; `cc7a860f` then deleted the
   * same figure from the deep-research banner for the reason that survives here
   * too. There is no unit a Ziviltechniker has ever been shown, so „1.240
   * Eingabe / 380 Ausgabe" is not a quantity anybody can compare or act on; and
   * it reports a measure of OUR cost inside a view of THEIR reasoning, where
   * nothing follows from it. The number stays on the model for whenever a
   * surface for our own cost earns one.
   */
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

interface ThoughtCardProps {
  /** Thought trace information */
  thought: ThoughtInfo
}

/**
 * Get preview text for collapsed state (prioritize thinking content)
 */
const getPreviewText = (thought: ThoughtInfo): string => {
  const source = thought.thinking || thought.content || ''
  const trimmed = source.substring(0, 130)
  return source.length > 130 ? `${trimmed}...` : trimmed
}

/**
 * Card showing LLM thought traces and output.
 */
export const ThoughtCard: FC<ThoughtCardProps> = ({ thought }) => {
  const [isExpanded, setIsExpanded] = useState(false)
  const t = useTranslations('research')
  const { locale } = useLocale()

  const previewText = getPreviewText(thought)
  const hasPreview = previewText.length > 0

  // Disable expansion while streaming (no content to show yet)
  const canExpand = !thought.isStreaming

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border bg-muted">
      {/* Header - always visible */}
      <button
        type="button"
        onClick={() => canExpand && setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-controls={`thought-content-${thought.id}`}
        className="w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 disabled:cursor-default"
        disabled={!canExpand}
        title={!canExpand ? t('thoughtCard.detailsWhenComplete') : undefined}
      >
        <div className="flex w-full items-center gap-2 px-3 py-2">
          {/* Status Icon - spinner when streaming */}
          {thought.isStreaming ? (
            <Spinner size="sm" label={t('thoughtCard.generating')} className="shrink-0" />
          ) : (
            <span className="shrink-0 text-muted-foreground" aria-hidden="true">
              <MessageSquare className="size-4" />
            </span>
          )}

          {/* Model Info */}
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <span
              className={cn(
                'text-sm font-semibold',
                thought.isStreaming ? 'text-info' : 'text-muted-foreground'
              )}
            >
              {thought.modelName}
            </span>
            {thought.workflow && (
              <span className="truncate text-sm text-muted-foreground">
                {t('thoughtCard.step', { name: getWorkflowLabel(thought.workflow, t) })}
              </span>
            )}
          </div>

          {/* Timestamp - only shown when not streaming */}
          {!thought.isStreaming && thought.timestamp && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatTime(thought.timestamp, locale)}
            </span>
          )}

          {/* Expand/collapse icon - hidden when streaming */}
          {canExpand && (
            <span
              className={cn(
                'text-muted-foreground transition-transform duration-quick motion-reduce:transition-none',
                isExpanded && 'rotate-180'
              )}
              aria-hidden="true"
            >
              <ChevronDown className="size-4" />
            </span>
          )}
        </div>
      </button>

      {/* Collapsed preview - show thinking content preview */}
      {!isExpanded && hasPreview && (
        <div className="flex border-t px-3 pb-2">
          <span className="mt-1 truncate text-sm text-muted-foreground">{previewText}</span>
        </div>
      )}

      {/* Expanded content - show thinking and output together */}
      {isExpanded && (
        <div
          id={`thought-content-${thought.id}`}
          className="flex flex-col gap-3 border-t px-3 pb-3"
        >
          {/* Thinking content (if available) */}
          {thought.thinking && (
            <div className="mt-2 rounded bg-muted p-2 text-sm italic">
              <MarkdownRenderer content={thought.thinking} compact />
            </div>
          )}

          {/* Output content */}
          {thought.content && (
            <div className={cn('flex flex-col gap-1', !thought.thinking && 'mt-2')}>
              <span className="text-xs font-semibold uppercase text-muted-foreground">{t('thoughtCard.output')}</span>
              <MarkdownRenderer content={thought.content} compact />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
