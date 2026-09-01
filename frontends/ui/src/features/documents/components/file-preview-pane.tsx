'use client'

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { FileTextPage, isTextPageType } from './file-text-page'
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
  FolderTree,
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
import {
  DocumentStatusBadge,
  fileTypeIcon,
  isCitable,
  isNeverIndexed,
  isFailedStatus,
} from './document-status'
import { DrawingStructuredDetails } from './drawing-structured-details'
import { hasStructuredDetail, type DrawingStructured } from '@/lib/documents/drawing-structured'
import { AssignmentFaces } from './assignment-faces'
import { AuthorshipLine } from './authorship-line'
import { AssignPopover } from './assign-popover'
import { useRouter } from 'next/navigation'
import { askAboutFile } from '../lib/ask-about-file'
import { dropFileSubject } from '../lib/open-file-peek'
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

/**
 * Kept in step with `PREVIEW_CONTENT_TYPES` in `lib/documents/service.ts`, which
 * is the authority — this list only decides whether the pane ASKS. The two had
 * drifted: BMP and TIFF passed the service and were missing here, so the BFF
 * would have presigned bytes the pane never requested and the reader got the
 * "no inline preview" mock for a file the product could show.
 */
const PREVIEW_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',
]

/**
 * The building itself, in the well where a PDF shows its pages.
 *
 * `ssr: false` because the viewport underneath reaches for `navigator.gpu`, and
 * `dynamic` because it pulls the BIM hooks and (behind one more boundary) a
 * multi-megabyte WASM kernel — none of which belongs in the bundle of a pane
 * that is usually opened on a PDF.
 */
