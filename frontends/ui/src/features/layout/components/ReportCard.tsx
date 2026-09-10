/**
 * ReportCard Component
 *
 * Card displaying report content with markdown rendering and export functionality.
 * Integrates export actions (Markdown, PDF) from ExportFooter functionality.
 *
 * SSE Events:
 * - artifact.update where data.type === 'output': Final report content
 * - artifact.update where data.type === 'file': Draft file content
 */

'use client'

import { type FC, useCallback } from 'react'
import { Download, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/shared/components/MarkdownRenderer'
import { downloadAsMarkdown } from '@/utils/download-as-markdown'
import { useDownloadPdfRoute } from '@/hooks/use-download-pdf'
import { useIsCurrentSessionBusy } from '@/features/chat'
import { useTranslations } from '@/i18n'
import { DocumentLifecyclePanel } from '@/features/documents/components/document-lifecycle-panel'
import type { DocumentLifecycleViewer } from '@/features/documents/lib/document-lifecycle'

interface ReportCardProps {
  /** Report content in markdown format */
  content: string
  /** Report title */
  title?: string
  /** Whether this is a draft or final version */
  isDraft?: boolean
  /** Whether content is still streaming (deprecated - now checked via store) */
  isStreaming?: boolean
  /**
   * The document this report was FILED as, when it was filed (ADR-0054).
   *
   * Present, the card carries the same review controls the file's own pane does
   * — Einreichen, Freigeben, Änderungen anfordern, Ablehnen, Veröffentlichen —
   * because the reader deciding about a report is looking at the report, and
   * making them find it in Dateien first is the extra step that gets skipped.
   * Absent (a run that filed nothing, a chat outside a project) there is nothing
   * to review and the card is what it always was.
   *
   * The version list is deliberately not here: the pane is where history
   * belongs, and this surface is about the decision on what is on screen.
   */
  filedDocument?: {
    documentId: string
    viewer: DocumentLifecycleViewer
  }
}

/**
 * Calculate word count from content
 */
const getWordCount = (content: string): number => {
  return content.trim().split(/\s+/).filter(Boolean).length
}

/**
 * Card showing report content with export controls.
 */
export const ReportCard: FC<ReportCardProps> = ({
  content,
  title,
  isDraft = false,
  isStreaming: _isStreaming = false, // Deprecated - kept for backward compatibility but not used
  filedDocument,
}) => {
  const t = useTranslations('research')
  const { downloadPdf, isLoading: isPdfLoading } = useDownloadPdfRoute()

  const hasContent = content.trim().length > 0
  const wordCount = hasContent ? getWordCount(content) : 0

  // Uses centralized hook that checks BOTH ephemeral AND persisted state.
  // This survives page refresh: even if SSE ephemeral flags are lost,
  // the hook derives busy state from persisted message history.
  const isDeepResearchInProgress = useIsCurrentSessionBusy()

  const isExportDisabled = !hasContent || isDeepResearchInProgress

  const tooltipContent = isDeepResearchInProgress
    ? t('export.availableWhenComplete')
    : hasContent
      ? t('export.exportReport')
      : t('export.noContent')

  const handleExportMarkdown = useCallback(() => {
    if (isExportDisabled) return
    downloadAsMarkdown(content, title)
  }, [isExportDisabled, content, title])

  const handleExportPDF = useCallback(() => {
    if (isExportDisabled || isPdfLoading) return
    downloadPdf(content, title)
  }, [isExportDisabled, isPdfLoading, content, downloadPdf, title])

  if (!hasContent) {
    return (
      <div className="flex h-full flex-col items-center justify-center py-8 text-center">
        <FileText className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          {t('reportCard.reportWhenComplete')}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('reportCard.exportAsMdPdf')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="mb-4 flex shrink-0 items-center justify-between">
        <div className="flex items-center gap-2">
          {title && <span className="text-sm font-semibold">{title}</span>}
          {isDraft && (
            <span className="rounded border border-warning px-2 py-0.5 text-xs text-warning">
              {t('reportCard.draft')}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {t('reportCard.words', { count: wordCount.toLocaleString() })}
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto pr-2">
        <MarkdownRenderer content={content} />
      </div>

      {/* Freigabe, when this report is a filed document. Above the export row
          and below the report: a decision about the content reads after the
          content, and it is not an export action. */}
      {filedDocument && (
        <DocumentLifecyclePanel
          documentId={filedDocument.documentId}
          viewer={filedDocument.viewer}
          authoredBy="agent"
          showVersions={false}
          className="mt-4 shrink-0 border-t pt-3"
        />
      )}

      {/* Export Footer */}
      <div className="mt-4 flex shrink-0 items-center justify-end gap-2 border-t pt-3">
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
