/**
 * ChatThinking Component
 *
 * Displays a collapsible panel of intermediate thinking steps from the agent.
 * Shows a status header (spinner while working, check when done) and a flat
 * chronological list of all steps with displayName + timestamp.
 *
 * Uses shadcn Collapsible for expand/collapse behavior.
 */

'use client'

import { type FC } from 'react'
import { ChevronDown, CheckCircle2, AlertTriangle, Clock } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { motion } from '@/components/motion'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import type { ThinkingStep } from '../types'

export interface ChatThinkingProps {
  /** Array of thinking steps to display */
  steps: ThinkingStep[]
  /** Whether thinking is in progress (shows spinner when true, check when false) */
  isThinking?: boolean
  /** Whether the response was interrupted (page refresh / browser close mid-stream) */
  isInterrupted?: boolean
  /** Whether waiting for user response (HITL prompt pending) */
  isWaiting?: boolean
  /** Data sources that were enabled for this query */
  enabledDataSources?: string[]
  /** Files that were available for this query */
  messageFiles?: Array<{ id: string; fileName: string }>
}

/**
 * Format data source ID to display name
 */
const formatDataSourceName = (sourceId: string, t: Translator): string => {
  // Handle special cases
  if (sourceId === 'web_search') return t('thinking.dataSource.webSearch')
  if (sourceId === 'knowledge_layer') return t('thinking.dataSource.files')

  // Convert snake_case to Title Case
  return sourceId
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

/**
 * ChatThinking - collapsible thinking steps panel
 */
export const ChatThinking: FC<ChatThinkingProps> = ({
  steps,
  isThinking = true,
  isInterrupted = false,
  isWaiting = false,
  enabledDataSources = [],
  messageFiles = [],
}) => {
  const t = useTranslations('chat')
  // Prepare data sources summary (exclude knowledge_layer as we'll show files separately)
  const dataSourcesDisplay = enabledDataSources
    .filter((source) => source !== 'knowledge_layer')
    .map((source) => formatDataSourceName(source, t))
    .join(', ')

  const hasDataSources = dataSourcesDisplay.length > 0
  const hasFiles = messageFiles.length > 0

  // Show component if there are steps OR if there are data sources/files to display
  if (steps.length === 0 && !hasDataSources && !hasFiles) {
    return null
  }

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 w-full rounded-2xl bg-muted/50 shadow-xs duration-200 ease-out">
      <Collapsible>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="group flex w-full cursor-pointer items-center justify-between rounded-2xl px-4 pb-4 pt-3 text-left outline-none transition-colors duration-200 ease-out focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label={t('thinking.showThinkingSteps', { count: steps.length })}
          >
            {/* Left: status indicator */}
            <span className="flex items-center gap-2">
              {isThinking ? (
                <>
                  <Spinner size="sm" label={t('thinking.inProgress')} />
                  {/* Gentle opacity pulse — a genuine loading state, so a loop is OK */}
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

            {/* Right: toggle indicator */}
            <span className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">
                {t('thinking.showThinking', { count: steps.length })}
              </span>
              <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
            </span>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div
            className="border-base flex flex-col border-t px-4 pb-4 pt-4"
            role="list"
            aria-label={t('thinking.stepsLabel')}
          >
            {/* Thinking Steps: 3 levels — Workflow (0) | Function Start/Complete (1) | model/tool (2) */}
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
                  <span className="min-w-0 truncate text-sm text-foreground">
                    {step.displayName}
                  </span>
                  <span className="shrink-0 pl-4 text-xs text-muted-foreground">
                    {formatTime(step.timestamp)}
                  </span>
                </div>
              )
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Data Sources Summary — always visible below the collapsible */}
      {(hasDataSources || hasFiles) && (
        <div className="border-base flex flex-col border-t px-4 pb-5 pt-3">
          <span className="mb-1 text-sm font-semibold text-foreground">
            {t('thinking.selectedDataSources')}
          </span>
          {hasDataSources && (
            <span className="text-sm text-foreground">{dataSourcesDisplay}</span>
          )}
          {hasFiles && (
            <span className="text-xs text-muted-foreground">
              {messageFiles.map((f) => f.fileName).join(', ')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