const IfcFilePreview = dynamic(
  () =>
    import('@/features/bim/components/ifc-file-preview').then((module) => module.IfcFilePreview),
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
  /** Which drawing on the sheet — a sheet is indexed one chunk per drawing. */
  segment?: number
  /** The structured analysis behind the description; absent on older chunks. */
  structured?: DrawingStructured | null
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
  /**
   * „Von Piloti indexiert" is a claim, and on a report Piloti WROTE it is a
   * false one: that document was deliberately never dispatched to `/v1/ingest`,
   * so there is nothing indexed to show and the eyebrow would contradict the
   * hint on the disabled Ask button two lines above it. The rail keeps the
   * facts that come from the file itself (type, size, project) and drops the
   * section that describes an ingestion that never ran.
   */
  const showIndexedSection = showMetadataPanel && !isNeverIndexed(file)
  /**
   * Why „Piloti dazu fragen" is off. „Sobald die Datei zitierbar ist" promises
   * a wait; a report Piloti wrote was deliberately never dispatched to
   * `/v1/ingest`, so there is no wait to promise and the sentence says that
   * instead.
   */
  const askDisabledReason = isNeverIndexed(file)
    ? t('authorship.notInKnowledge')
    : t('assignment.askDisabled')
  const askReasonId = `ask-disabled-${file.id}`
  const router = useRouter()
  const storeMode = useFilePreviewStore((state) => state.mode)
  const storeFileId = useFilePreviewStore((state) => state.file?.id)
  const inChat =
    presentation === 'peek' ||
    presentation === 'expanded' ||
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
  /** The document is not there any more (or not the reader's) — see `loadPreview`. */
  const [previewGone, setPreviewGone] = useState(false)
  /**
   * A text document's content, when the pane renders the bytes itself rather
   * than handing a URL to an iframe. Null for every other format, and for a
   * text document whose fetch has not landed — `previewFailed`/`previewGone`
   * carry the failure, exactly as they do for the URL path.
   */
  const [previewText, setPreviewText] = useState<{ text: string; truncated: boolean } | null>(null)
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
    inferDocumentKind({
      filename: file.filename,
      contentType: file.contentType,
      tags: file.tags,
    }) === 'model'
  const canPreview = PREVIEW_TYPES.includes(file.contentType ?? '')
  /**
   * Text, Markdown and CSV are previewable too, by a different route: the pane
   * fetches the CONTENT and renders it, because the object store publishes no
   * CORS policy and a presigned URL is therefore unreadable to a `fetch`. Kept
   * out of `canPreview` rather than folded into it — that flag means "there is
   * a URL to put in an element", and these have none.
   */
  const isTextual = isTextPageType(file.contentType)
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
  const detectedType = (file.tags ?? []).find((tag) =>
    (DOCUMENT_TYPE_TAGS as readonly string[]).includes(tag)
  )

  const loadPreview = useCallback(() => {
    setPreviewFailed(false)
    setPreviewGone(false)

    if (isTextual) {
      // Same three outcomes as the URL path, and deliberately the same states,
      // so the retry button and the "stop asking about it" way out work on a
      // `.md` exactly as they do on a PDF.
      setPreviewUrl(null)
      setPreviewText(null)
      setIsLoading(true)
      let gone = false
      fetch(`/api/documents/${file.id}/text`)
        .then(async (r) => {
          if (r.status === 404) {
            gone = true
            return null
          }
          return r.ok ? await r.json() : null
        })
        .then((data) => {
          if (typeof data?.text === 'string') {
            setPreviewText({ text: data.text, truncated: data.truncated === true })
          } else if (gone) {
            setPreviewGone(true)
          } else {
            setPreviewFailed(true)
          }
        })
        .catch(() => {
          setPreviewText(null)
          setPreviewFailed(true)
        })
        .finally(() => setIsLoading(false))
      return
    }

    setPreviewText(null)
    if (!canPreview) {
      setPreviewUrl(null)
      return
    }

    setIsLoading(true)
    // A local, not the state above: the branch that sets it and the branch that
    // reads it are two links of the same promise chain, and a `useState` value
    // does not change between them.
    let gone = false
    fetch(`/api/documents/${file.id}/preview`)
      .then(async (r) => {
        // A RETRY THAT CANNOT WORK IS A DEAD END WEARING A BUTTON.
        //
        // 404 here is not a hiccup: the service answers it for a document that
        // has been deleted AND for one this reader may no longer open (see
        // `getAccessibleDocument` — cross-tenant and no-access both surface as
        // 404). Neither changes by asking again, and in a shared project both
        // happen while somebody is mid-conversation about the file. Offering
        // "Erneut versuchen" there is an invitation to press a button until
        // they give up; what they need is to be told, and to be let out.
        if (r.status === 404) {
          gone = true
          return null
        }
        return r.ok ? await r.json() : null
      })
      .then((data) => {
        if (data?.url) {
          setPreviewUrl(data.url)
          // Absent for PDFs and for image formats the optimizer cannot process;
          // the renderer falls back to `url` unoptimized in both cases.
          setPreviewImageUrl(typeof data.imageUrl === 'string' ? data.imageUrl : null)
        } else if (gone) {
          setPreviewGone(true)
        } else {
          setPreviewFailed(true)
        }
      })
      .catch(() => {
        setPreviewUrl(null)
        setPreviewImageUrl(null)
        setPreviewFailed(true)
      })
      .finally(() => setIsLoading(false))
  }, [file.id, canPreview, isTextual])

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
  const actions = useDocumentActions({ document: file, scope, onReingested })

  // Re-dispatch a failed document to the ingest pipeline. The request itself
  // lives in `useDocumentActions` with rename/delete/download — one document
  // operation belongs in one place, and the actions MENU offers the same retry
  // now, on the card where the failure is actually read.
  const handleReingest = useCallback(() => void actions.reingest(), [actions])

  const ext = fileExtensionLabel(file.filename)

  return (
    <div className="@container bg-card flex h-full min-h-0 flex-col">
      {/* Peek chrome lives on the host — this header is the modal/expanded one.

          The row WRAPS, because on a phone it cannot hold both a filename and
          five controls. Every action carries `shrink-0` (correctly — an
          80px-wide „Herunterladen" is not a control), so the title block was
          the only thing able to give, and with `min-w-0` it gave everything:
          the name rendered as „f.", the „Von Piloti erstellt" byline as „C",
          and the status badge collided with the Ask button. A floor on the
          title block turns that into a wrap — one row on any container wide
          enough, name over actions on one that is not. 11rem is about twenty
          characters of the 14px name, enough that truncation is reading a
          filename rather than guessing at one.

          The basis is the row minus the extension chip, so the break is
          DETERMINISTIC: the name and the chip take the first row and every
          action wraps together onto the second. Left to `flex-1` alone the
          break fell wherever the remaining width happened to run out, which put
          „Ask Piloti" beside the name and the other four beneath it — an action
          row split across two lines for no reason a reader could see. */}
      {!peeking && (
        <div className="@md:flex-nowrap @md:gap-x-3 @md:px-5 flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-2 border-b px-3.5 pb-3.5 pt-[max(0.875rem,env(safe-area-inset-top))] sm:pt-3.5">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold uppercase leading-none"
            style={extChipTint(ext)}
            aria-hidden
          >
            {ext || <Icon className="size-4" />}
          </span>
          <div className="@md:min-w-0 @md:basis-0 min-w-[11rem] flex-1 basis-[calc(100%-3.25rem)]">
            {/* The name the document was GIVEN, if it was given one. `title`
              carries it in full for the truncated case — and the file's own
              name underneath it, which is the answer to "which file is this
              actually" for anyone who renamed it. */}
            <h3
              className="text-foreground truncate text-sm font-semibold leading-tight tracking-[-0.01em]"
              title={actions.isRenamed ? `${actions.name}\n${file.filename}` : actions.name}
            >
              {actions.name}
            </h3>
            {/* The byline, under the name and ABOVE the type · status line, which
              keeps it clear of the assignment row further down: provenance and
              responsibility are two answers that must never be read as one. */}
            <AuthorshipLine authoredBy={file.authoredBy} className="mt-0.5" />
            {/* Type AND status on one line. The status badge used to live only in
              the metadata column, below the fold on a narrow panel — so the one
              question a reader has on opening a file ("is this actually indexed,
              or am I looking at a document the agent cannot see?") was answered
              further away than the answer to "what format is it". A document in
              `failed` is the case that matters, and it must not require a
              scroll. */}
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              <p className="text-muted-foreground truncate text-xs">
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
          {projectId && isCitable(file) && !inChat && (
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
          {projectId && canCollaborate && isCitable(file) && (
            <AskColleagueButton projectId={projectId} file={file} documentId={file.id} />
          )}
          {/* Disabled rather than hidden, the way this surface already treats a
            document that is still being read — but the HINT has to tell the
            truth. „Sobald die Datei zitierbar ist" promises a wait; a report
            Piloti wrote was deliberately never indexed, so there is nothing to
            wait for, and the hint says why instead. No `Piloti dazu fragen`
            affordance appears in any other form here: that is the design, not
            a gap. */}
          {projectId && !isCitable(file) && !isFailedStatus(file.status) && (
            // The reason sits on a WRAPPER, not on the button. A disabled
            // `<button>` dispatches no pointer events in Chrome or Safari, so a
            // `title` on it is a tooltip that can never open — the one sentence
            // explaining why Ask is off was unreachable for every reader. The
            // span is not disabled and does receive hover, so the explanation
            // exists again; `aria-describedby` gives it to the reader who is not
            // hovering anything.
            <span title={askDisabledReason} className="shrink-0">
              <Button size="sm" className="h-8 shrink-0" disabled aria-describedby={askReasonId}>
                {t('assignment.ask')}
              </Button>
              <span id={askReasonId} className="sr-only">
                {askDisabledReason}
              </span>
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:min-w-11 @md:px-3 h-8 shrink-0 gap-1.5 px-2"
            onClick={() => void actions.download()}
            disabled={actions.isDownloading}
            aria-label={t('preview.download')}
            title={t('preview.download')}
          >
            <Download className="size-3.5" aria-hidden />
            <span className="@md:inline hidden">{t('preview.download')}</span>
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
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={onClose}
              aria-label={t('preview.closePreview')}
            >
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
          {/* THE SAME DEAD END, ONE LEVEL DOWN. A download of a document that
              is not there any more fails for the reason the preview already
              established, and offering "Erneut versuchen" for it is the same
              button-until-you-give-up loop — so when the preview has already
              said the document is gone, this says it too, and offers the way
              out rather than the retry. */}
          <p className="text-destructive text-xs">
            {previewGone ? t('preview.gone') : t('preview.downloadFailed')}
          </p>
          {previewGone ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 gap-1.5"
              onClick={() =>
                dropFileSubject({
                  cleared: t('preview.goneCleared'),
                  undo: t('preview.goneUndo'),
                })
              }
            >
              <X className="size-3.5" aria-hidden />
              {t('preview.goneAction')}
            </Button>
          ) : (
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
          )}
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
          peeking ? 'overflow-hidden' : '@2xl:flex-row @2xl:overflow-hidden overflow-y-auto'
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
            'from-muted/25 to-muted/60 flex min-w-0 justify-center overflow-hidden bg-gradient-to-b',
            peeking
              ? // THE GROUND IS THE DOCUMENT'S, and the document sits centred on
                // it. A drawing fitted to the width of a 320px pane is a quarter
                // of its height and the well cannot make it bigger — width is the
                // binding constraint, so the leftover vertical space exists
                // whatever this element does. Top-aligned, the document read as
                // having fallen to the top of a box. Handing the slack to the
                // summary below was worse: that block's content is four lines
                // whatever the pane's height, so the emptiness simply moved under
                // it and changed colour. Centred on its own ground, with the
                // summary as a footer band beneath, is the composition that reads
                // as deliberate at every height.
                'h-full min-h-0 flex-1 items-center p-3'
              : '@2xl:h-auto @2xl:min-h-0 @2xl:flex-1 @2xl:overflow-y-auto @2xl:overscroll-contain @2xl:p-7 h-[50dvh] min-h-[50dvh] shrink-0 p-5'
          )}
        >
          {isModel ? (
            <IfcFilePreview
              documentId={file.id}
              filename={file.filename}
              projectId={projectId}
              className="size-full"
            />
          ) : isTextual && isLoading ? (
            <PageMock skeleton />
          ) : isTextual && previewText ? (
            <FileTextPage
              text={previewText.text}
              truncated={previewText.truncated}
              contentType={file.contentType}
              truncatedLabel={t('preview.textTruncated')}
              peeking={peeking}
            />
          ) : canPreview && isLoading ? (
            <PageMock skeleton />
          ) : canPreview && previewUrl ? (
            file.contentType === 'application/pdf' ? (
              <iframe
                src={previewUrl}
                className={cn(
                  'bg-background h-full w-full rounded-lg border',
                  // `shadow-sm` is the CARD step of the elevation ramp; `xs`
                  // dresses chips and buttons, and under a document it did not
                  // read as a page on a ground at all. `lg` is the modal step,
                  // which is what the enlarged view is.
                  peeking ? 'shadow-sm' : 'shadow-lg'
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
                className={cn(
                  'bg-background @2xl:max-h-none h-fit max-h-full w-auto max-w-full rounded-lg border object-contain',
                  peeking ? 'shadow-sm' : 'shadow-lg'
                )}
              />
            )
          ) : (
            <PageMock
              caption={
                previewGone
                  ? t('preview.gone')
                  : previewFailed
                    ? t('preview.loadFailed')
                    : t('preview.noInlinePreview')
              }
              action={
                previewGone ? (
                  // The only move left. The document is not coming back, and
                  // the conversation is still pointed at it — so the way out is
                  // to stop asking about it, which is also the one thing the
                  // reader cannot do from inside a viewer that will not load.
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() =>
                      dropFileSubject({
                        cleared: t('preview.goneCleared'),
                        undo: t('preview.goneUndo'),
                      })
                    }
                  >
                    <X className="size-3.5" aria-hidden />
                    {t('preview.goneAction')}
                  </Button>
                ) : previewFailed && (canPreview || isTextual) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={loadPreview}
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                    {t('preview.tryAgain')}
                  </Button>
                ) : (
                  // "No inline preview for this file type" used to end there:
                  // a sentence about a document, in the middle of the surface
                  // that exists to show it, with nothing to do next. The
                  // sentence already names the way out ("download it to view
                  // the full document") — so the way out is here, rather than
                  // an icon the reader has to go and find in the chrome.
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => void actions.download()}
                    disabled={actions.isDownloading}
                  >
                    <Download className="size-3.5" aria-hidden />
                    {t('preview.download')}
                  </Button>
                )
              }
            />
          )}
        </div>

        {/* WHAT PILOTI MADE OF IT, in the peek.
            The peek dropped the whole rail — properties, tags, the lot — which
            is right: a 320px column beside a conversation is not where a
            reader edits metadata. But it dropped the SUMMARY with it, and the
            summary is the one line of that rail this surface is actually about:
            the peek exists because this document is what the next question is
            about, so "does Piloti understand it, and as what" is the question
            the reader has, and the answer was two clicks away in the enlarged
            view.
            It also lands where there was nothing. A portrait plan fitted to a
            320px pane is half its height, so the well below the drawing was
            several hundred pixels of empty ground — the reader's eye had
            nowhere to go and nothing to do. Capped and scrollable so a
            twelve-line ingestion summary cannot take the document's place, and
            absent entirely when there is no summary yet. */}
        {peeking && file.summary && (
          <section
            aria-label={t('preview.indexed.title')}
            className="border-base bg-surface-sunken scroll-fade-bottom max-h-[38%] shrink-0 overflow-y-auto overscroll-contain border-t px-3 py-2.5"
          >
            <SectionLabel as="p" icon={Sparkles} className="font-semibold tracking-[0.05em]">
              {t('preview.indexed.title')}
            </SectionLabel>
            <div className="mt-1.5">
              <IndexedSummary key={file.id} summary={file.summary} />
            </div>
          </section>
        )}

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
          <div className="scroll-fade-bottom bg-surface-sunken @2xl:w-[280px] @2xl:shrink-0 @2xl:min-h-0 @2xl:overflow-y-auto @2xl:overscroll-contain @2xl:border-l @2xl:border-t-0 @2xl:pb-4 flex w-full flex-col border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
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
            {showIndexedSection && (
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
            <section className={cn('space-y-2', showIndexedSection && 'mt-4')}>
              <SectionLabel as="p" icon={FileCode2} className="font-semibold tracking-[0.05em]">
                {t('preview.properties')}
              </SectionLabel>
              <div className="space-y-2">
                {showMetadataPanel && detectedType && (
                  <MetaRow label={t('preview.indexed.documentType')} icon={FileType2}>
                    <span className="text-foreground text-xs font-medium">{detectedType}</span>
                  </MetaRow>
                )}
                {showMetadataPanel && projectName && (
                  <MetaRow label={t('preview.indexed.project')} icon={FolderOpen}>
                    <span className="text-foreground truncate text-xs font-medium">
                      {projectName}
                    </span>
                  </MetaRow>
                )}
                {showMetadataPanel && typeof file.pageCount === 'number' && file.pageCount > 0 && (
                  <MetaRow label={t('preview.pages')} icon={FileText}>
                    <span className="text-foreground text-xs font-medium tabular-nums">
                      {file.pageCount}
                    </span>
                  </MetaRow>
                )}
                {showMetadataPanel &&
                  typeof file.chunkCount === 'number' &&
                  file.chunkCount > 0 && (
                    <MetaRow label={t('preview.chunks')} icon={Layers}>
                      <span className="text-foreground text-xs font-medium tabular-nums">
                        {file.chunkCount}
                      </span>
                    </MetaRow>
                  )}
                {showMetadataPanel && hasRichContent && (
                  <MetaRow label={t('preview.contents')} icon={Shapes}>
                    <span className="text-foreground text-xs">
                      {file.contentTypes!.map((c) => t(`preview.contentTypeNames.${c}`)).join(', ')}
                    </span>
                  </MetaRow>
                )}
                {/* No status row: the header badge already answers it, and the
                  same fact stated twice on one surface reads as two facts. */}
                <MetaRow label={t('preview.type')} icon={FileCode2}>
                  <span className="text-foreground truncate font-mono text-xs">
                    {file.contentType ?? t('preview.unknownType')}
                  </span>
                </MetaRow>
                <MetaRow label={t('preview.size')} icon={HardDrive}>
                  <span className="text-foreground text-xs font-medium tabular-nums">
                    {formatBytes(file.fileSize, locale)}
                  </span>
                </MetaRow>
                {file.originPath && (
                  /* WHERE THIS FILE CAME FROM, so the reader can go back to it.
                     The alternative on offer was download-and-edit, which makes
                     a duplicate that the office server never hears about and
                     that diverges from the moment it is saved. A path they can
                     copy and paste into Explorer or Finder is the whole
                     feature. Recorded by a folder upload only — a picked file
                     genuinely has no origin path, and the row is absent rather
                     than empty. */
                  <MetaRow label={t('preview.originPath')} icon={FolderTree}>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(file.originPath!)
                          .then(() => toast.success(t('preview.originPathCopied')))
                          .catch(() => toast.error(t('preview.originPathCopyFailed')))
                      }}
                      title={file.originPath}
                      className="text-foreground hover:text-foreground/80 min-w-0 truncate text-left font-mono text-xs underline-offset-2 hover:underline"
                      data-testid="file-origin-path"
                    >
                      {file.originPath}
                    </button>
                  </MetaRow>
                )}
                {showMetadataPanel && (
                  <MetaRow label={t('preview.indexed.updated')} icon={Clock}>
                    <span className="text-foreground text-xs font-medium tabular-nums">
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
                      className="text-muted-foreground duration-snap hover:text-foreground touch-target flex w-full items-center justify-between gap-2 text-left text-[10.5px] font-medium uppercase tracking-wider transition-colors ease-out motion-reduce:transition-none"
                    >
                      {t('preview.visualDetails.title')}
                      <ChevronDown
                        className={cn(
                          'duration-quick size-3.5 shrink-0 transition-transform ease-out motion-reduce:transition-none',
                          detailsOpen && 'rotate-180'
                        )}
                        aria-hidden
                      />
                    </button>
                    {detailsOpen && (
                      <div className="mt-2.5 space-y-3">
                        {detailsLoading && (
                          <p className="text-muted-foreground text-xs">
                            {t('preview.visualDetails.loading')}
                          </p>
                        )}
                        {!detailsLoading && details && details.length === 0 && (
                          <p className="text-muted-foreground text-xs">
                            {t('preview.visualDetails.empty')}
                          </p>
                        )}
                        {!detailsLoading &&
                          details?.map((d, i) => (
                            <div
                              key={`${d.page}-${d.contentType}-${d.segment ?? 0}-${i}`}
                              className="space-y-1"
                            >
                              <div className="text-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-medium">
                                <span>{t('preview.visualDetails.page', { page: d.page })}</span>
                                {d.drawingType && (
                                  <span className="text-muted-foreground">· {d.drawingType}</span>
                                )}
                                {d.scale && d.scale.toLowerCase() !== 'unbekannt' && (
                                  <span className="text-muted-foreground">
                                    · {t('preview.visualDetails.scale', { scale: d.scale })}
                                  </span>
                                )}
                              </div>
                              <p className="text-muted-foreground whitespace-pre-line text-xs leading-relaxed">
                                {d.text}
                              </p>
                              {hasStructuredDetail(d.structured ?? null) && d.structured && (
                                <DrawingStructuredDetails structured={d.structured} />
                              )}
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
                  <AlertCircle className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
                  <div className="min-w-0 space-y-1">
                    <p className="text-destructive text-sm font-medium">
                      {t('preview.ingestionFailed')}
                    </p>
                    <p className="text-muted-foreground break-words text-xs">
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
                    disabled={actions.isReingesting}
                  >
                    <RotateCcw className="size-4" aria-hidden />
                    {actions.isReingesting
                      ? t('preview.retryingIngestion')
                      : t('preview.retryIngestion')}
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
            {/* Same claim as the section eyebrow, in a sentence — „beim Hochladen
              automatisch erkannt" is about an upload and an ingestion that a
              report Piloti wrote never had. */}
            {showIndexedSection && (
              <p className="text-muted-foreground/80 mt-4 border-t pt-3 text-xs leading-relaxed">
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
    <div className="bg-card shadow-2xs rounded-lg border p-3">
      <p
        ref={textRef}
        className={cn('text-foreground text-sm leading-[1.55]', !expanded && 'line-clamp-5')}
        style={!expanded ? { WebkitLineClamp: SUMMARY_CLAMP_LINES } : undefined}
      >
        {summary}
      </p>
      {(isTruncated || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="text-muted-foreground duration-snap hover:text-foreground focus-visible:ring-ring/50 touch-target mt-1.5 inline-flex items-center gap-1 text-xs font-medium transition-colors ease-out focus-visible:outline-none focus-visible:ring-2 motion-reduce:transition-none"
        >
          {expanded ? t('preview.summaryLess') : t('preview.summaryMore')}
          <ChevronDown
            className={cn(
              'duration-quick size-3 shrink-0 transition-transform ease-out motion-reduce:transition-none',
              expanded && 'rotate-180'
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
      void persist(
        tags.filter((existing) => existing !== tag),
        tags
      )
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
      <p className="text-muted-foreground text-xs">{t('preview.tags')}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag}
            className="bg-muted text-muted-foreground inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium"
          >
            {tag}
            {!readOnly && (
              <button
                type="button"
                onClick={() => removeTag(tag)}
                disabled={isSaving}
                aria-label={t('preview.removeTag', { tag })}
                className="duration-snap hover:bg-accent hover:text-foreground focus-visible:ring-ring touch-target -mr-0.5 rounded-sm p-0.5 transition-colors ease-out focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50 motion-reduce:transition-none"
              >
                <X className="size-3" aria-hidden />
              </button>
            )}
          </span>
        ))}
        {tags.length === 0 && readOnly && (
          <span className="text-muted-foreground/70 text-xs">{t('preview.noTags')}</span>
        )}
        {!readOnly && !atCap && (
          <span className="relative inline-flex items-center">
            {/* Follows the field's own left padding, which grows with it. */}
            <Plus
              className="text-muted-foreground pointer-coarse:left-3 pointer-events-none absolute left-1.5 size-3"
              aria-hidden
            />
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
              // A raw `<input>`, so it inherits none of what `ui/input.tsx` does
              // for a phone. Two of those are load-bearing here:
              //
              // `text-xs` is 12px, and iOS Safari zooms the whole page in when a
              // field under 16px takes focus. That zoom is not undone on blur —
              // the reader is left in a magnified preview pane, scrolled
              // sideways, having typed one tag. `pointer-coarse:text-base` is the
              // same 16px floor the Input primitive carries, applied on the axis
              // that actually predicts a soft keyboard.
              //
              // `h-6` is 24px, a little over half the touch floor, on a control
              // that has to be hit precisely because a mis-tap lands on a tag
              // chip that removes itself.
              className="border-input text-foreground placeholder:text-muted-foreground/70 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:w-36 pointer-coarse:pl-8 pointer-coarse:text-base h-6 w-28 rounded-md border border-dashed bg-transparent pl-6 pr-1.5 text-xs focus-visible:border-solid focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50"
            />
          </span>
        )}
      </div>
      {/* Controlled-vocabulary suggestions while the input is active: the PATCH
          endpoint rejects free-form values, so offer the real choices. */}
      {!readOnly && isEditing && suggestions.length > 0 && (
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t('preview.suggestionsLabel')}
        >
          {suggestions.map((tag) => (
            <button
              key={tag}
              type="button"
              // Keep the input focused so blur doesn't race the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => addTag(tag)}
              disabled={isSaving}
              // The suggestions ARE the way to add a tag on a phone: the endpoint
              // rejects free-form values, so tapping one of these is the whole
              // interaction, and at `py-0.5` each was a 20px chip in a wrapped row
              // of them. Grown rather than overhung — they are neighbours in a
              // flex-wrap row, so catchments would land on each other.
              className="border-border text-muted-foreground duration-snap hover:bg-muted hover:text-foreground focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:px-3.5 inline-flex items-center rounded-md border bg-transparent px-2 py-0.5 text-xs font-medium transition-colors ease-out focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50 motion-reduce:transition-none"
            >
              {tag}
            </button>
          ))}
        </div>
      )}
      {showNoMatchHint && (
        <p className="text-muted-foreground/70 text-xs">{t('preview.noTagMatch')}</p>
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
      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 pt-px text-xs">
        <Icon className="text-muted-foreground/70 size-3.5 shrink-0" aria-hidden />
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
function PageMock({
  caption,
  action,
  skeleton,
}: {
  caption?: string
  action?: ReactNode
  skeleton?: boolean
}) {
  return (
    <div className="bg-background h-fit min-h-[320px] w-full max-w-[520px] rounded-lg border p-7 shadow-lg">
      <div className="flex items-baseline justify-between border-b pb-2.5">
        <div className="space-y-1.5">
          {/* The alphas are the point here, not drift: a skeleton paints solid
              bars (content is COMING), the page mock paints faded ones (this is
              an illustration of a page, and nothing is coming). Same bars, two
              claims, and the opacity is what separates them. */}
          <div className={cn('h-[9px] w-28 rounded-sm', skeleton ? 'bg-muted' : 'bg-muted/50')} />
          <div
            className={cn('h-[6px] w-16 rounded-sm', skeleton ? 'bg-muted/70' : 'bg-muted/40')}
          />
        </div>
        <div className={cn('h-[6px] w-12 rounded-sm', skeleton ? 'bg-muted/70' : 'bg-muted/40')} />
      </div>
      <div className="mt-3.5 flex h-[260px] flex-col items-center justify-center gap-3 rounded border border-dashed px-6 text-center">
        {!skeleton && caption && (
          <p className="text-muted-foreground max-w-[80%] text-balance text-xs leading-relaxed">
            {caption}
          </p>
        )}
        {action}
      </div>
      {/* Body lines only while loading: bars under a caption that says the file
          cannot be previewed would be text this document does not have. */}
      {skeleton && (
        <div className="mt-3.5 space-y-1.5">
          <div className="bg-muted h-[7px] w-3/5 rounded" />
          <div className="bg-muted h-[7px] w-1/2 rounded" />
          <div className="bg-muted h-[7px] w-[55%] rounded" />
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
