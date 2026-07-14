/**
 * ReportTab Component
 *
 * Displays research output in two visual modes:
 *   1. Research Notes (intermediate) -- preview styling with a header badge
 *   2. Final Report -- full-width rendered markdown with export footer
 *
 * Final reports get citation affordances:
 *   - a trailing sources section (## Sources / ## Quellen) is rendered as an
 *     anchored list so inline [N] markers become clickable links that scroll
 *     to the matching entry;
 *   - when the markdown has no sources section but the run collected cited
 *     sources, a localized "Sources"/"Quellen" list is appended from the store.
 *
 * Shows streaming indicator when report is being generated.
 * Includes export footer for Markdown and PDF export (final report only).
 */

'use client'

import { type FC, type ReactNode, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FileText } from 'lucide-react'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { Badge, type BadgeProps } from '@/components/ui/badge'
import { useChatStore } from '@/features/chat'
import { GridCards } from '@/features/grid-cards'
import { useTranslations } from '@/i18n'
import {
  REPORT_SOURCE_ANCHOR_PREFIX,
  linkifyCitationMarkers,
  splitReportSources,
  type ReportSourceEntry,
  type ReportSourceKind,
} from '../lib/report-citations'
import { ExportFooter } from './ExportFooter'

/**
 * Badge variant per source origin. The knowledge base carries the single blue
 * accent (trusted, primary source); web and the official Austrian legal system
 * (RIS) stay in muted, neutral tones per the design language.
 */
const SOURCE_KIND_BADGE_VARIANT: Record<ReportSourceKind, BadgeProps['variant']> = {
  kb: 'info',
  web: 'secondary',
  ris: 'outline',
}

interface ReportTabProps {
  /** Optional custom content to display instead of store content */
  children?: ReactNode
}

/**
 * Anchored sources list rendered below the report body. Each entry carries a
 * DOM id so inline [N] anchor links (handled by MarkdownRenderer) can scroll
 * to it.
 */
const ReportSourcesList: FC<{
  heading: string
  entries: ReportSourceEntry[]
  sourceBadgeLabel: (kind: ReportSourceKind) => string
}> = ({ heading, entries, sourceBadgeLabel }) => (
  <section aria-label={heading}>
    <h2 className="mb-2 mt-5 text-xl font-semibold tracking-tight text-foreground">{heading}</h2>
    <ol className="list-none space-y-1 pl-0">
      {entries.map((entry) => (
        <li
          key={entry.number}
          id={`${REPORT_SOURCE_ANCHOR_PREFIX}${entry.number}`}
          className="flex scroll-mt-4 items-baseline gap-2 text-sm text-foreground"
        >
          <span className="shrink-0 text-muted-foreground">[{entry.number}]</span>
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            {entry.sourceKind && (
              <Badge
                variant={SOURCE_KIND_BADGE_VARIANT[entry.sourceKind]}
                className="shrink-0 self-center"
              >
                {sourceBadgeLabel(entry.sourceKind)}
              </Badge>
            )}
            <div className="min-w-0">
              <MarkdownRenderer content={entry.markdown} compact className="max-w-none" />
            </div>
          </div>
        </li>
      ))}
    </ol>
  </section>
)

/**
 * Report tab content - displays research output.
 * Subscribes to chat store for report content, category, and streaming state.
 * Renders research notes with a subtle preview treatment and the final report at full prominence.
 */
