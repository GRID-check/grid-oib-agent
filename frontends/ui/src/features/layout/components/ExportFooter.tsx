/**
 * ExportFooter Component
 *
 * Footer with export actions for reports.
 * Provides buttons to export content as Markdown or PDF.
 */

'use client'

import { type FC, useCallback, useState } from 'react'
import { Download, X } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useChatStore, useIsCurrentSessionBusy } from '@/features/chat'
import { downloadAsMarkdown } from '@/utils/download-as-markdown'
import { useDownloadPdfRoute } from '@/hooks/use-download-pdf'

interface ExportFooterProps {
  /** Whether to disable export buttons (e.g., when no content) */
  disabled?: boolean
}

/**
 * Export footer with Markdown and PDF export buttons.
 * Only renders when there's content to export.
 */
export const ExportFooter: FC<ExportFooterProps> = ({ disabled }) => {
  const reportContent = useChatStore((state) => state.reportContent)
  const conversationTitle = useChatStore((state) => state.currentConversation?.title)
  const {
    downloadPdf,
    isLoading: isPdfLoading,
    error: pdfError,
    clearError: clearPdfError,
  } = useDownloadPdfRoute()
  const [mdError, setMdError] = useState<string | null>(null)

  // Defensive check: ensure reportContent is a string before calling trim()
  const reportContentStr = typeof reportContent === 'string' ? reportContent : ''
  const hasContent = reportContentStr.trim().length > 0

  // Uses centralized hook that checks BOTH ephemeral AND persisted state.
  // This survives page refresh: even if SSE ephemeral flags are lost,
  // the hook derives busy state from persisted message history.
  const isDeepResearchInProgress = useIsCurrentSessionBusy()

  const isExportDisabled = disabled || !hasContent || isDeepResearchInProgress

  const tooltipContent = isDeepResearchInProgress
    ? 'Export will be available when research is complete'
    : hasContent
      ? 'Export report'
      : 'No content to export'

  const handleExportMarkdown = useCallback(() => {
    if (isExportDisabled) return
    setMdError(null)
    const result = downloadAsMarkdown(reportContentStr, conversationTitle ?? undefined)
    if (!result.success && result.error) {
      setMdError(result.error)
    }
  }, [isExportDisabled, reportContentStr, conversationTitle])

  const handleExportPDF = useCallback(() => {
    if (isExportDisabled || isPdfLoading) return
    downloadPdf(reportContentStr, conversationTitle ?? undefined)
  }, [isExportDisabled, isPdfLoading, reportContentStr, downloadPdf, conversationTitle])

  const exportError = mdError || pdfError
  const clearExportError = useCallback(() => {
    setMdError(null)
    clearPdfError()
  }, [clearPdfError])

  return (
    <div className="flex shrink-0 flex-col border-t">
      {exportError && (
        <Alert variant="destructive" className="mx-4 mt-3">
          <AlertDescription className="flex w-full items-start justify-between gap-2">
            <span>{exportError}</span>
            <button
              type="button"
              onClick={clearExportError}
              aria-label="Dismiss error"
              className="shrink-0 rounded-xs opacity-70 transition-opacity hover:opacity-100"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleExportMarkdown}
          disabled={isExportDisabled}
          aria-label={
            isExportDisabled ? `Export as Markdown (${tooltipContent})` : 'Export as Markdown'
          }
          title={tooltipContent}
        >
          <Download aria-hidden="true" />
          Markdown
        </Button>
        <Button
          size="sm"
          onClick={handleExportPDF}
          disabled={isExportDisabled || isPdfLoading}
          aria-label={
            isPdfLoading
              ? 'Generating PDF...'
              : isExportDisabled
                ? `Export as PDF (${tooltipContent})`
                : 'Export as PDF'
          }
          title={isPdfLoading ? 'Generating PDF...' : tooltipContent}
        >
          <Download aria-hidden="true" />
          {isPdfLoading ? 'Generating...' : 'PDF'}
        </Button>
      </div>
    </div>
  )
}
