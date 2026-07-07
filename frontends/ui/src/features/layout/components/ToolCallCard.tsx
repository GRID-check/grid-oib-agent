/**
 * ToolCallCard Component
 *
 * Expandable card displaying a single tool invocation with its name, arguments, and result.
 *
 * SSE Events:
 * - tool.start: Creates card with tool name and input arguments
 * - tool.end: Updates card with result/output
 */

'use client'

import { type FC, useState } from 'react'
import { Check, ChevronDown, Clock, X } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'

/** Tool call information from SSE events */
export interface ToolCallInfo {
  /** Unique identifier for this tool call */
  id: string
  /** Tool name (e.g., "tavily_web_search", "write_file") */
  name: string
  /** Tool input arguments */
  arguments?: Record<string, unknown>
  /** Tool output/result (after tool.end) */
  result?: string
  /** Current execution status */
  status: 'pending' | 'running' | 'complete' | 'error'
  /** When tool was called */
  timestamp?: Date | string
  /** Parent agent that invoked the tool */
  workflow?: string
  /** Error message if status is error */
  error?: string
}

interface ToolCallCardProps {
  /** Tool call information */
  toolCall: ToolCallInfo
}

/**
 * Format timestamp for display
 */
const formatTime = (date: Date | string): string => {
  const dateObj = typeof date === 'string' ? new Date(date) : date
  return dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Format tool arguments for display.
 *
 * Handles the _raw/_truncated sentinel created by normalizeToolInput in the
 * adapter layer. When the backend trims a large tool input via Python str(),
 * the adapter wraps the repr string in { _raw, _truncated }. This function
 * detects that sentinel and displays the raw string directly instead of
 * double-quoting it through JSON.stringify.
 */
const formatArguments = (args: Record<string, unknown>, pretty = false): string => {
  if ('_raw' in args && typeof args._raw === 'string') {
    return args._raw
  }
  return pretty ? JSON.stringify(args, null, 2) : JSON.stringify(args)
}

/**
 * Get preview text for collapsed state
 */
const getPreviewText = (toolCall: ToolCallInfo): string => {
  if (toolCall.arguments) {
    const formatted = formatArguments(toolCall.arguments)
    return formatted.length > 100 ? `${formatted.substring(0, 100)}...` : formatted
  }
  return ''
}

/**
 * Expandable card showing a tool call's details.
 */
export const ToolCallCard: FC<ToolCallCardProps> = ({ toolCall }) => {
  const [isExpanded, setIsExpanded] = useState(false)
  const t = useTranslations('research')

  const isRunning = toolCall.status === 'running'
  const isComplete = toolCall.status === 'complete'
  const isError = toolCall.status === 'error'

  // Disable expansion while running (content is still being populated)
  const canExpand = !isRunning

  // Determine text color based on status
  const statusTextClass = isRunning
    ? 'text-info'
    : isComplete
      ? 'text-success'
      : isError
        ? 'text-error'
        : 'text-muted-foreground'

  const previewText = getPreviewText(toolCall)
  const hasPreview = previewText.length > 0

  return (
    <div className="flex flex-col overflow-hidden rounded-lg border bg-muted/40">
      {/* Header - always visible */}
      <button
        type="button"
        onClick={() => canExpand && setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
        aria-controls={`tool-content-${toolCall.id}`}
        className="w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 disabled:cursor-default"
        disabled={!canExpand}
        title={!canExpand ? t('toolCallCard.detailsWhenComplete') : undefined}
      >
        <div className="flex w-full items-center gap-2 px-3 py-2">
          {/* Status Icon - spinner when running */}
          {isRunning ? (
            <Spinner size="sm" label={t('toolCallCard.isRunning', { name: toolCall.name })} className="shrink-0" />
          ) : (
            <span className={cn('shrink-0', statusTextClass)} aria-hidden="true">
              {isComplete ? (
                <Check className="h-4 w-4" />
              ) : isError ? (
                <X className="h-4 w-4" />
              ) : (
                <Clock className="h-4 w-4" />
              )}
            </span>
          )}

          {/* Tool Info */}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className={cn('text-sm font-semibold', statusTextClass)}>{toolCall.name}</span>
            {toolCall.workflow && (
              <span className="truncate text-xs text-muted-foreground">
                {t('toolCallCard.via', { workflow: toolCall.workflow })}
              </span>
            )}
          </div>

          {/* Timestamp */}
          {toolCall.timestamp && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {formatTime(toolCall.timestamp)}
            </span>
          )}

          {/* Expand/collapse icon - hidden when running */}
          {canExpand && (
            <span
              className={cn(
                'text-muted-foreground transition-transform duration-200 motion-reduce:transition-none',
                isExpanded && 'rotate-180'
              )}
              aria-hidden="true"
            >
              <ChevronDown className="h-4 w-4" />
            </span>
          )}
        </div>
      </button>

      {/* Collapsed preview */}
      {!isExpanded && hasPreview && (
        <div className="flex border-t px-3 pb-2">
          <span className="mt-1 truncate font-mono text-sm text-muted-foreground">
            {previewText}
          </span>
        </div>
      )}

      {/* Expanded content */}
      {isExpanded && (
        <div id={`tool-content-${toolCall.id}`} className="flex flex-col gap-3 border-t px-3 pb-3">
          {/* Arguments */}
          {toolCall.arguments && (
            <div className="mt-2 flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                {t('toolCallCard.arguments')}
              </span>
              <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">
                {formatArguments(toolCall.arguments, true)}
              </pre>
            </div>
          )}

          {/* Result */}
          {toolCall.result && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase text-muted-foreground">{t('toolCallCard.result')}</span>
              <pre className="max-h-48 overflow-x-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
                {toolCall.result}
              </pre>
            </div>
          )}

          {/* Error */}
          {toolCall.error && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase text-error">{t('toolCallCard.error')}</span>
              <span className="text-sm text-error">{toolCall.error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
