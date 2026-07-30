'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { FileItem } from './project-file-workspace'
import { AlertCircle, ChevronDown, Download, Maximize2, Plus, RotateCcw, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DOCUMENT_TYPE_TAGS, DISCIPLINE_TAGS, MAX_TAGS } from '@/lib/documents/tag-vocabulary'
import { useLocale, useTranslations } from '@/i18n'
import { formatFileSize } from '@/lib/utils/format-file-size'
import { formatAbsoluteTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { extChipTint, fileExtensionLabel } from '../document-kind'
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
   * Extra action controls rendered in the right metadata column's action area,
   * below the status/size rows and the re-ingest control (e.g. the Delete
   * affordance, an authored full-width destructive button). A full-width control
   * would misalign inside the icon-button header row, so it lives in the column
   * where such buttons belong. Both the project Files and org Archiv workspaces
   * supply a Delete here.
   */
  extraActions?: ReactNode
}

const PREVIEW_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml']

/** One visual chunk's VLM description (mirrors the BFF visual-details payload). */
interface VisualDetail {
  page: number
  contentType: string
  drawingType: string
  scale: string
  text: string
}

const VISUAL_CONTENT_TYPES = ['drawing', 'image', 'chart']

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
  // "Detailed information": per-page VLM descriptions of the document's visual
  // chunks (drawings/images/charts), lazily loaded on first expand. Secondary
  // to the one-line summary above — collapsed by default.
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [details, setDetails] = useState<VisualDetail[] | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
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
  // The document has visual chunks (drawings/images/charts) whose per-page VLM
  // descriptions can be browsed in the "detailed information" section.
  const hasVisualContent = (file.contentTypes ?? []).some((c) => VISUAL_CONTENT_TYPES.includes(c))
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

  // Reset the detailed-info section when the selected document changes, so it
  // never shows a previous document's descriptions.
  useEffect(() => {
    setDetailsOpen(false)
    setDetails(null)
  }, [file.id])

  // Lazy-load the visual descriptions the first time the section is expanded.
  const toggleDetails = useCallback(() => {
    setDetailsOpen((open) => {
      const next = !open
      if (next && details === null && !detailsLoading) {
        setDetailsLoading(true)
        fetch(`/api/documents/${file.id}/visual-details`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => setDetails(Array.isArray(data?.details) ? data.details : []))
          .catch(() => setDetails([]))
          .finally(() => setDetailsLoading(false))
      }
      return next
    })
  }, [file.id, details, detailsLoading])

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

  const ext = fileExtensionLabel(file.filename)

  return (
    <div className="@container flex h-full flex-col bg-card">
      {/* Header — extension tile, name/meta, download, expand, close. The row
          stays on one line (the name truncates); below `@md` the Download label
          collapses to its icon so the controls never crowd a ~360px sheet. The
          top padding grows past the safe-area inset on the full-screen sheet. */}
      <div className="flex shrink-0 items-center gap-2 border-b px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] @md:gap-3 @md:px-4 sm:pt-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-[9.5px] font-bold uppercase leading-none"
          style={extChipTint(ext)}
          aria-hidden
        >
          {ext || <Icon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{file.filename}</h3>
          <p className="truncate text-[11.5px] text-muted-foreground">
            {ext || file.contentType || t('preview.unknownType')}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2 @md:px-3"
          onClick={handleDownload}
          disabled={isDownloading}
          aria-label={t('preview.download')}
          title={t('preview.download')}
        >
          <Download className="size-3.5" aria-hidden />
          <span className="hidden @md:inline">{t('preview.download')}</span>
        </Button>
        {canExpandPreview && previewUrl && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
            onClick={() => setIsLargePreviewOpen(true)}
            aria-label={t('preview.expandPreview')}
            title={t('preview.expandPreview')}
          >
            <Maximize2 className="size-4" />
          </Button>
        )}
        {onClose && (
          <Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={onClose} aria-label={t('preview.closePreview')}>
            <X className="size-4" />
          </Button>
        )}
      </div>

      {downloadFailed && (
        <div
          role="alert"
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2"
        >
          <p className="text-xs text-destructive">{t('preview.downloadFailed')}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5"
            onClick={handleDownload}
            disabled={isDownloading}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            {t('preview.tryAgain')}
          </Button>
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

      {/* Body split — document preview on the left, indexed metadata on the
          right. Two independently-scrolling columns side-by-side in the wide
          Dateien modal (`@2xl`+); a SINGLE vertical scroll (preview capped, all
          metadata flowing below) in a narrow container / mobile sheet.

          The scroll chain matters: `min-h-0` lets this flex child actually
          shrink below its content, and the overflow lives on the RIGHT layer for
          each mode — the body itself scrolls when stacked, each column scrolls
          when split. Without a bounded panel above (the dialog now gives one)
          this used to overflow into the panel's `overflow-hidden` and clip the
          metadata unreachably. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain @2xl:flex-row @2xl:overflow-hidden">
        {/* Left: live preview, or a decorative page mock while loading / when
            there is no inline preview. Stacked (mobile): a capped ~50dvh block
            that clips to itself so a tall document/image never pushes the
            metadata off-screen. Split (@2xl+): an independently-scrollable
            column. The Maximize2 affordance in the header still opens the
            full-screen viewer for PDFs and images. */}
        <div className="flex h-[50dvh] shrink-0 min-w-0 justify-center overflow-hidden bg-muted/40 p-5 @2xl:h-auto @2xl:min-h-0 @2xl:flex-1 @2xl:overflow-y-auto @2xl:overscroll-contain">
          {canPreview && isLoading ? (
            <PageMock skeleton />
          ) : canPreview && previewUrl ? (
            file.contentType === 'application/pdf' ? (
              <iframe src={previewUrl} className="h-full w-full rounded border bg-background" title={file.filename} />
            ) : (
              // A runtime preview URL (object URL / presigned storage link)
              // whose dimensions are unknown — next/image cannot optimize it.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={previewUrl}
                alt={file.filename}
                className="h-fit max-h-full max-w-full rounded border bg-background object-contain shadow-sm @2xl:max-h-none"
              />
            )
          ) : (
            <PageMock
              caption={previewFailed ? t('preview.loadFailed') : t('preview.noInlinePreview')}
              action={
                previewFailed && canPreview ? (
                  <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={loadPreview}>
                    <RotateCcw className="size-3.5" aria-hidden />
                    {t('preview.tryAgain')}
                  </Button>
                ) : undefined
              }
            />
          )}
        </div>

        {/* Right: indexed-metadata panel (files-metadata-panel flag, FB-8).
            The AI summary that grounds the agent's answers, the ingestion-detected
            key-value props, and the user-correctable tags. Status/type/size sit
            below it and are never gated (they predate the metadata panel).

            Stacked (mobile): plain flow content inside the body's single scroll —
            never `shrink-0` against an unbounded parent, which is what clipped it
            before. Split (@2xl+): a fixed-width column that scrolls on its own. */}
        <div className="flex w-full flex-col border-t bg-muted/30 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] @2xl:w-[280px] @2xl:shrink-0 @2xl:min-h-0 @2xl:overflow-y-auto @2xl:overscroll-contain @2xl:border-l @2xl:border-t-0 @2xl:pb-4">
          {showMetadataPanel && (
            <section className="space-y-3" aria-label={t('preview.indexed.title')}>
              <p className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                <Sparkles className="size-3.5 shrink-0" aria-hidden />
                {t('preview.indexed.title')}
              </p>
              {file.summary && <p className="text-[12.5px] leading-relaxed text-foreground">{file.summary}</p>}
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
              {hasVisualContent && (
                <div className="border-t pt-3">
                  <button
                    type="button"
                    onClick={toggleDetails}
                    aria-expanded={detailsOpen}
                    className="flex w-full items-center justify-between gap-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {t('preview.visualDetails.title')}
                    <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', detailsOpen && 'rotate-180')} aria-hidden />
                  </button>
                  {detailsOpen && (
                    <div className="mt-2.5 space-y-3">
                      {detailsLoading && <p className="text-xs text-muted-foreground">{t('preview.visualDetails.loading')}</p>}
                      {!detailsLoading && details && details.length === 0 && (
                        <p className="text-xs text-muted-foreground">{t('preview.visualDetails.empty')}</p>
                      )}
                      {!detailsLoading &&
                        details?.map((d, i) => (
                          <div key={`${d.page}-${d.contentType}-${i}`} className="space-y-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium text-foreground">
                              <span>{t('preview.visualDetails.page', { page: d.page })}</span>
                              {d.drawingType && <span className="text-muted-foreground">· {d.drawingType}</span>}
                              {d.scale && d.scale.toLowerCase() !== 'unbekannt' && (
                                <span className="text-muted-foreground">· {t('preview.visualDetails.scale', { scale: d.scale })}</span>
                              )}
                            </div>
                            <p className="whitespace-pre-line text-[12px] leading-relaxed text-muted-foreground">{d.text}</p>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          <div className={cn('space-y-2', showMetadataPanel && 'mt-4 border-t pt-4')}>
            <MetaRow label={t('preview.status')}>
              <DocumentStatusBadge status={file.status} />
            </MetaRow>
            <MetaRow label={t('preview.type')}>
              <span className="truncate font-mono text-xs text-foreground">{file.contentType ?? t('preview.unknownType')}</span>
            </MetaRow>
            <MetaRow label={t('preview.size')}>
              <span className="text-xs font-medium tabular-nums text-foreground">{formatFileSize(file.fileSize, locale)}</span>
            </MetaRow>
          </div>

          {/* Failure reason + re-ingestion affordance (re-ingest is a mutation,
              so the button is hidden for read-only viewers). */}
          {isFailed && (
            <div className="mt-4 space-y-2.5 border-t pt-4">
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

          {/* Extra actions (e.g. Delete) — a full-width destructive control that
              belongs in this column, not the icon-button header row. */}
          {extraActions}

          <div className="flex-1" />
          {showMetadataPanel && (
            <p className="mt-4 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground/80">
              {t('preview.indexed.caption')}
            </p>
          )}
        </div>
      </div>

      {/* Footer page indicator — mirrors the click-dummy's "Seite 1 von N". */}
      {typeof file.pageCount === 'number' && file.pageCount > 0 && (
        <div className="flex shrink-0 items-center justify-center border-t bg-muted/30 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-[11.5px] text-muted-foreground @2xl:pb-2">
          {t('preview.pageIndicator', { count: file.pageCount })}
        </div>
      )}
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

/**
 * Decorative document-page mock for the preview's left column — a paper sheet
 * with a header rule and paragraph skeleton bars, matching the click-dummy's
 * page preview. Purely presentational (no filename/project text, so nothing
 * duplicates the real metadata); the optional caption states why no live
 * preview is shown.
 */
function PageMock({ caption, action, skeleton }: { caption?: string; action?: ReactNode; skeleton?: boolean }) {
  return (
    <div className="h-fit w-full max-w-[520px] rounded border bg-background p-7 shadow-sm">
      <div className="flex items-baseline justify-between border-b pb-2.5">
        <div className="space-y-1.5">
          <div className="h-[9px] w-28 rounded bg-muted" />
          <div className="h-[6px] w-16 rounded bg-muted/70" />
        </div>
        <div className="h-[6px] w-12 rounded bg-muted/70" />
      </div>
      <div className="mt-3.5 flex h-[260px] flex-col items-center justify-center gap-3 rounded border border-dashed px-6 text-center">
        {!skeleton && caption && (
          <p className="max-w-[80%] text-[11.5px] leading-relaxed text-muted-foreground text-balance">{caption}</p>
        )}
        {action}
      </div>
      <div className="mt-3.5 space-y-1.5">
        <div className="h-[7px] w-3/5 rounded bg-muted" />
        <div className="h-[7px] w-1/2 rounded bg-muted" />
        <div className="h-[7px] w-[55%] rounded bg-muted" />
      </div>
    </div>
  )
}
