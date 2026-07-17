'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { FileItem } from './project-file-workspace'
import { AlertCircle, Download, FileQuestion, Maximize2, Plus, RotateCcw, Sparkles, X } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { DOCUMENT_TYPE_TAGS, DISCIPLINE_TAGS, MAX_TAGS } from '@/lib/documents/tag-vocabulary'
import { useLocale, useTranslations } from '@/i18n'
import { formatFileSize } from '@/lib/utils/format-file-size'
import { formatAbsoluteTime } from '@/lib/format'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { DocumentStatusBadge, fileTypeIcon } from './document-status'

interface FilePreviewPaneProps {
  file: FileItem
  /** Present for project documents; omitted for the org-wide Archiv (unused here). */
  projectId?: string
  /** Project display name for the indexed-metadata panel's Project row. */
  projectName?: string
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
   * Whether the "Indexed by GRID" metadata panel (AI summary, key-value props,
   * editable tags) renders (WorkOS `files-metadata-panel` flag, FB-8). Defaults
   * to true so the feature stays visible with flag enforcement off (fail-open)
   * and existing callers/specs are unaffected. Status/type/size rows are never
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

export function FilePreviewPane({ file, projectName, canManage = true, onClose, onReingested, onTagsUpdated, showMetadataPanel = true, extraActions }: FilePreviewPaneProps) {
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
  // The ingestion-detected document type (first document-type tag), shown as
  // the indexed panel's Type row. Only real metadata — nothing is inferred here.
  const detectedType = (file.tags ?? []).find((tag) => (DOCUMENT_TYPE_TAGS as readonly string[]).includes(tag))

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

      {/* "Indexed by GRID" panel (files-metadata-panel flag, FB-8) — the AI
          summary that grounds the agent's answers, the ingestion-detected
          key-value props, and the user-correctable tags. Leads the pane, above
          the raw preview, because it is the document's machine-readable gist. */}
      {showMetadataPanel && (
        <section className="space-y-3 border-b bg-muted/40 px-4 py-3" aria-label={t('preview.indexed.title')}>
          <p className="flex items-center gap-1.5 text-[0.6875rem] font-medium uppercase tracking-wider text-muted-foreground">
            <Sparkles className="size-3.5 shrink-0" aria-hidden />
            {t('preview.indexed.title')}
          </p>
          {file.summary && <p className="text-sm leading-relaxed text-foreground">{file.summary}</p>}
          <div className="space-y-2">
            {detectedType && (
              <MetaRow label={t('preview.indexed.documentType')}>
                <span className="text-xs font-medium text-foreground">{detectedType}</span>
              </MetaRow>
            )}
            {projectName && (
              <MetaRow label={t('preview.indexed.project')}>
                <span className="truncate text-xs font-medium text-foreground">{projectName}</span>
              </MetaRow>
            )}
            {typeof file.pageCount === 'number' && file.pageCount > 0 && (
              <MetaRow label={t('preview.pages')}>
                <span className="text-xs font-medium tabular-nums text-foreground">{file.pageCount}</span>
              </MetaRow>
            )}
            {typeof file.chunkCount === 'number' && file.chunkCount > 0 && (
              <MetaRow label={t('preview.chunks')}>
                <span className="text-xs font-medium tabular-nums text-foreground">{file.chunkCount}</span>
              </MetaRow>
            )}
            {/* Content categories, shown only when the document holds more than
                plain text (text-only documents dominate — no redundant row). */}
            {hasRichContent && (
              <MetaRow label={t('preview.contents')}>
                <span className="text-xs text-foreground">
                  {file.contentTypes!.map((c) => t(`preview.contentTypeNames.${c}`)).join(', ')}
                </span>
              </MetaRow>
            )}
            <MetaRow label={t('preview.indexed.updated')}>
              <span className="text-xs font-medium tabular-nums text-foreground">
                {formatAbsoluteTime(file.createdAt, locale)}
              </span>
            </MetaRow>
          </div>
          <DocumentTagsSection
            fileId={file.id}
            initialTags={file.tags ?? []}
            onTagsUpdated={onTagsUpdated}
            readOnly={!canManage}
          />
          <p className="text-xs leading-relaxed text-muted-foreground/80">{t('preview.indexed.caption')}</p>
        </section>
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

/** Every tag a user may assign, in vocabulary order (Dokumenttyp then Fachbereich). */
const ALL_VOCABULARY_TAGS: readonly string[] = [...DOCUMENT_TYPE_TAGS, ...DISCIPLINE_TAGS]

/**
 * Editable tag block inside the indexed panel. Current tags render as chips
 * with a remove (×) affordance; new tags are added through an inline input —
 * Enter commits, Escape clears, blur commits an exact match — backed by
 * suggestion chips because the vocabulary is controlled (the tags PATCH
 * endpoint rejects out-of-vocabulary values server-side). Every add/remove
 * persists immediately and optimistically via the existing FB-8 tags API,
 * reverting with a toast on failure.
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
  /** Hide the editing affordances and render the tags as static chips. */
  readOnly?: boolean
}) {
  const t = useTranslations('files')
  const [tags, setTags] = useState<string[]>(initialTags)
  const [input, setInput] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset when a different file is selected (the pane is reused across files).
  useEffect(() => {
    setTags(initialTags)
    setInput('')
    setIsEditing(false)
    // initialTags identity changes per file; fileId gates the reset intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId])

  /** PATCH the full replacement tag list; optimistic with revert on failure. */
  const persist = useCallback(
    async (next: string[], previous: string[]) => {
      setTags(next)
      setIsSaving(true)
      try {
        const res = await fetch(`/api/documents/${fileId}/tags`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags: next }),
        })
        if (!res.ok) throw new Error(`Tag update failed (${res.status})`)
        // Propagate so the workspace's file state (and initialTags on reselect)
        // reflects the save — otherwise switching away and back reverts.
        onTagsUpdated?.(fileId, next)
      } catch {
        setTags(previous)
        toast.error(t('preview.tagsSaveError'))
      } finally {
        setIsSaving(false)
      }
    },
    [fileId, onTagsUpdated, t]
  )

  const removeTag = useCallback(
    (tag: string) => {
      void persist(tags.filter((existing) => existing !== tag), tags)
    },
    [persist, tags]
  )

  const addTag = useCallback(
    (tag: string) => {
      if (tags.includes(tag) || tags.length >= MAX_TAGS) return
      setInput('')
      void persist([...tags, tag], tags)
    },
    [persist, tags]
  )

  // Vocabulary entries still assignable, narrowed by the typed query.
  const suggestions = useMemo(() => {
    const q = input.trim().toLowerCase()
    const available = ALL_VOCABULARY_TAGS.filter((tag) => !tags.includes(tag))
    return q ? available.filter((tag) => tag.toLowerCase().includes(q)) : available
  }, [input, tags])

  /** Resolve the free-typed input to a canonical vocabulary entry, if any. */
  const resolveInput = useCallback((): string | null => {
    const q = input.trim().toLowerCase()
    if (!q) return null
    const exact = ALL_VOCABULARY_TAGS.find((tag) => tag.toLowerCase() === q)
    if (exact && !tags.includes(exact)) return exact
    // A query narrowing to exactly one candidate is unambiguous — accept it.
    return suggestions.length === 1 ? suggestions[0] : null
  }, [input, suggestions, tags])

  const atCap = tags.length >= MAX_TAGS
  const showNoMatchHint = isEditing && input.trim() !== '' && suggestions.length === 0

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{t('preview.tags')}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
          >
            {tag}
            {!readOnly && (
              <button
                type="button"
                onClick={() => removeTag(tag)}
                disabled={isSaving}
                aria-label={t('preview.removeTag', { tag })}
                className="-mr-0.5 rounded-sm p-0.5 transition-colors hover:bg-background/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </span>
        ))}
        {tags.length === 0 && readOnly && (
          <span className="text-xs text-muted-foreground/70">{t('preview.noTags')}</span>
        )}
        {!readOnly && !atCap && (
          <span className="relative inline-flex items-center">
            <Plus className="pointer-events-none absolute left-1.5 size-3 text-muted-foreground" aria-hidden />
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setIsEditing(true)}
              onBlur={() => {
                // Blur commits an exact/unambiguous match, otherwise discards.
                const resolved = resolveInput()
                if (resolved) addTag(resolved)
                else setInput('')
                setIsEditing(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const resolved = resolveInput()
                  if (resolved) addTag(resolved)
                }
                if (e.key === 'Escape') {
                  setInput('')
                  setIsEditing(false)
                  inputRef.current?.blur()
                }
              }}
              disabled={isSaving}
              placeholder={t('preview.addTagPlaceholder')}
              aria-label={t('preview.addTagLabel')}
              className="h-6 w-28 rounded-md border border-dashed border-input bg-transparent pl-6 pr-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 focus-visible:border-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
          </span>
        )}
      </div>
      {/* Controlled-vocabulary suggestions while the input is active: the PATCH
          endpoint rejects free-form values, so offer the real choices. */}
      {!readOnly && isEditing && suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('preview.suggestionsLabel')}>
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              // Keep the input focused so blur doesn't race the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => addTag(tag)}
              disabled={isSaving}
              className="inline-flex items-center rounded-md border border-border bg-transparent px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {showNoMatchHint && (
        <p className="text-xs text-muted-foreground/70">{t('preview.noTagMatch')}</p>
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
