'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import type { FileItem } from './project-file-workspace'
import {
  AlertCircle,
  ChevronDown,
  Clock,
  Download,
  FileCode2,
  FileText,
  FileType2,
  FolderOpen,
  HardDrive,
  Layers,
  Maximize2,
  Plus,
  RotateCcw,
  Shapes,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { DOCUMENT_TYPE_TAGS, DISCIPLINE_TAGS, MAX_TAGS } from '@/lib/documents/tag-vocabulary'
import { documentFileUrl } from '@/lib/documents/urls'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime, formatBytes } from '@/lib/format'
import { isOptimizerEligible } from '@/lib/images/optimizable'
import { cn } from '@/lib/utils'
import { extChipTint, fileExtensionLabel, inferDocumentKind } from '../document-kind'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { DocumentActionsMenu, useDocumentActions, type DocumentScope } from './document-actions'
import { DocumentStatusBadge, fileTypeIcon, isCitableStatus, isFailedStatus } from './document-status'
import { AssignmentFaces } from './assignment-faces'
import { AssignPopover } from './assign-popover'
import { useRouter } from 'next/navigation'
import { askAboutFile } from '../lib/ask-about-file'
import { useFilePreviewStore } from '../stores/file-preview-store'

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
  /** Which corpus the document belongs to — decides the file operations' route. */
  scope?: DocumentScope
  /** The document was renamed from the header menu. */
  onRenamed?: (fileId: string, displayName: string | null) => void
  /** The document was deleted from the header menu; the pane closes itself. */
  onDeleted?: (fileId: string) => void
  canCollaborate?: boolean
  /** Modal on Files; peek/expanded once this file is the chat subject. */
  presentation?: 'modal' | 'peek' | 'expanded'
  onAssigneesChanged?: (assignees: FileItem['assignees']) => void
}

const PREVIEW_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml']

/**
 * The building itself, in the well where a PDF shows its pages.
 *
 * `ssr: false` because the viewport underneath reaches for `navigator.gpu`, and
 * `dynamic` because it pulls the BIM hooks and (behind one more boundary) a
 * multi-megabyte WASM kernel — none of which belongs in the bundle of a pane
 * that is usually opened on a PDF.
 */
const IfcFilePreview = dynamic(
  () => import('@/features/bim/components/ifc-file-preview').then((module) => module.IfcFilePreview),
  { ssr: false }
)

/**
 * The model's own facts in the metadata rail — storeys, elements, rooms, area.
 *
 * The rail's job is "what did Grid make of this file", and for a model the
 * indexed panel below can only answer with the digest's passage count, which
 * describes the prose written about the building rather than the building.
 * Same boundary as the viewport: one import, and nothing here knows what a
 * storey is.
 */
const IfcFileFacts = dynamic(
  () => import('@/features/bim/components/ifc-file-facts').then((module) => module.IfcFileFacts),
  { ssr: false }
)

/** One visual chunk's VLM description (mirrors the BFF visual-details payload). */
interface VisualDetail {
  page: number
  contentType: string
  drawingType: string
  scale: string
  text: string
}

const VISUAL_CONTENT_TYPES = ['drawing', 'image', 'chart']

