'use client'

/**
 * In-app source PDF viewer — a wide dialog with the browser's native PDF
 * rendering in an iframe. Used by clicked chat citations and the knowledge
 * pages so users can read the actual document the assistant grounded on.
 * `page` deep-links via the standard `#page=N` viewer fragment.
 */

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
}

export function PdfViewerDialog({ open, onOpenChange, fileName, page, title }: PdfViewerDialogProps) {
  const t = useTranslations('knowledge')
  const src = `/api/knowledge-base/documents/${encodeURIComponent(fileName)}${page ? `#page=${page}` : ''}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] w-[95vw] max-w-5xl flex-col gap-3 p-4 sm:p-5">
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle className="truncate text-base">{title ?? fileName}</DialogTitle>
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
        {open && (
          <iframe
            src={src}
            title={title ?? fileName}
            className="min-h-0 w-full flex-1 rounded-lg border border-border bg-surface-sunken"
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
