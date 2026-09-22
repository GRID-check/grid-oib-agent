'use client'

/**
 * The unfiled draft's reading surface — a lightweight dialog, deliberately NOT
 * the Files pane's preview.
 *
 * `FilePreviewPane` needs a `FileItem` (a `documents` row) that does not exist
 * while the draft is unfiled: it lives only in the agent store under
 * `/entwuerfe/`. So this renders the fetched markdown directly through
 * `FileTextPage` (which itself uses `MarkdownRenderer`), with the draft's own
 * facts — path, and past the first write the version, and bytes — in the
 * chrome above it.
 *
 * One fixed header, one scroll container: the dialog itself never scrolls, so
 * a long draft gets a single scrollbar on its words rather than one per
 * nesting level.
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
        className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl"
      >
        {/* Fixed chrome: the title and the facts never scroll away, and never
            shrink under the words below. `leading-snug`, because the dialog
            title's `leading-none` clipped the first line's ascenders; the
            `title` keeps the whole string reachable past the truncation. */}
        <div className="min-w-0 shrink-0">
          <DialogTitle className="truncate pr-8 leading-snug" title={title}>
            {title}
          </DialogTitle>
          <p
            className="card-caption truncate font-mono text-muted-foreground"
            title={path}
            data-testid="document-draft-preview-meta"
          >
            {path}
            {/* One write is no history: the counter appears only once the path
                has been written again. The size stays — this is the surface
                that shows the words it measures. */}
            {version > 1 && ` · ${t('cards.documentDraft.version', { version })}`} ·{' '}
            {formatBytes(bytes, locale)}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
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
              {/* Unconstrained: the page's own 720px cap already matches this
                  dialog's content width, so capping it again would only
                  re-narrow what the dialog just widened. */}
              <FileTextPage
                text={content}
                truncated={false}
                contentType="text/markdown"
                truncatedLabel=""
                className="max-w-none"
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