export function FilePreviewPane({
  file,
  projectId,
  projectName,
  canManage = true,
  scope = 'files',
  onClose,
  onReingested,
  onTagsUpdated,
  onRenamed,
  onDeleted,
  showMetadataPanel = true,
  canCollaborate = false,
  presentation = 'modal',
  onAssigneesChanged,
}: FilePreviewPaneProps) {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const router = useRouter()
  const storeMode = useFilePreviewStore((state) => state.mode)
  const storeFileId = useFilePreviewStore((state) => state.file?.id)
  const inChat = presentation === 'peek' || presentation === 'expanded' ||
    ((storeMode === 'peek' || storeMode === 'expanded') && storeFileId === file.id)
  const peeking = presentation === 'peek'
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  /**
   * The same-origin signed path for the same bytes, when the optimizer can
   * serve them. Separate from `previewUrl` rather than replacing it: the PDF
   * iframe and the "open in new tab" link want the object-store URL, and a
   * format the optimizer rejects still has to render.
   */
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [isReingesting, setIsReingesting] = useState(false)
  const [isLargePreviewOpen, setIsLargePreviewOpen] = useState(false)
  // "Detailed information": per-page VLM descriptions of the document's visual
  // chunks (drawings/images/charts), lazily loaded on first expand. Secondary
  // to the one-line summary above — collapsed by default.
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [details, setDetails] = useState<VisualDetail[] | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  /**
   * An `.ifc` is a building, and it previews as one. This is the ONLY thing
   * this pane knows about the BIM subsystem — `inferDocumentKind` already
   * classifies a model by format (it has to, for the card thumbnails), and the
   * viewport is behind one dynamic import.
   *
   * Every shelf, not just a project's. This used to require a `projectId`,
   * because a model could only be resolved through a project's model list — so
   * a model uploaded into the org-wide Archiv previewed as a grey "no inline
   * preview" page mock, and the file the whole feature is about was the one
   * file the Archiv could do nothing with. The document-scoped lookup behind
   * `IfcFilePreview` removed that prerequisite; the surfaces that have a
   * project still use it, and the ones that do not now work.
   */
  const isModel =
    inferDocumentKind({ filename: file.filename, contentType: file.contentType, tags: file.tags }) === 'model'
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
        if (data?.url) {
          setPreviewUrl(data.url)
          // Absent for PDFs and for image formats the optimizer cannot process;
          // the renderer falls back to `url` unoptimized in both cases.
          setPreviewImageUrl(typeof data.imageUrl === 'string' ? data.imageUrl : null)
        } else setPreviewFailed(true)
      })
      .catch(() => {
        setPreviewUrl(null)
        setPreviewImageUrl(null)
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

  /**
   * The document's name and its download, from the shared hook — this pane
   * holds no request logic of its own any more.
   *
   * Download keeps a BUTTON of its own in the header (it is what most people
   * came to do with a document they are looking at) while rename and delete sit
   * in the menu beside it; offering download twice on one surface would be two
   * controls for one job. Renames and deletions are the menu's, and they reach
   * this pane the same way any other change does: the workspace updates the
   * document it passes in.
   */
  const actions = useDocumentActions({ document: file, scope })

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
    <div className="@container flex h-full min-h-0 flex-col bg-card">
      {/* Peek chrome lives on the host — this header is the modal/expanded one. */}
      {!peeking && (
      <div className="flex shrink-0 items-center gap-2.5 border-b px-3.5 pb-3.5 pt-[max(0.875rem,env(safe-area-inset-top))] @md:gap-3 @md:px-5 sm:pt-3.5">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold uppercase leading-none"
          style={extChipTint(ext)}
          aria-hidden
        >
          {ext || <Icon className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          {/* The name the document was GIVEN, if it was given one. `title`
              carries it in full for the truncated case — and the file's own
              name underneath it, which is the answer to "which file is this
              actually" for anyone who renamed it. */}
          <h3
            className="truncate text-sm font-semibold leading-tight tracking-[-0.01em] text-foreground"
            title={actions.isRenamed ? `${actions.name}\n${file.filename}` : actions.name}
          >
            {actions.name}
          </h3>
          {/* Type AND status on one line. The status badge used to live only in
              the metadata column, below the fold on a narrow panel — so the one
              question a reader has on opening a file ("is this actually indexed,
              or am I looking at a document the agent cannot see?") was answered
              further away than the answer to "what format is it". A document in
              `failed` is the case that matters, and it must not require a
              scroll. */}
          <div className="mt-1 flex min-w-0 items-center gap-1.5">
            <p className="truncate text-xs text-muted-foreground">
              {ext || file.contentType || t('preview.unknownType')}
            </p>
            <span className="text-muted-foreground/40" aria-hidden>
              ·
            </span>
            <DocumentStatusBadge status={file.status} className="shrink-0" />
          </div>
          {canCollaborate && (
            <div className="mt-1.5 flex min-w-0 items-center gap-1">
              <AssignmentFaces assignees={file.assignees} />
              <AssignPopover
                documentId={file.id}
                assignees={file.assignees ?? []}
                onChanged={(next) => onAssigneesChanged?.(next)}
              />
            </div>
          )}
        </div>
        {projectId && isCitableStatus(file.status) && !inChat && (
          <Button
            type="button"
            size="sm"
            className="h-8 shrink-0"
            onClick={() =>
              askAboutFile({
                projectId,
                file,
                navigate: (href) => router.push(href),
              })
            }
          >
            {t('assignment.ask')}
          </Button>
        )}
        {projectId && canCollaborate && isCitableStatus(file.status) && (
          <AskColleagueButton
            projectId={projectId}
            file={file}
            documentId={file.id}
          />
        )}
        {projectId && !isCitableStatus(file.status) && !isFailedStatus(file.status) && (
          <Button size="sm" className="h-8 shrink-0" disabled title={t('assignment.askDisabled')}>
            {t('assignment.ask')}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2 pointer-coarse:min-w-11 @md:px-3"
          onClick={() => void actions.download()}
          disabled={actions.isDownloading}
          aria-label={t('preview.download')}
          title={t('preview.download')}
        >
          <Download className="size-3.5" aria-hidden />
          <span className="hidden @md:inline">{t('preview.download')}</span>
        </Button>
        {/* Rename and delete. In the header, with the controls that act on this
            document — not in the metadata rail, which describes it. */}
        <DocumentActionsMenu
          document={file}
          scope={scope}
          actions={['rename', 'delete']}
          canManage={canManage}
          onRenamed={onRenamed}
          onDeleted={(fileId) => {
            onDeleted?.(fileId)
            onClose?.()
          }}
        />
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
      )}

      {actions.downloadFailed && (
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
            onClick={() => void actions.download()}
            disabled={actions.isDownloading}
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
          fileName={actions.name}
          // The enlarged view is the other place a full-size original used to
          // cross the wire whole, so it gets the optimizable path too when there
          // is one. A PDF goes to the same-origin stream instead of the
          // presigned URL: the enlarged viewer renders the document with pdf.js,
          // which FETCHES it, and a cross-origin fetch has no CORS policy to
          // land on. See `documentFileUrl`.
          src={isImage ? (previewImageUrl ?? previewUrl) : documentFileUrl(file.id)}
          isImage={isImage}
          // Only ever consulted in image mode, so it is asked of the IMAGE src:
          // the PDF branch renders through pdf.js on the same-origin stream and
          // never reaches the optimizer at all. `isOptimizerEligible` is checked
          // against the optimizer's real allow-list (see `optimizable.ts`).
          imageUnoptimized={!isOptimizerEligible(previewImageUrl ?? previewUrl)}
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
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overscroll-contain',
          peeking ? 'overflow-hidden' : 'overflow-y-auto @2xl:flex-row @2xl:overflow-hidden',
        )}
      >
        {/* Left: live preview, or a decorative page mock while loading / when
            there is no inline preview. Stacked (mobile): a capped ~50dvh block
            that clips to itself so a tall document/image never pushes the
            metadata off-screen. Split (@2xl+): an independently-scrollable
            column. The Maximize2 affordance in the header still opens the
            full-screen viewer for PDFs and images. */}
        {/* The ground under the document. A flat grey box read as "an iframe in
            a panel"; a soft vertical gradient with the page raised off it on a
            real shadow reads as a document ON something — which is what a
            drawing on a desk actually looks like, and the whole reason this
            column exists rather than a download link. */}
        <div
          className={cn(
            'flex min-w-0 justify-center overflow-hidden bg-gradient-to-b from-muted/25 to-muted/60',
            peeking
              ? 'h-full min-h-0 flex-1 p-3'
              : 'h-[50dvh] min-h-[50dvh] shrink-0 p-5 @2xl:h-auto @2xl:min-h-0 @2xl:flex-1 @2xl:overflow-y-auto @2xl:overscroll-contain @2xl:p-7',
          )}
        >
          {isModel ? (
            <IfcFilePreview
              documentId={file.id}
              filename={file.filename}
              projectId={projectId}
              className="size-full"
            />
          ) : canPreview && isLoading ? (
            <PageMock skeleton />
          ) : canPreview && previewUrl ? (
            file.contentType === 'application/pdf' ? (
              <iframe
                src={previewUrl}
                className={cn(
                  'h-full w-full rounded-lg border bg-background',
                  peeking ? 'shadow-xs' : 'shadow-lg',
                )}
                title={actions.name}
              />
            ) : (
              // This is where the bytes actually were: the preview URL serves
              // the FULL-SIZE original into a column a few hundred pixels wide,
              // so a 4000px scan used to cross the wire whole. `previewImageUrl`
              // is the same-origin signed path the optimizer can resize; it is
              // null for the formats the optimizer would choke on (SVG and the
              // exotic ones), which then fall back to the object-store URL
              // unoptimized — the old behaviour, kept as the safe default.
              //
              // Sizing stays with CSS either way: the well is only bounded on
              // mobile (`h-[50dvh]`) and grows with its content at `@2xl`, where
              // a `fill` child would collapse the column to nothing. Hence 0/0
              // for the ratio next/image cannot know, plus an explicit `w-auto`
              // so the browser sizes to the image and not to the width="0".
              <Image
                src={previewImageUrl ?? previewUrl}
                alt={actions.name}
                width={0}
                height={0}
                sizes="(min-width: 1536px) 720px, 90vw"
                unoptimized={!isOptimizerEligible(previewImageUrl ?? previewUrl)}
                // Either URL can be expired or unreachable by the time the
                // browser fetches the bytes — a presigned link on its own TTL,
                // or a signed image path whose window has rolled over — and the
                // fetch above only proves the BFF handed one out. Fall back to
                // the same failed state the fetch path uses so the user gets the
                // caption and the retry button instead of a broken-image glyph.
                onError={() => {
                  setPreviewUrl(null)
                  setPreviewImageUrl(null)
                  setPreviewFailed(true)
                }}
                className="h-fit w-auto max-h-full max-w-full rounded-lg border bg-background object-contain shadow-lg @2xl:max-h-none"
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
        {/* `scroll-fade-bottom` dissolves the last rows instead of guillotining
            them. This column routinely overflows — summary, six metadata rows,
            tags and the visual-details section — and a hard clip through the
            middle of a value reads as broken rather than as "there is more".
            The utility is scroll-driven, so the fade RETRACTS at the bottom of
            travel: its presence is the signal, not decoration. */}
        {!peeking && (
        <div className="scroll-fade-bottom bg-surface-sunken flex w-full flex-col border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))] @2xl:w-[280px] @2xl:shrink-0 @2xl:min-h-0 @2xl:overflow-y-auto @2xl:overscroll-contain @2xl:border-l @2xl:border-t-0 @2xl:pb-4">
          {/* The building's own numbers lead the rail: they are what the file
              IS. Ungated by the metadata flag, which covers what INGESTION
              derived — these come out of the IFC itself. Renders nothing until
              a model has actually been read. */}
          {isModel && (
            <IfcFileFacts
              documentId={file.id}
              projectId={projectId}
              className="mb-4 border-b pb-4"
            />
          )}
          {/* What Piloti made of the document, in its own words.
              Promoted out of the fact list and onto a raised card: it is the
              single most valuable thing on this rail — the answer to "does the
              agent actually understand this file" — and it used to sit as one
              more 12.5px paragraph between an eyebrow and six key/value rows,
              read at the same weight as the MIME type. */}
          {showMetadataPanel && (
            <section className="space-y-2.5" aria-label={t('preview.indexed.title')}>
              <SectionLabel as="p" icon={Sparkles} className="font-semibold tracking-[0.05em]">
                {t('preview.indexed.title')}
              </SectionLabel>
              {/* Keyed by file so a newly-selected document always starts
                  collapsed and re-measures against its own text. */}
              {file.summary && <IndexedSummary key={file.id} summary={file.summary} />}
            </section>
          )}

          {/* One list of facts, not two.
              Type and size used to sit in a separate block BELOW the tags,
              divorced from the page count and the document type they belong
              with, because one group was behind a feature flag and the other
              was not. The flag now gates ROWS, which is what it was always
              about; the group is whole either way. */}
          <section className={cn('space-y-2', showMetadataPanel && 'mt-4')}>
            <SectionLabel as="p" icon={FileCode2} className="font-semibold tracking-[0.05em]">
              {t('preview.properties')}
            </SectionLabel>
            <div className="space-y-2">
              {showMetadataPanel && detectedType && (
                <MetaRow label={t('preview.indexed.documentType')} icon={FileType2}>
                  <span className="text-xs font-medium text-foreground">{detectedType}</span>
                </MetaRow>
              )}
              {showMetadataPanel && projectName && (
                <MetaRow label={t('preview.indexed.project')} icon={FolderOpen}>
                  <span className="truncate text-xs font-medium text-foreground">{projectName}</span>
                </MetaRow>
              )}
              {showMetadataPanel && typeof file.pageCount === 'number' && file.pageCount > 0 && (
                <MetaRow label={t('preview.pages')} icon={FileText}>
                  <span className="text-xs font-medium tabular-nums text-foreground">{file.pageCount}</span>
                </MetaRow>
              )}
              {showMetadataPanel && typeof file.chunkCount === 'number' && file.chunkCount > 0 && (
                <MetaRow label={t('preview.chunks')} icon={Layers}>
                  <span className="text-xs font-medium tabular-nums text-foreground">{file.chunkCount}</span>
                </MetaRow>
              )}
              {showMetadataPanel && hasRichContent && (
                <MetaRow label={t('preview.contents')} icon={Shapes}>
                  <span className="text-xs text-foreground">
                    {file.contentTypes!.map((c) => t(`preview.contentTypeNames.${c}`)).join(', ')}
                  </span>
                </MetaRow>
              )}
              {/* No status row: the header badge already answers it, and the
                  same fact stated twice on one surface reads as two facts. */}
              <MetaRow label={t('preview.type')} icon={FileCode2}>
                <span className="truncate font-mono text-xs text-foreground">
                  {file.contentType ?? t('preview.unknownType')}
                </span>
              </MetaRow>
              <MetaRow label={t('preview.size')} icon={HardDrive}>
                <span className="text-xs font-medium tabular-nums text-foreground">
                  {formatBytes(file.fileSize, locale)}
                </span>
              </MetaRow>
              {showMetadataPanel && (
                <MetaRow label={t('preview.indexed.updated')} icon={Clock}>
                  <span className="text-xs font-medium tabular-nums text-foreground">
                    {formatAbsoluteTime(file.createdAt, locale)}
                  </span>
                </MetaRow>
              )}
            </div>
          </section>

          {showMetadataPanel && (
            <>
              <div className="mt-4">
                <DocumentTagsSection
                  fileId={file.id}
                  initialTags={file.tags ?? []}
                  onTagsUpdated={onTagsUpdated}
                  readOnly={!canManage}
                />
              </div>
              {hasVisualContent && (
                <div className="mt-4 border-t pt-3.5">
                  <button
                    type="button"
                    onClick={toggleDetails}
                    aria-expanded={detailsOpen}
                    className="flex w-full items-center justify-between gap-2 text-left text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground transition-colors duration-snap ease-out hover:text-foreground touch-target motion-reduce:transition-none"
                  >
                    {t('preview.visualDetails.title')}
                    <ChevronDown
                      className={cn(
                        'size-3.5 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
                        detailsOpen && 'rotate-180',
                      )}
                      aria-hidden
                    />
                  </button>
                  {detailsOpen && (
                    <div className="mt-2.5 space-y-3">
                      {detailsLoading && (
                        <p className="text-xs text-muted-foreground">{t('preview.visualDetails.loading')}</p>
                      )}
                      {!detailsLoading && details && details.length === 0 && (
                        <p className="text-xs text-muted-foreground">{t('preview.visualDetails.empty')}</p>
                      )}
                      {!detailsLoading &&
                        details?.map((d, i) => (
                          <div key={`${d.page}-${d.contentType}-${i}`} className="space-y-1">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-medium text-foreground">
                              <span>{t('preview.visualDetails.page', { page: d.page })}</span>
                              {d.drawingType && <span className="text-muted-foreground">· {d.drawingType}</span>}
                              {d.scale && d.scale.toLowerCase() !== 'unbekannt' && (
                                <span className="text-muted-foreground">
                                  · {t('preview.visualDetails.scale', { scale: d.scale })}
                                </span>
                              )}
                            </div>
                            <p className="whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                              {d.text}
                            </p>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

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

          {/* No Delete block here any more. A full-width red button under the
              tags made the most dangerous operation the loudest thing on a
              column whose job is to DESCRIBE the document, and its confirm step
              expanded in place, pushing the rest of the rail down. Both moved
              into the header's actions menu, beside the other controls that act
              on this file. */}

          <div className="flex-1" />
          {showMetadataPanel && (
            <p className="mt-4 border-t pt-3 text-xs leading-relaxed text-muted-foreground/80">
              {t('preview.indexed.caption')}
            </p>
          )}
        </div>
        )}
      </div>

      {/* No footer page band. It stated the page count a second time, three
          rows below the "Pages" row that already stated it, in a band that cost
          the preview column ~32px of height on every document — the definition
          of a part that could be removed without losing anything. */}
    </div>
  )
}

/** Lines of summary shown before it has to ask for the space. */
const SUMMARY_CLAMP_LINES = 5

/**
 * The indexed summary, clamped until asked.
 *
 * The summary is the most valuable thing on the rail, which is exactly why it
 * cannot be allowed to take the whole rail: an ingestion pass on a
 * Brandschutzkonzept happily produces twelve lines, and unclamped that pushes
 * the properties, the tags and the delete action off the bottom of a 280px
 * column. The reader then has to scroll to find out that a Type row exists.
 *
 * Five lines is enough to know what the document is and decide whether to read
 * the rest. The toggle appears only when text is genuinely hidden — measured,
 * not guessed from a character count, because the same string wraps differently
 * in the wide modal and the mobile sheet.
 */
function IndexedSummary({ summary }: { summary: string }) {
  const t = useTranslations('files')
  const [expanded, setExpanded] = useState(false)
  const [isTruncated, setIsTruncated] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)

  useEffect(() => {
    const element = textRef.current
    if (!element) return

    // Only meaningful while the clamp is applied; once expanded the element is
    // its own full height by definition and would measure as "nothing hidden".
    const measure = () => {
      if (expanded) return
      setIsTruncated(element.scrollHeight - element.clientHeight > 2)
    }
    measure()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded, summary])

  return (
    <div className="rounded-lg border bg-card p-3 shadow-2xs">
      <p
        ref={textRef}
        className={cn('text-sm leading-[1.55] text-foreground', !expanded && 'line-clamp-5')}
        style={!expanded ? { WebkitLineClamp: SUMMARY_CLAMP_LINES } : undefined}
      >
        {summary}
      </p>
      {(isTruncated || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors duration-snap ease-out hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 touch-target motion-reduce:transition-none"
        >
          {expanded ? t('preview.summaryLess') : t('preview.summaryMore')}
          <ChevronDown
            className={cn(
              'size-3 shrink-0 transition-transform duration-quick ease-out motion-reduce:transition-none',
              expanded && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
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
                className="-mr-0.5 rounded-sm p-0.5 transition-colors duration-snap ease-out hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 touch-target motion-reduce:transition-none"
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
              className="inline-flex items-center rounded-md border border-border bg-transparent px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors duration-snap ease-out hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 motion-reduce:transition-none"
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

/**
 * One label/value row in the indexed-metadata column.
 *
 * The icon is not decoration: this is a scan target, not prose, and a column of
 * six plain text labels forces the reader to actually read each one to find the
 * row they want. A glyph per row gives the eye something to land on, and the
 * glyphs are chosen to mean the thing (a page for pages, layers for retrieval
 * passages) rather than to fill the slot. `aria-hidden` throughout — the label
 * beside it is already the accessible name, so the icon must not double it.
 */
function MetaRow({
  label,
  icon: Icon,
  children,
}: {
  label: string
  icon: LucideIcon
  children: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      {/* The LABEL never truncates — it is the key, and "Cont…" tells the
          reader nothing. Long values wrap in the right column instead, which is
          what a five-item content-type list actually needs. */}
      <span className="flex shrink-0 items-center gap-1.5 pt-px text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
        {label}
      </span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  )
}

/**
 * The preview column when there is no live preview to show.
 *
 * Two cases with one shape but different intent, which is why `skeleton` is a
 * flag rather than two components:
 *
 *  - LOADING: a page-shaped skeleton. Bars standing in for text that is on its
 *    way is what a skeleton IS, and the silhouette tells the reader the column
 *    is about to hold a document rather than an image or an error.
 *  - NO PREVIEW / FAILED: the same page, EMPTY, carrying the sentence that
 *    explains why and the control that retries. It previously drew the same
 *    paragraph bars here — a document mocked up with fake text, permanently,
 *    for a file whose contents cannot be shown at all. That is decoration
 *    pretending to be content, and on a compliance surface it is worse than
 *    blank: a reader glancing at the column sees "a document" and moves on.
 */
function PageMock({ caption, action, skeleton }: { caption?: string; action?: ReactNode; skeleton?: boolean }) {
  return (
    <div className="h-fit min-h-[320px] w-full max-w-[520px] rounded-lg border bg-background p-7 shadow-lg">
      <div className="flex items-baseline justify-between border-b pb-2.5">
        <div className="space-y-1.5">
          {/* The alphas are the point here, not drift: a skeleton paints solid
              bars (content is COMING), the page mock paints faded ones (this is
              an illustration of a page, and nothing is coming). Same bars, two
              claims, and the opacity is what separates them. */}
          <div className={cn('h-[9px] w-28 rounded-sm', skeleton ? 'bg-muted' : 'bg-muted/50')} />
          <div className={cn('h-[6px] w-16 rounded-sm', skeleton ? 'bg-muted/70' : 'bg-muted/40')} />
        </div>
        <div className={cn('h-[6px] w-12 rounded-sm', skeleton ? 'bg-muted/70' : 'bg-muted/40')} />
      </div>
      <div className="mt-3.5 flex h-[260px] flex-col items-center justify-center gap-3 rounded border border-dashed px-6 text-center">
        {!skeleton && caption && (
          <p className="max-w-[80%] text-xs leading-relaxed text-muted-foreground text-balance">{caption}</p>
        )}
        {action}
      </div>
      {/* Body lines only while loading: bars under a caption that says the file
          cannot be previewed would be text this document does not have. */}
      {skeleton && (
        <div className="mt-3.5 space-y-1.5">
          <div className="h-[7px] w-3/5 rounded bg-muted" />
          <div className="h-[7px] w-1/2 rounded bg-muted" />
          <div className="h-[7px] w-[55%] rounded bg-muted" />
        </div>
      )}
    </div>
  )
}

function AskColleagueButton({
  projectId,
  file,
  documentId,
}: {
  projectId: string
  file: FileItem
  documentId: string
}): JSX.Element {
  const t = useTranslations('files')
  const router = useRouter()
  return (
    <AssignPopover
      documentId={documentId}
      assignees={file.assignees ?? []}
      pickOnly
      triggerLabel={t('assignment.askColleague')}
      onPick={(person) => {
        const name = person.name || person.email || t('assignment.to')
        askAboutFile({
          projectId,
          file,
          ask: `@${name} `,
          mentions: [{ targetId: person.userId, display: name }],
          navigate: (href) => router.push(href),
        })
      }}
      onChanged={() => undefined}
    />
  )
}
