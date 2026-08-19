'use client'

/**
 * The report's PDF, in the app, beside the report.
 *
 * Until this pane existed the PDF was download-only: the reader pressed
 * "Export as PDF", waited, opened a file in another application, and only there
 * found out whether a heading broke across a page or a table lost a column.
 * Everything the export does to the document — the typography, the page breaks,
 * the sources list — was invisible on the surface where it could still be acted
 * on. This shows it where the report is.
 *
 * Rendered with the browser's own PDF viewer through an `<iframe>`, the same
 * way `FilePreviewPane` shows an uploaded PDF. The pdf.js viewer in
 * `knowledge/components/pdf-viewer-dialog` exists for the full-screen reading
 * case (page controls, search, zoom); a side pane wants the smaller, faster
 * thing, and a viewer that is already the reader's own.
 *
 * Every state here is named rather than blank. A pane that shows nothing while
 * a PDF is being generated is indistinguishable from a pane that is broken.
 */

import { type FC, type ReactNode } from 'react'
import { FileText, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { motion, springDrawer } from '@/components/motion'
import { useChatStore, useIsCurrentSessionBusy } from '@/features/chat'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
import { useTranslations } from '@/i18n'
import { useReportPdfPreview } from '../hooks/use-report-pdf-preview'

export const ReportPdfPreview: FC<{ onClose: () => void }> = ({ onClose }) => {
  const t = useTranslations('research')
  const tFiles = useTranslations('files')
  const prefersReducedMotion = useReducedMotion()

  const reportContent = useChatStore((state) => state.reportContent)
  const conversationTitle = useChatStore((state) => state.currentConversation?.title)
  // The SAME busy signal the export buttons use, for the same reason: a report
  // that is still being written renders to a PDF of a half-finished document,
  // and the reader has no way to tell that from the finished one.
  const isResearchInProgress = useIsCurrentSessionBusy()

  const markdown = typeof reportContent === 'string' ? reportContent : ''
  const hasContent = markdown.trim().length > 0
  const { status, url, error, retry } = useReportPdfPreview({
    markdown,
    enabled: hasContent && !isResearchInProgress,
  })

  const documentLabel = conversationTitle?.trim() || t('researchPanel.tabReport')

  return (
    // The PANEL sets the width, in one pass; this only carries the arrival, on
    // a transform. Animating the width instead would re-lay-out the report
    // column beside it on every frame (`grid-design-language.md` §"Binding
    // constraints"), which is the whole reason the panel owns the size.
    <motion.div
      className="flex h-full min-h-0 flex-col border-l bg-card"
      initial={prefersReducedMotion ? false : { opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={prefersReducedMotion ? { duration: 0 } : springDrawer}
      data-testid="report-pdf-preview"
      data-status={status}
      role="complementary"
      aria-label={tFiles('preview.dialogLabel', { name: documentLabel })}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2.5">
        <p className="min-w-0 flex-1 truncate text-xs font-medium tracking-[-0.01em] text-foreground">
          {t('export.pdf')}
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={onClose}
          aria-label={tFiles('preview.closePreview')}
          title={tFiles('preview.closePreview')}
          data-testid="report-pdf-preview-close"
        >
          <X className="size-3.5" aria-hidden="true" />
        </Button>
      </div>

      {/* The ground under the document — the same treatment as the file peek,
          so a generated PDF and an uploaded one read as the same kind of thing. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden bg-gradient-to-b from-muted/25 to-muted/60 p-3">
        {isResearchInProgress ? (
          <PreviewMessage icon={<Loader2 className="size-5 animate-spin motion-reduce:animate-none" />}>
            {t('export.availableWhenComplete')}
          </PreviewMessage>
        ) : !hasContent ? (
          <PreviewMessage icon={<FileText className="size-5" />}>
            {t('reportTab.contentWhenAvailable')}
          </PreviewMessage>
        ) : status === 'error' ? (
          <div
            role="alert"
            className="flex max-w-xs flex-col items-center gap-3 text-center text-sm text-muted-foreground"
          >
            <p className="text-foreground">{tFiles('preview.loadFailed')}</p>
            {/* The server's own words, kept. "Something went wrong" tells a
                reader nothing they can pass on to whoever can fix it. */}
            {error && <p className="text-xs">{error}</p>}
            <Button variant="outline" size="sm" onClick={retry}>
              <RefreshCw aria-hidden="true" />
              {tFiles('preview.tryAgain')}
            </Button>
          </div>
        ) : status === 'ready' && url ? (
          <iframe
            src={url}
            title={tFiles('preview.dialogLabel', { name: documentLabel })}
            className="size-full rounded-lg border bg-background shadow-xs"
          />
        ) : (
          <PreviewMessage
            role="status"
            icon={<Loader2 className="size-5 animate-spin motion-reduce:animate-none" />}
          >
            {t('export.generatingPdf')}
          </PreviewMessage>
        )}
      </div>
    </motion.div>
  )
}

const PreviewMessage: FC<{
  icon: ReactNode
  role?: 'status'
  children: ReactNode
}> = ({ icon, role, children }) => (
  <div
    role={role}
    className="flex max-w-xs flex-col items-center gap-2 text-center text-sm text-muted-foreground"
  >
    <span aria-hidden="true">{icon}</span>
    <p>{children}</p>
  </div>
)
