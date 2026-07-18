/**
 * ChatThinking — collapsible Herleitung panel (click-dummy overhaul spec §7).
 *
 * Collapsed: status + "Herleitung · n Zwischenschritte · m Quellen".
 * Expanded: parallel per-document source cards (tab · name · detail · Treffer)
 * matching the click-dummy `traceSources[]`, plus chronological steps.
 */

'use client'

import { type FC, useMemo } from 'react'
import { ChevronDown, CheckCircle2, AlertTriangle, Clock } from 'lucide-react'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import { motion } from '@/components/motion'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import type { Translator } from '@/i18n'
import { formatTime } from '@/shared/utils/format-time'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import type { ThinkingStep } from '../types'
import { deriveTraceSourceCards, type TraceSourceCard } from '../lib/trace-lanes'

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
}

/**
 * Format data source ID to display name
 */
const formatDataSourceName = (sourceId: string, t: Translator): string => {
  if (sourceId === 'web_search') return t('thinking.dataSource.webSearch')
  if (sourceId === 'knowledge_layer') return t('thinking.dataSource.knowledgeBase')
  if (sourceId === 'ris') return t('thinking.dataSource.ris')

  return sourceId
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

const SourceCard: FC<{ card: TraceSourceCard; hitLabel: string; gapLabel: string }> = ({
  card,
  hitLabel,
  gapLabel,
}) => {
  const hitsText = card.kind === 'gap' ? gapLabel : hitLabel
  return (
    <div
      role="listitem"
      className="flex flex-col gap-1.5 rounded-xl border bg-background/70 px-3 py-2.5 shadow-xs"
      style={{
        borderColor: `color-mix(in oklch, var(--source-${card.signal}, var(--border)) 40%, transparent)`,
        boxShadow: `inset 3px 0 0 0 var(--source-${card.signal}, var(--border))`,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <SourceSignalChip signal={card.signal}>{card.tabLabel}</SourceSignalChip>
        <span
          className={
            card.kind === 'gap'
              ? 'shrink-0 text-[11px] font-medium text-muted-foreground'
              : 'shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground'
          }
        >
          {hitsText}
        </span>
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-foreground" title={card.name}>
          {card.name}
        </div>
        {card.detail && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground" title={card.detail}>
            {card.detail}
          </div>
        )}
      </div>
    </div>
  )
}

export const ChatThinking: FC<ChatThinkingProps> = ({
  steps,
  isThinking = true,
  isInterrupted = false,
  isWaiting = false,
  enabledDataSources = [],
  messageFiles = [],
}) => {
  const t = useTranslations('chat')

  const dataSourcesDisplay = enabledDataSources
    .map((source) => formatDataSourceName(source, t))
    .join(', ')

  const hasDataSources = dataSourcesDisplay.length > 0
  const hasFiles = messageFiles.length > 0

  const sourceCards = useMemo(() => deriveTraceSourceCards(steps), [steps])
  // Unique source cards (hits + gaps) — bar "m Quellen", not sum of Treffer.
  const sourceCount = sourceCards.length

  if (steps.length === 0 && !hasDataSources && !hasFiles) {
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
          <div className="border-base flex flex-col gap-4 border-t px-4 pb-4 pt-4">
            {/* Parallel per-document source cards (click-dummy traceSources) */}
            {sourceCards.length > 0 && (
              <div
                className="grid grid-cols-1 gap-2 sm:grid-cols-2"
                role="list"
                aria-label={t('thinking.sourcesFanOut')}
              >
                {sourceCards.map((card) => (
                  <SourceCard
                    key={card.id}
                    card={card}
                    hitLabel={t('thinking.hitCount', { count: card.hitCount })}
                    gapLabel={t('thinking.gapHit')}
                  />
                ))}
              </div>
            )}

            {/* Technical NAT steps — secondary, collapsed by default */}
            {steps.length > 0 && (
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
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>

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
