'use client'

/**
 * Space on an attachment: a larger look at it, without filing it. The same
 * client-side drawing as the thumbnail (the first page of a PDF, a picture),
 * so nothing is handed to a converter and nothing is ever navigated to; a
 * type that cannot be drawn shows its tile. The whole file is the person's
 * to download only once it is filed, where the ordinary preview opens it.
 */

import type { JSX } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { FileExtChip } from '@/features/documents/components/file-ext-chip'
import { useTranslations } from '@/i18n'
import { useAttachmentThumbnail } from './attachment-thumbnail'

/** The preview's longer edge in CSS pixels. */
const PREVIEW_EDGE = 640

export function AttachmentPreviewDialog({
  open,
  onOpenChange,
  name,
  contentType,
  url,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  contentType: string
  /** The content route, for a part that may be drawn; null shows the tile. */
  url: string | null
}): JSX.Element {
  const t = useTranslations('inboundMail')
  const source = useAttachmentThumbnail(open ? url : null, contentType, PREVIEW_EDGE)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" instant closeLabel={t('target.cancel')} data-testid="attachment-preview">
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{name}</DialogTitle>
          <DialogDescription className="sr-only">{t('attachments.preview', { name })}</DialogDescription>
        </DialogHeader>
        <div className="bg-muted/40 flex min-h-64 items-center justify-center overflow-hidden rounded-lg border">
          {source ? (
            // oxlint-disable-next-line nextjs/no-img-element -- a data: or blob: URL drawn from bytes this tab fetched; the optimizer cannot fetch it
            <img src={source} alt="" className="max-h-[70dvh] w-auto max-w-full object-contain" />
          ) : url ? (
            <Skeleton className="h-64 w-48" />
          ) : (
            <FileExtChip filename={name} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
