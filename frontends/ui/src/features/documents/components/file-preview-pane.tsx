'use client'

import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { FileItem } from './project-file-workspace'
import { AlertCircle, Download, FileQuestion, Maximize2, RotateCcw, X } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { useLocale, useTranslations } from '@/i18n'
import { formatFileSize } from '@/lib/utils/format-file-size'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { DocumentStatusBadge, fileTypeIcon } from './document-status'

interface FilePreviewPaneProps {
  file: FileItem
  projectId: string
  onClose?: () => void
  /** Notify the parent to flip local state after a successful re-ingestion. */
  onReingested?: (fileId: string, status: string) => void
  /**
   * Whether the ingestion-metadata block (summary + pages/passages/contents
   * rows) renders (WorkOS `files-metadata-panel` flag, FB-8). Defaults to true
   * so the feature stays visible with flag enforcement off (fail-open) and
   * existing callers/specs are unaffected. Status/type/size rows are never
   * gated — they predate the feature.
   */
  showMetadataPanel?: boolean
}

const PREVIEW_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml']

export function FilePreviewPane({ file, onClose, onReingested, showMetadataPanel = true }: FilePreviewPaneProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadFailed, setDownloadFailed] = useState(false)
  const [isReingesting, setIsReingesting] = useState(false)
  const [isLargePreviewOpen, setIsLargePreviewOpen] = useState(false)
  const canPreview = PREVIEW_TYPES.includes(file.contentType ?? '')
  // The large viewer dialog renders documents in an iframe using the browser's
  // native PDF viewer, so the expand affordance is offered for PDFs only.
  const canExpandPreview = file.contentType === 'application/pdf'
  const isFailed = file.status === 'failed'
  const Icon = fileTypeIcon(file.contentType, file.filename)
  // Only surface content categories when there is something beyond plain text;
  // a lone "Text" row is noise for the text-only documents that dominate here.
  const hasRichContent = (file.contentTypes ?? []).some((c) => c !== 'text')

  const loadPreview = useCallback(() => {
    setPreviewFailed(false)
    if (!canPreview) {
      setPreviewUrl(null)
      return
    }

    setIsLoading(true)
    fetch(`/api/documents/${file.id}/preview`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.url) setPreviewUrl(data.url)
        else setPreviewFailed(true)
      })
      .catch(() => {
        setPreviewUrl(null)
        setPreviewFailed(true)
      })
      .finally(() => setIsLoading(false))
  }, [file.id, canPreview])

  useEffect(() => {
    loadPreview()
  }, [loadPreview])

  // The download route returns JSON ({downloadUrl, ...}), not the file bytes —
  // fetch it, then navigate to the presigned URL. Its Content-Disposition is
  // `attachment`, so the browser downloads the file without leaving the page.
  const handleDownload = useCallback(async () => {
    setDownloadFailed(false)
    setIsDownloading(true)
    try {
      const res = await fetch(`/api/documents/${file.id}/download`)
      const data = res.ok ? await res.json() : null
      if (data?.downloadUrl) window.location.assign(data.downloadUrl)
      else setDownloadFailed(true)
    } catch {
      setDownloadFailed(true)
    } finally {
      setIsDownloading(false)
    }
  }, [file.id])

  // Re-dispatch a failed document to the ingest pipeline. On success the parent
  // flips its local status to 'pending' (the endpoint returns the new status),
  // so the existing status reconciliation takes over from there.
  const handleReingest = useCallback(async () => {
    setIsReingesting(true)
    try {
      const res = await fetch(`/api/documents/${file.id}/reingest`, { method: 'POST' })
      if (!res.ok) throw new Error(`Reingest failed (${res.status})`)
      const data = await res.json().catch(() => ({}))
      onReingested?.(file.id, data.status ?? 'pending')
    } catch {
      toast.error(t('preview.retryIngestionError'))
    } finally {
      setIsReingesting(false)
    }
  }, [file.id, onReingested, t])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <h3 className="truncate text-sm font-semibold text-foreground">{file.filename}</h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canExpandPreview && previewUrl && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setIsLargePreviewOpen(true)}
              aria-label={t('preview.expandPreview')}
              title={t('preview.expandPreview')}
            >
              <Maximize2 className="size-4" />
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="icon" className="size-7" onClick={onClose} aria-label={t('preview.closePreview')}>
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {canExpandPreview && previewUrl && (
        <PdfViewerDialog
          open={isLargePreviewOpen}
          onOpenChange={setIsLargePreviewOpen}
          fileName={file.filename}
          src={previewUrl}
        />
      )}

      {/* Preview */}
      <div className="flex-1 overflow-auto bg-muted/30">
        {canPreview && isLoading && (
          <div className="space-y-4 p-6">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
        {canPreview && !isLoading && previewUrl && (
          file.contentType === 'application/pdf' ? (
            <iframe src={previewUrl} className="h-full w-full" title={file.filename} />
          ) : (
            <img src={previewUrl} alt={file.filename} className="w-full object-contain" />
          )
        )}
        {canPreview && !isLoading && previewFailed && (
          <PreviewMessage
            message={t('preview.loadFailed')}
            action={
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={loadPreview}>
                <RotateCcw className="size-3.5" aria-hidden />
                {t('preview.tryAgain')}
              </Button>
            }
          />
        )}
        {!canPreview && (
          <PreviewMessage message={t('preview.noInlinePreview')} />
        )}
      </div>

      {/* Document summary — a one-sentence description of the contents, when the
          backend generated one. Read-only; calm muted text, no chrome. */}
      {showMetadataPanel && file.summary && (
        <div className="space-y-1.5 border-t px-4 py-3">
          <p className="text-xs text-muted-foreground">{t('preview.summary')}</p>
          <p className="text-xs leading-relaxed text-foreground">{file.summary}</p>
        </div>
      )}

      {/* Metadata */}
      <div className="space-y-2.5 border-t px-4 py-3">
        <MetaRow label={t('preview.status')}>
          <DocumentStatusBadge status={file.status} />
        </MetaRow>
        <MetaRow label={t('preview.type')}>
          <span className="font-mono text-xs text-foreground">{file.contentType ?? t('preview.unknownType')}</span>
        </MetaRow>
        <MetaRow label={t('preview.size')}>
          <span className="text-xs font-medium tabular-nums text-foreground">{formatFileSize(file.fileSize, locale)}</span>
        </MetaRow>
        {showMetadataPanel && typeof file.pageCount === 'number' && file.pageCount > 0 && (
          <MetaRow label={t('preview.pages')}>
            <span className="text-xs font-medium tabular-nums text-foreground">{file.pageCount}</span>
          </MetaRow>
        )}
        {showMetadataPanel && typeof file.chunkCount === 'number' && file.chunkCount > 0 && (
          <MetaRow label={t('preview.chunks')}>
            <span className="text-xs font-medium tabular-nums text-foreground">{file.chunkCount}</span>
          </MetaRow>
        )}
        {/* Content categories, shown only when the document holds more than plain
            text (production documents are usually text-only — no redundant row). */}
        {showMetadataPanel && hasRichContent && (
          <MetaRow label={t('preview.contents')}>
            <span className="text-xs text-foreground">
              {file.contentTypes!.map((c) => t(`preview.contentTypeNames.${c}`)).join(', ')}
            </span>
          </MetaRow>
        )}
      </div>

      {/* Failure reason + re-ingestion affordance */}
      {isFailed && (
        <div className="space-y-2.5 border-t px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-destructive">{t('preview.ingestionFailed')}</p>
              <p className="break-words text-xs text-muted-foreground">
                {file.errorMessage || t('preview.ingestionFailedGeneric')}
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            className="w-full gap-2"
            onClick={handleReingest}
            disabled={isReingesting}
          >
            <RotateCcw className="size-4" aria-hidden />
            {isReingesting ? t('preview.retryingIngestion') : t('preview.retryIngestion')}
          </Button>
        </div>
      )}

      {/* Actions */}
      <div className="border-t px-4 py-3">
        <Button
          type="button"
          variant="outline"
          className="w-full gap-2"
          onClick={handleDownload}
          disabled={isDownloading}
        >
          <Download className="size-4" aria-hidden />
          {t('preview.download')}
        </Button>
        {downloadFailed && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {t('preview.downloadFailed')}
          </p>
        )}
      </div>
    </div>
  )
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function PreviewMessage({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted">
        <FileQuestion className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground text-balance">{message}</p>
      {action}
    </div>
  )
}
