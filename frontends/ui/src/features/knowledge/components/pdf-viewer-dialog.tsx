'use client'

/**
 * In-app source PDF viewer — a wide dialog with the browser's native PDF
 * rendering in an iframe. Used by clicked chat citations and the knowledge
 * pages so users can read the actual document the assistant grounded on.
 * `page` deep-links via the standard `#page=N` viewer fragment.
 */

import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslations } from '@/i18n'

export interface PdfViewerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Base-corpus PDF filename served by /api/knowledge-base/documents. */
  fileName: string
  /** 1-based page to jump to (browser PDF viewer fragment). */
  page?: number | null
  /** Optional heading; defaults to the filename. */
  title?: string
  /**
   * Explicit document URL to render (e.g. a presigned preview URL for a
   * project-uploaded file). When set it overrides the base-corpus path built
   * from `fileName`, letting non-corpus surfaces (the Files preview pane) reuse
   * this viewer. `page` is appended as a `#page=N` fragment when provided.
   */
  src?: string
  /**
   * Render the source as an image (`<img>` in a scrollable frame) instead of
   * the PDF iframe. Lets the Files preview pane reuse this dialog to enlarge
   * standalone image uploads (FB-15a). The `#page=N` fragment does not apply.
   */
  isImage?: boolean
  /**
   * Optional chip rendered inline before the title (WS-9 source preview:
   * the provenance-tinted document-type chip). Purely additive — omitted,
   * the header renders exactly as before.
   */
  headerChip?: ReactNode
  /**
   * Optional content rendered between the header and the document frame
   * (WS-9: the tinted "Fundstelle"/cited-passage box). Purely additive.
   */
  children?: ReactNode
}

export function PdfViewerDialog({ open, onOpenChange, fileName, page, title, src: srcOverride, isImage, headerChip, children }: PdfViewerDialogProps) {
  const t = useTranslations('knowledge')
  const baseSrc = srcOverride ?? `/api/knowledge-base/documents/${encodeURIComponent(fileName)}`
  const src = page && !isImage ? `${baseSrc}#page=${page}` : baseSrc

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[95vw] max-w-5xl flex-col gap-3 p-4 sm:p-5">
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle className="flex items-center gap-2 text-base">
            {headerChip}
            <span className="min-w-0 truncate">{title ?? fileName}</span>
          </DialogTitle>
          <DialogDescription className="flex items-center gap-3 text-xs">
            {t('viewer.description')}
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-primary transition-opacity duration-200 ease-out hover:opacity-80"
            >
              <ExternalLink className="size-3" aria-hidden />
              {t('viewer.openInTab')}
            </a>
          </DialogDescription>
        </DialogHeader>
        {children}
        {open &&
          (isImage ? (
            <div className="min-h-0 w-full flex-1 overflow-auto rounded-lg border border-border bg-surface-sunken">
              <img src={src} alt={title ?? fileName} className="mx-auto h-auto max-w-full" />
            </div>
          ) : (
            <iframe
              src={src}
              title={title ?? fileName}
              className="min-h-0 w-full flex-1 rounded-lg border border-border bg-surface-sunken"
            />
          ))}
      </DialogContent>
    </Dialog>
  )
}
