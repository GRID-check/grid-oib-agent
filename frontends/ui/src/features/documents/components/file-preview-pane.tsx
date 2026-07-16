'use client'

import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { FileItem } from './project-file-workspace'
import { AlertCircle, Check, Download, FileQuestion, Maximize2, Pencil, RotateCcw, X } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TAG_GROUPS, MAX_TAGS } from '@/lib/documents/tag-vocabulary'
import { useLocale, useTranslations } from '@/i18n'
import { formatFileSize } from '@/lib/utils/format-file-size'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { DocumentStatusBadge, fileTypeIcon } from './document-status'

interface FilePreviewPaneProps {
  file: FileItem
  /** Present for project documents; omitted for the org-wide Archiv (unused here). */
  projectId?: string
  /**
   * Whether the viewer may mutate the document (edit tags, re-ingest). Defaults
   * to true (all project callers). The Archiv passes the caller's manage
   * capability so members without `org:archiv:manage` get a read-only pane.
   */
  canManage?: boolean
  onClose?: () => void
  /** Notify the parent to flip local state after a successful re-ingestion. */
  onReingested?: (fileId: string, status: string) => void
  /**
   * Notify the parent of the saved tags after a successful PATCH, so the
   * workspace's file state (and thus `initialTags` on reselect) stays fresh —
   * otherwise switching away and back reverts to the pre-edit tags.
   */
  onTagsUpdated?: (fileId: string, tags: string[]) => void
  /**
   * Whether the ingestion-metadata block (summary + pages/passages/contents
   * rows) renders (WorkOS `files-metadata-panel` flag, FB-8). Defaults to true
   * so the feature stays visible with flag enforcement off (fail-open) and
   * existing callers/specs are unaffected. Status/type/size rows are never
   * gated — they predate the feature.
   */
  showMetadataPanel?: boolean
  /**
   * Extra action controls rendered under the download button (e.g. the Archiv's
   * Delete affordance). Omitted for project documents, which have no delete.
   */
  extraActions?: ReactNode
}

const PREVIEW_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml']

export function FilePreviewPane({ file, canManage = true, onClose, onReingested, onTagsUpdated, showMetadataPanel = true, extraActions }: FilePreviewPaneProps) {
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
  const isImage = (file.contentType ?? '').startsWith('image/')
  // The large viewer dialog enlarges PDFs (native iframe viewer) and images
  // (img mode). Offer the expand affordance for both.
  const canExpandPreview = file.contentType === 'application/pdf' || isImage
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

      {/* Document description — the one-sentence summary the backend generated at
          ingestion. It's what grounds the agent's answers, so lead with it: place
          it directly under the header, above the preview, rather than burying it
          below. Read-only; calm accented panel so it reads as the document's gist. */}
      {showMetadataPanel && file.summary && (
        <div className="space-y-1 border-b bg-muted/40 px-4 py-3">
          <p className="text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground">
            {t('preview.summary')}
          </p>
          <p className="text-sm leading-relaxed text-foreground">{file.summary}</p>
        </div>
      )}

      {canExpandPreview && previewUrl && (
        <PdfViewerDialog
          open={isLargePreviewOpen}
          onOpenChange={setIsLargePreviewOpen}
          fileName={file.filename}
          src={previewUrl}
          isImage={isImage}
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

      {/* Ingestion-generated tags — controlled document-type/discipline labels.
          Editable via a small popover of toggleable chips (same flag as the rest
          of the metadata block). */}
      {showMetadataPanel && (
        <DocumentTagsSection
          fileId={file.id}
          initialTags={file.tags ?? []}
          onTagsUpdated={onTagsUpdated}
          readOnly={!canManage}
        />
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

      {/* Failure reason + re-ingestion affordance (re-ingest is a mutation, so
          the button is hidden for read-only viewers). */}
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
          {canManage && (
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
          )}
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
        {extraActions}
      </div>
    </div>
  )
}

/**
 * Editable controlled-tag block. Renders the current tags as calm muted chips
 * with an edit affordance; the popover offers the full vocabulary as toggleable
 * chips, grouped Dokumenttyp / Fachbereich. Save is optimistic: the chips update
 * immediately and revert (with a toast) if the PATCH fails.
 */
function DocumentTagsSection({
  fileId,
  initialTags,
  onTagsUpdated,
  readOnly = false,
}: {
  fileId: string
  initialTags: string[]
  onTagsUpdated?: (fileId: string, tags: string[]) => void
  /** Hide the edit affordance and render the tags as static chips. */
  readOnly?: boolean
}) {
  const t = useTranslations('files')
  const [tags, setTags] = useState<string[]>(initialTags)
  const [draft, setDraft] = useState<string[]>(initialTags)
  const [open, setOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  // Reset when a different file is selected (the pane is reused across files).
  useEffect(() => {
    setTags(initialTags)
    setOpen(false)
    // initialTags identity changes per file; fileId gates the reset intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])

  const openEditor = useCallback(() => {
    setDraft(tags)
    setOpen(true)
  }, [tags])

  const toggleTag = useCallback((tag: string) => {
    setDraft((current) =>
      current.includes(tag)
        ? current.filter((existing) => existing !== tag)
        : current.length >= MAX_TAGS
          ? current
          : [...current, tag],
    )
  }, [])

  const handleSave = useCallback(async () => {
    const next = draft
    const previous = tags
    // Optimistic: commit locally and close before the network round-trip.
    setTags(next)
    setOpen(false)
    setIsSaving(true)
    try {
      const res = await fetch(`/api/documents/${fileId}/tags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: next }),
      })
      if (!res.ok) throw new Error(`Tag update failed (${res.status})`)
      // Propagate to the parent so the workspace's file state (and initialTags on
      // reselect) reflects the save — without this the pane reverts to the
      // pre-edit tags when the file is switched away and back.
      onTagsUpdated?.(fileId, next)
    } catch {
      setTags(previous) // revert on failure
      toast.error(t('preview.tagsSaveError'))
    } finally {
      setIsSaving(false)
    }
  }, [draft, tags, fileId, onTagsUpdated, t])

  return (
    <div className="space-y-1.5 border-t px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{t('preview.tags')}</p>
        {!readOnly && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-6"
              onClick={openEditor}
              disabled={isSaving}
              aria-label={t('preview.editTags')}
              title={t('preview.editTags')}
            >
              <Pencil className="size-3.5" aria-hidden />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-3">
            {TAG_GROUPS.map((group) => (
              <div key={group.id} className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  {t(`preview.tagGroups.${group.id}`)}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {group.tags.map((tag) => {
                    const selected = draft.includes(tag)
                    const atCap = !selected && draft.length >= MAX_TAGS
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleTag(tag)}
                        disabled={atCap}
                        aria-pressed={selected}
                        className={
                          'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors ' +
                          (selected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-transparent text-muted-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40')
                        }
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                {t('preview.tagsCancel')}
              </Button>
              <Button type="button" size="sm" className="gap-1.5" onClick={handleSave}>
                <Check className="size-3.5" aria-hidden />
                {t('preview.tagsSave')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        )}
      </div>
      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground/70">{t('preview.noTags')}</p>
      )}
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