export const ReportTab: FC<ReportTabProps> = ({ children }) => {
  const t = useTranslations('research')
  const {
    reportContent,
    reportContentCategory,
    isStreaming,
    currentStatus,
    deepResearchCards,
    deepResearchCitations,
    projectId,
  } = useChatStore(
    useShallow((s) => ({
      reportContent: s.reportContent,
      reportContentCategory: s.reportContentCategory,
      isStreaming: s.isStreaming,
      currentStatus: s.currentStatus,
      deepResearchCards: s.deepResearchCards,
      deepResearchCitations: s.deepResearchCitations,
      projectId: s.projectId,
    }))
  )

  const reportContentStr = typeof reportContent === 'string' ? reportContent : ''
  const cards = deepResearchCards ?? []
  const isEmpty = !reportContentStr.trim()
  const isGeneratingReport = isStreaming && currentStatus === 'writing'
  const isResearchNotes = reportContentCategory === 'research_notes'

  // Citation handling for the final report:
  //  - extract a markdown sources section (if any) and render it with
  //    per-entry anchors, linkifying inline [N] markers to those anchors;
  //  - otherwise fall back to the cited sources collected during the run.
  const { body, sourceEntries, sourcesHeading } = useMemo(() => {
    if (isResearchNotes || !reportContentStr.trim()) {
      return { body: reportContentStr, sourceEntries: [], sourcesHeading: null as string | null }
    }
    const split = splitReportSources(reportContentStr)
    if (split.entries.length === 0) {
      return { body: reportContentStr, sourceEntries: [], sourcesHeading: null as string | null }
    }
    const validNumbers = new Set(split.entries.map((entry) => entry.number))
    return {
      body: linkifyCitationMarkers(split.body, validNumbers),
      sourceEntries: split.entries,
      sourcesHeading: split.heading,
    }
  }, [isResearchNotes, reportContentStr])

  // Fallback sources list from run citations, only when the markdown itself
  // has no sources section and the run is complete enough to trust the list.
  const citedFallbackSources = useMemo(() => {
    if (isResearchNotes || sourceEntries.length > 0 || isGeneratingReport) return []
    return (deepResearchCitations ?? []).filter((citation) => citation.isCited)
  }, [isResearchNotes, sourceEntries.length, isGeneratingReport, deepResearchCitations])

  return (
    <div className="flex h-full flex-col">
      {/* Scrollable content area */}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
        {children ? (
          children
        ) : isEmpty ? (
          <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
            <FileText className="mb-3 h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              {t('reportTab.contentWhenAvailable')}
            </p>
          </div>
        ) : isResearchNotes ? (
          /* Research notes: preview treatment */
          <div className="flex flex-1 flex-col gap-3">
            <div className="flex shrink-0 items-center gap-2 rounded-md border border-warning bg-warning-subtle px-3 py-2">
              <div className="h-2 w-2 animate-pulse rounded-full bg-warning motion-reduce:animate-none" />
              <span className="text-sm text-warning">
                {t('reportTab.notesBanner')}
              </span>
            </div>
            <div className="flex-1 opacity-80">
              <MarkdownRenderer
                content={reportContentStr}
                isStreaming={false}
                className="max-w-none"
              />
            </div>
          </div>
        ) : (
          /* Final report: full prominence, with Grid cards when available */
          <div className="flex flex-1 flex-col gap-4">
            {cards.length > 0 && <GridCards cards={cards} projectId={projectId} />}
            <MarkdownRenderer
              content={body}
              isStreaming={isGeneratingReport}
              className="max-w-none"
            />
            {sourceEntries.length > 0 && (
              <ReportSourcesList
                heading={sourcesHeading ?? t('reportTab.sourcesTitle')}
                entries={sourceEntries}
                sourceBadgeLabel={(kind) => t(`reportTab.sourceBadge.${kind}`)}
              />
            )}
            {citedFallbackSources.length > 0 && (
              <section aria-label={t('reportTab.sourcesTitle')}>
                <h2 className="mb-2 mt-5 text-xl font-semibold tracking-tight text-foreground">
                  {t('reportTab.sourcesTitle')}
                </h2>
                <ol className="list-outside list-decimal space-y-1 pl-5">
                  {citedFallbackSources.map((citation) => (
                    <li key={citation.id} className="text-sm text-foreground">
                      <a
                        href={citation.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand underline underline-offset-2 hover:opacity-80 [overflow-wrap:anywhere]"
                      >
                        {citation.url}
                      </a>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        )}
      </div>

      {/* Export footer - only meaningful for the final report */}
      <ExportFooter />
    </div>
  )
}
