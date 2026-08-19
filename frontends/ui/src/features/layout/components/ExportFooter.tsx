/**
 * ExportFooter Component
 *
 * Footer with export actions for reports.
 * Provides buttons to export content as Markdown or PDF.
 */

'use client'

import { type FC, useCallback, useState } from 'react'
import { Download, Eye, EyeOff, X } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useChatStore, useIsCurrentSessionBusy } from '@/features/chat'
import { useReportPreviewStore } from '@/features/report-preview'
import { downloadAsMarkdown } from '@/utils/download-as-markdown'
import { useDownloadPdfRoute } from '@/hooks/use-download-pdf'
import { useTranslations } from '@/i18n'

interface ExportFooterProps {
  /** Whether to disable export buttons (e.g., when no content) */
  disabled?: boolean
}

/**
 * Export footer with Markdown and PDF export buttons.
 * Only renders when there's content to export.
 */
export const ExportFooter: FC<ExportFooterProps> = ({ disabled }) => {
  const t = useTranslations('research')
  const tFiles = useTranslations('files')
  // The noun for a preview already exists in the dictionary; a second copy of
  // the same word is one more string to keep in step with the German for no
  // gain. `answerExport` is where an exported document's own chrome is named,
  // which is what this button opens.
  const tExport = useTranslations('answerExport')
  const reportContent = useChatStore((state) => state.reportContent)
  const conversationTitle = useChatStore((state) => state.currentConversation?.title)
  const {
    downloadPdf,
    isLoading: isPdfLoading,
    error: pdfError,
    clearError: clearPdfError,
  } = useDownloadPdfRoute()
  const [mdError, setMdError] = useState<string | null>(null)
  const isPreviewOpen = useReportPreviewStore((state) => state.open)
  const togglePreview = useReportPreviewStore((state) => state.togglePreview)

  // Defensive check: ensure reportContent is a string before calling trim()
  const reportContentStr = typeof reportContent === 'string' ? reportContent : ''
  const hasContent = reportContentStr.trim().length > 0

  // Uses centralized hook that checks BOTH ephemeral AND persisted state.
  // This survives page refresh: even if SSE ephemeral flags are lost,
  // the hook derives busy state from persisted message history.
  const isDeepResearchInProgress = useIsCurrentSessionBusy()

  const isExportDisabled = disabled || !hasContent || isDeepResearchInProgress

  const tooltipContent = isDeepResearchInProgress
    ? t('export.availableWhenComplete')
    : hasContent
      ? t('export.exportReport')
      : t('export.noContent')

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
              aria-label={t('dismissError')}
              className="shrink-0 rounded-xs opacity-70 transition-opacity duration-quick ease-out hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        {/* The PDF, in the app, before it leaves it. Sits with the export
            actions because it is the same document by another route — you look
            at it here, and download it from the button beside it.

            DISABLED ONLY WHILE CLOSED. Sharing `isExportDisabled` outright
            would trap the reader: research starting again (a follow-up
            question) flips the busy flag while the pane is still on screen, and
            a disabled toggle is then the only way to close the only pane that
            is open. Opening is the action that needs a finished report; closing
            never does. */}
        <Button
          // Outlined rather than ghost: this is the one affordance in the
          // footer that keeps the reader here instead of sending a file out of
          // the product, and a ghost button beside two others is not findable.
          // Filled while open, so the toggle's own state is visible without
          // reading the tooltip.
          variant={isPreviewOpen ? 'secondary' : 'outline'}
          size="sm"
          onClick={togglePreview}
          disabled={isExportDisabled && !isPreviewOpen}
          aria-pressed={isPreviewOpen}
          aria-label={
            isPreviewOpen ? tFiles('preview.closePreview') : tFiles('preview.expandPreview')
          }
          title={
            isPreviewOpen
              ? tFiles('preview.closePreview')
              : isExportDisabled
                ? tooltipContent
                : tFiles('preview.expandPreview')
          }
          data-testid="report-preview-toggle"
        >
          {isPreviewOpen ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          {tExport('fields.preview')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleExportMarkdown}
          disabled={isExportDisabled}
          aria-label={
            isExportDisabled
              ? t('export.asMarkdownDisabled', { reason: tooltipContent })
              : t('export.asMarkdown')
          }
          title={tooltipContent}
        >
          <Download aria-hidden="true" />
          {t('export.markdown')}
        </Button>
        <Button
          size="sm"
          onClick={handleExportPDF}
          disabled={isExportDisabled || isPdfLoading}
          aria-label={
            isPdfLoading
              ? t('export.generatingPdf')
              : isExportDisabled
                ? t('export.asPdfDisabled', { reason: tooltipContent })
                : t('export.asPdf')
          }
          title={isPdfLoading ? t('export.generatingPdf') : tooltipContent}
        >
          <Download aria-hidden="true" />
          {isPdfLoading ? t('export.generating') : t('export.pdf')}
        </Button>
      </div>
    </div>
  )
}
