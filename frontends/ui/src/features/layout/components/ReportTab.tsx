/**
 * ReportTab Component
 *
 * Displays research output in two visual modes:
 *   1. Research Notes (intermediate) -- preview styling with a header badge
 *   2. Final Report -- full-width rendered markdown with export footer
 *
 * Shows streaming indicator when report is being generated.
 * Includes export footer for Markdown and PDF export (final report only).
 */

'use client'

import { type FC, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { FileText } from 'lucide-react'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { useChatStore } from '@/features/chat'
import { ExportFooter } from './ExportFooter'

interface ReportTabProps {
  /** Optional custom content to display instead of store content */
  children?: ReactNode
}

/**
 * Report tab content - displays research output.
 * Subscribes to chat store for report content, category, and streaming state.
 * Renders research notes with a subtle preview treatment and the final report at full prominence.
 */
export const ReportTab: FC<ReportTabProps> = ({ children }) => {
  const { reportContent, reportContentCategory, isStreaming, currentStatus } = useChatStore(
    useShallow((s) => ({
      reportContent: s.reportContent,
      reportContentCategory: s.reportContentCategory,
      isStreaming: s.isStreaming,
      currentStatus: s.currentStatus,
    }))
  )

  const reportContentStr = typeof reportContent === 'string' ? reportContent : ''
  const isEmpty = !reportContentStr.trim()
  const isGeneratingReport = isStreaming && currentStatus === 'writing'
  const isResearchNotes = reportContentCategory === 'research_notes'

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
              Report content will appear here when available.
            </p>
          </div>
        ) : isResearchNotes ? (
          /* Research notes: preview treatment */
          <div className="flex flex-1 flex-col gap-3">
            <div className="flex shrink-0 items-center gap-2 rounded-md border border-[var(--border-color-feedback-warning)] bg-[var(--background-color-feedback-warning-subtle)] px-3 py-2">
              <div className="h-2 w-2 animate-pulse rounded-full bg-[var(--text-color-feedback-warning)] motion-reduce:animate-none" />
              <span className="text-sm text-[var(--text-color-feedback-warning)]">
                Research notes from agents — final report is still being generated.
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
          /* Final report: full prominence */
          <div className="flex-1">
            <MarkdownRenderer
              content={reportContentStr}
              isStreaming={isGeneratingReport}
              className="max-w-none"
            />
          </div>
        )}
      </div>

      {/* Export footer - only meaningful for the final report */}
      <ExportFooter />
    </div>
  )
}
