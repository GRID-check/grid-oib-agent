'use client'

/**
 * In-app source PDF viewer — a wide dialog around `PdfDocumentView`. Used by
 * clicked chat citations and the knowledge pages so users can read the actual
 * document the assistant grounded on.
 *
 * `page` opens the document there; `highlight` additionally lights up the cited
 * passage ON that page (see `pdf-document-view.tsx` for why the browser's own
 * viewer could never do the second thing).
 */

import type { ReactNode } from 'react'
import Image from 'next/image'
import { ExternalLink } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslations } from '@/i18n'
import { PdfDocumentView } from './pdf-document-view'

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
   * Render the source as an image (next/image in a scrollable frame) instead of
   * the PDF view. Lets the Files preview pane reuse this dialog to enlarge
   * standalone image uploads (FB-15a). `page`/`highlight` do not apply.
   */
  isImage?: boolean
  /**
   * The cited passage's own text. When set, the viewer finds it on `page` and
   * marks it — the difference between "your evidence is on page 12" and "your
   * evidence is this sentence". Callers that only know a page leave it unset
   * and the viewer opens exactly as it always did.
   */
  highlight?: string | null
  /**
   * CSS colour for that mark, so it wears the provenance tint of the chip that
   * opened the dialog (e.g. `var(--source-law)`).
   */
  highlightColor?: string
  /**
   * Skip the Next image optimizer for `isImage` mode. Defaults to TRUE, which
   * is the safe answer for any caller that has not thought about it: `src` here
   * can be a presigned object-store URL on an un-allow-listed host, or this
   * app's own cookie-authenticated corpus route — the optimizer fetches with a
   * headerless internal request and would fail on both. Pass `false` only for a
   * src the optimizer can actually serve, i.e. the same-origin signed image
   * path from `/api/documents/[id]/preview`.
   */
  imageUnoptimized?: boolean
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
  /**
   * Optional panel rendered ALONGSIDE the document frame rather than above it
   * (the citation passage rail). Content that the reader consults while reading
   * has to stay on screen while they read — put it in `children` and it becomes
   * a band they scroll past once and then cannot reach.
   */
  aside?: ReactNode
}

export function PdfViewerDialog({ open, onOpenChange, fileName, page, title, src: srcOverride, isImage, imageUnoptimized = true, highlight, highlightColor, headerChip, children, aside }: PdfViewerDialogProps) {
  const t = useTranslations('knowledge')
  const baseSrc = srcOverride ?? `/api/knowledge-base/documents/${encodeURIComponent(fileName)}`
  // The fragment is for the "open in new tab" link and the image branch, which
  // both hand the URL to the BROWSER's viewer. The in-app view takes `page` as
  // a prop instead — it scrolls itself, and to the passage rather than the page
  // when it can find one.
  const src = page && !isImage ? `${baseSrc}#page=${page}` : baseSrc

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Near-fullscreen so the document renders large at its own aspect ratio.
        The `sm:max-w-*` override is load-bearing: the base DialogContent carries
        `sm:max-w-lg` (32rem), and tailwind-merge keeps it because a plain
        `max-w-*` sits in a different variant — so at any ≥sm viewport the dialog
        was silently clamped to 512px, turning it tall-and-narrow and letterboxing
        wide/landscape drawings (a small page over a large dark void). Setting the
        `sm:` width here is what actually lets it fill the viewport.
      */}
      <DialogContent className="flex h-[90dvh] w-[95vw] max-w-[95vw] sm:max-w-[95vw] flex-col gap-3 p-4 sm:p-5">
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
              className="inline-flex items-center gap-1 font-medium text-primary transition-opacity duration-quick ease-out hover:opacity-80"
            >
              <ExternalLink className="size-3" aria-hidden />
              {t('viewer.openInTab')}
            </a>
          </DialogDescription>
        </DialogHeader>
        {children}
        {/* The frame and its aside share the dialog's remaining height. Without
            an aside this is a single flex child filling the row exactly as it
            did before, so every caller that passes none is unaffected. */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
          {aside}
          {open &&
            (isImage ? (
              <div className="min-h-0 w-full flex-1 overflow-auto overscroll-contain rounded-lg border border-border bg-surface-sunken">
                {/* The source streams at whatever size it happens to be, so
                    there is no intrinsic ratio to declare: 0/0 plus explicit
                    `w-auto h-auto` hands sizing back to CSS and keeps the image
                    at its natural size in the scroll frame, exactly as before.
                    The `w-auto` is not decoration — drop it and the browser
                    sizes the image to the width="0" attribute. */}
                <Image
                  src={src}
                  alt={title ?? fileName}
                  width={0}
                  height={0}
                  sizes="95vw"
                  unoptimized={imageUnoptimized}
                  className="mx-auto h-auto w-auto max-w-full"
                />
              </div>
            ) : (
              <PdfDocumentView
                src={baseSrc}
                title={title ?? fileName}
                page={page}
                highlight={highlight}
                highlightColor={highlightColor}
              />
            ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
