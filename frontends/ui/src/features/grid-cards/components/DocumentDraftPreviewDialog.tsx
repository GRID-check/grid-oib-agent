'use client'

/**
 * The unfiled draft's reading surface — a lightweight dialog, deliberately NOT
 * the Files pane's preview.
 *
 * `FilePreviewPane` needs a `FileItem` (a `documents` row) that does not exist
 * while the draft is unfiled: it lives only in the agent store under
 * `/entwuerfe/`. So this renders the fetched markdown directly through
 * `FileTextPage` (which itself uses `MarkdownRenderer`), with the draft's own
 * facts — version, bytes, path — in the chrome above it.
 *
 * Presentational view state only: opening it writes nothing, which is why the
 * card stays in its `CARD_INTERACTIVITY` classification. Errors render as an
 * actionable message with a retry control, never as a bare sentence.
 */

import type { FC } from 'react'
import { RotateCcw } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { FileTextPage } from '@/features/documents/components/file-text-page'
import { useLocale, useTranslations } from '@/i18n'
import { formatBytes } from '@/lib/format'

interface DocumentDraftPreviewDialogProps {
  open: boolean
  onClose: () => void
  /** The draft's first heading, or its file name when it has none. */
  title: string
  /** Path in the working directory, e.g. `/entwuerfe/aktenvermerk.md`. */
  path: string
  /** How often this path has been written or edited in this conversation. */
  version: number
  /** Size of the draft as stored, in UTF-8 bytes. */
  bytes: number
  /** Fetched markdown; null while loading or when the fetch failed. */
  content: string | null
  loading: boolean
  failed: boolean
  onRetry: () => void
}

export const DocumentDraftPreviewDialog: FC<DocumentDraftPreviewDialogProps> = ({
  open,
  onClose,
  title,
  path,
  version,
  bytes,
  content,
  loading,
  failed,
  onRetry,
}) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent
        data-testid="document-draft-preview"
        className="flex max-h-[85vh] flex-col sm:max-w-[720px]"
      >
        <DialogTitle className="truncate pr-8" title={title}>
          {title}
        </DialogTitle>
        <p
          className="card-caption truncate font-mono text-muted-foreground"
          title={path}
          data-testid="document-draft-preview-meta"
        >
          {path} · {t('cards.documentDraft.version', { version })} · {formatBytes(bytes, locale)}
        </p>
        <div className="min-h-0 overflow-y-auto">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground" data-testid="document-draft-preview-loading">
              {t('cards.documentDraft.previewLoading')}
            </p>
          ) : failed || content === null ? (
            <div
              className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-muted/30 px-4 py-8 text-center"
              data-testid="document-draft-preview-error"
            >
              <p className="text-sm text-muted-foreground">{t('cards.documentDraft.previewError')}</p>
              <button
                type="button"
                onClick={onRetry}
                data-testid="document-draft-preview-retry"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border bg-background px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <RotateCcw className="size-3.5" aria-hidden />
                {t('cards.documentDraft.previewRetry')}
              </button>
            </div>
          ) : (
            <div data-testid="document-draft-preview-content">
              <FileTextPage
                text={content}
                truncated={false}
                contentType="text/markdown"
                truncatedLabel=""
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
