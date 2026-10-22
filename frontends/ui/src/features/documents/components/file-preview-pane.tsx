'use client'

import type { JSX } from 'react'
import {
  INLINE_PREVIEW_CONTENT_TYPES,
  isOfficeRenditionSource,
} from '@/lib/documents/preview-types'

import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { FileTextPage, isTextPageType } from './file-text-page'
import Image from 'next/image'
import dynamic from 'next/dynamic'
import { toast } from 'sonner'
import type { FileItem } from './project-file-workspace'
import {
  AlertCircle,
  Download,
  FileText,
  FolderTree,
  Info,
  ListTree,
  Maximize2,
  MessageSquarePlus,
  MessageSquareText,
  RotateCcw,
  ScanEye,
  ShieldAlert,
  ShieldOff,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { firstFinding, quarantineVerdictOf, type QuarantineFinding } from '@/lib/upload-screening/quarantine'
import { ApiRequestError } from '@/adapters/api/api-error'
import {
  getQuarantineReviewAccess,
  releaseQuarantinedDocument,
  type QuarantineReviewAccess,
} from '@/adapters/api/upload-screening-client'
import { notifyDocumentsChanged } from '@/lib/documents/document-changes'
import { QuarantineFindings } from './quarantine-findings'
import { RequestReviewButton } from './request-review-button'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { SectionLabel } from '@/components/ui/section-label'
import { InspectorGroup, InspectorRow, InspectorSection } from '@/components/ui/inspector-group'
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item'
import { InsetStage } from '@/components/ui/inset-stage'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { RevisionLinks } from '@/lib/documents/revision-links'
import { documentTypeOf, tagLabel } from '@/lib/documents/tag-vocabulary'
import { ClampedText } from '@/components/ui/clamped-text'
import { documentFileUrl } from '@/lib/documents/urls'
import { useLocale, useTranslations } from '@/i18n'
import { isOptimizerEligible } from '@/lib/images/optimizable'
import { cn } from '@/lib/utils'
import { inferDocumentKind } from '../document-kind'
import type { DocumentKind } from '../document-kind'
import { DocumentKindThumbnail } from './document-kind-thumbnail'
import { FileExtChip } from './file-ext-chip'
import type { OpenMarksAtApproval } from './document-review-controls'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { PdfDocumentView } from '@/features/knowledge/components/pdf-document-view'
import { SimilarPassagesDialog } from '@/features/similar-passages/components/similar-passages-dialog'
import type { SimilarPassagesRequest } from '@/lib/similar-passages/types'
import { useSeenOnce } from '@/hooks/use-seen-once'
import { useMediaQuery } from '@/hooks/use-media-query'
import { PHONE_ON_ITS_SIDE_QUERY, PHONE_QUERY } from '@/hooks/use-is-mobile'
import { MiddleTruncate } from '@/components/ui/middle-truncate'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  DeleteDocumentDialog,
  DocumentActionsMenu,
  useDocumentActions,
  useMoveInSheet,
  type DocumentActions,
  type DocumentScope,
} from './document-actions'
import {
  DocumentStatusBadge,
  failedWithPreviousVersion,
  fileTypeIcon,
  isCitable,
  isCitableStatus,
  isNeverIndexed,
  isSettlingStatus,
} from './document-status'
import { PilotiReading } from './piloti-reading'
import { PageReadings, type VisualDetail } from './page-readings'
import { useFileFacts } from '../hooks/use-file-facts'
import { IngestFailureNotice } from './ingest-failure-notice'
import { AssignmentFaces } from './assignment-faces'
import { AuthorshipLine } from './authorship-line'
import { DocumentRevisions } from './document-revisions'
import { showsRevisionsSection } from '../lib/revision-timeline'
import { DocumentVersionStateBadge } from './document-version-badge'
import type {
  DocumentLifecyclePermission,
  DocumentVersionState,
} from '@/lib/documents/lifecycle-types'
import { AssignPopover } from './assign-popover'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { backLandsOn } from '@/lib/navigation/history-step'
import { askAboutFile } from '../lib/ask-about-file'
import { DiscussDocumentButton } from './discuss-document-button'
import { dropFileSubject } from '../lib/open-file-peek'
import { useFilePreviewStore } from '../stores/file-preview-store'
import { useDocumentReview } from '../hooks/use-document-review'
import { AnnotationsSummary } from './review/annotations-summary'
import { DocumentReviewMode, Presence, useRoomCompany } from './review/document-review'
import { tabCounts } from './review/review-panel'
import { ReviewPageLayer } from './review/review-page-layer'
import { InlineMarkPeek } from './inline-mark-peek'
import {
  clearReviewParams,
  hrefWithParams,
  readReviewParams,
  reviewFilesHref,
  setReviewParams,
  type ReviewLinkTool,
} from '../lib/open-review'
import { isLive, type MarkTally } from '@/lib/annotations/types'
import { CountPill } from '@/components/ui/count-pill'
import { ToolbarTextButton } from '@/components/ui/floating-toolbar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useCurrentProject } from '@/features/projects/lib/current-project'
import { ProjectClosedChip } from '@/components/projects/project-status'

interface FilePreviewPaneProps {
  file: FileItem
  /** Present for project documents; omitted for the org-wide Archiv (unused here). */
  projectId?: string
  /** Project display name for the indexed-metadata panel's Project row. */
  projectName?: string
  /**
   * Whether the viewer may mutate the document (edit tags, re-ingest). Defaults
   * to true (all project callers). The Archiv passes the caller's manage
   * capability so members without `org:office_shelf:manage` get a read-only pane.
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
  onTagsUpdated?: (fileId: string, tags: string[], topics?: string[]) => void
  /** Open another document of this shelf here, from the Fassungen section. */
  onOpenDocument?: (fileId: string) => void
  /** A link was confirmed or taken back: the Fassung facts of one of the two documents, so the listing moves both cards. */
  onRevisionChanged?: (fileId: string, revision: RevisionLinks | null) => void
  /**
   * Whether the "Indexed by GRID" metadata panel (AI summary, key-value props,
   * editable tags) renders (FB-8). On by default, the chat peek included,
   * where it is the Details tab. Status/type/size rows always render.
   */
  showMetadataPanel?: boolean
  /**
   * Whether an `.ifc` preview offers the model workspace (`ifc-models`).
   *
   * Defaults to true: a link that does not
   * render is a feature nobody can find, and the workspace refuses on its own
   * if the flag is really off.
   */
  showModels?: boolean
  /** Which corpus the document belongs to — decides the file operations' route. */
  scope?: DocumentScope
  /** The document was renamed from the header menu. */
  onRenamed?: (fileId: string, displayName: string | null) => void
  /** The document was deleted from the header menu; the pane closes itself. */
  onDeleted?: (fileId: string) => void
  canCollaborate?: boolean
  /**
   * What this reader may do to the document's versions, resolved on the server
   * (`lib/documents/lifecycle-permissions.ts`). Absent means the surface did not
   * read them — the Archiv sheet, the chat peek — and the rail then shows no
   * Freigabe section at all rather than guessing a set.
   */
  lifecyclePermissions?: readonly DocumentLifecyclePermission[]
  /** The reader, so their own acts in the version list read as „Sie". */
  viewerUserId?: string | null
  /** A Freigabe decision landed — the listing behind the pane moves its badge. */
  onLifecycleChanged?: (
    fileId: string,
    summary: { versionState: DocumentVersionState; versionCount: number },
  ) => void
  /**
   * The review read the marks, or the reader changed them: the listing's tally
   * for this document, as the server counts it (`tallyLiveMarks`), `null` when
   * none is live. Dateien's chip is read with the listing and would otherwise
   * say „5 offen“ after the reader closed all five here.
   */
  onMarksChanged?: (fileId: string, marks: MarkTally | null) => void
  /** Modal on Files; peek/expanded once this file is the chat subject. */
  presentation?: 'modal' | 'peek' | 'expanded'
  onAssigneesChanged?: (assignees: FileItem['assignees']) => void
}

/** The one list (`lib/documents/preview-types.ts`); this pane no longer keeps a copy. */
const PREVIEW_TYPES: readonly string[] = INLINE_PREVIEW_CONTENT_TYPES

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

const VISUAL_CONTENT_TYPES = ['drawing', 'image', 'chart']

export function FilePreviewPane({
  file,
  projectId,
  projectName,
  canManage = true,
  lifecyclePermissions,
  viewerUserId,
  onLifecycleChanged,
  onMarksChanged,
  scope = 'files',
  onClose,
  onReingested,
  onTagsUpdated,
  onOpenDocument,
  onRevisionChanged,
  onRenamed,
  onDeleted,
  showMetadataPanel = true,
  showModels = true,
  canCollaborate = false,
  presentation = 'modal',
  onAssigneesChanged,
}: FilePreviewPaneProps) {
  const t = useTranslations('files')
  // The project this pane sits in, when it is closed and the file is one of its
  // own (not an Archiv file, not another project's): the chip under the name.
  const currentProject = useCurrentProject()
  const closedProjectName =
    currentProject?.status === 'closed' && scope !== 'officeShelf' && (projectId ?? currentProject.id) === currentProject.id
      ? (projectName ?? currentProject.name)
      : null
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
   * Which of the section's two claims holds right now. „Von Piloti indexiert"
   * over nothing, while the document was still being read or under a failed
   * block, promised a summary that was not coming (yet). Citable: the heading,
   * over the summary once there is one. Still being read: one line saying so,
   * which the settling poll replaces with the summary when it lands. Failed:
   * neither — the failure block above already says what happened.
   */
  const indexedReady = showIndexedSection && isCitableStatus(file.status)
  const indexedPending = showIndexedSection && isSettlingStatus(file.status)
  const showIndexedHeading = indexedReady || indexedPending
  /**
   * What „Besprechen" will and will not be able to do with this document.
   *
   * It is a hint and no longer a reason a control is off: a report Piloti wrote
   * was deliberately never dispatched to `/v1/ingest`, so it is not Projektwissen
   * and cannot be cited as such — and it can still be read and discussed. Only
   * the never-indexed case has anything to say; a citable document's button
   * needs no explaining. The words name Piloti as the author, so a person's
   * upload that is not in the index (archived, or never dispatched) gets none.
   */
  const discussHint =
    file.authoredBy && file.authoredBy !== 'user' && isNeverIndexed(file) ? t('authorship.notInKnowledge') : undefined
  /**
   * Review controls are for a project document and a surface that resolved this
   * reader's lifecycle permissions — the Archiv and the chat peek pass neither,
   * and a control they cannot honour is worse than none.
   */
  const reviewViewer =
    projectId && lifecyclePermissions ? { permissions: lifecyclePermissions, userId: viewerUserId } : undefined
  const assigneeNames = Object.fromEntries(
    (file.assignees ?? []).flatMap((person) => (person.name ? [[person.userId, person.name] as const] : [])),
  )
  const revisionsShown = showsRevisionsSection({
    facts: file.revision ?? null,
    versionCount: file.versionCount,
    hasViewer: reviewViewer !== undefined,
  })
  const storeMode = useFilePreviewStore((state) => state.mode)
  const storeFileId = useFilePreviewStore((state) => state.file?.id)
  const inChat =
    presentation === 'peek' ||
    presentation === 'expanded' ||
    ((storeMode === 'peek' || storeMode === 'expanded') && storeFileId === file.id)
  const peeking = presentation === 'peek'
  /**
   * THE READER, ON A PHONE. Opened from Dateien, from the chat's file pill or
   * from a citation, a document on a phone is one presentation: the document
   * edge to edge between a one-line header and the actions at the thumb, and
   * everything the rail knows one tap away in a sheet. The stacked layout it
   * replaces gave a drawing a 50dvh well with the metadata scrolling under it,
   * which on a 393px phone is a third of the screen for the thing the reader
   * opened. A phone on its side counts: 393px of height cannot spare a second
   * band for the actions, so they move up into the header.
   */
  // On touch or a narrow screen „Verschieben" opens the searchable move sheet,
  // not a dropdown submenu a phone clips.
  const moveInSheet = useMoveInSheet()
  const onPhone = useMediaQuery(PHONE_QUERY)
  const sideways = useMediaQuery(PHONE_ON_ITS_SIDE_QUERY)
  const reader = onPhone && !peeking
  const [detailsOpen, setDetailsOpen] = useState(false)
  useEffect(() => {
    setDetailsOpen(false)
  }, [file.id])
  /**
   * Which face of the peek is up: the document, or everything the Files dialog
   * knows about it. Back to the document whenever a different file arrives —
   * a citation opening the next file should show that file, not its metadata.
   */
  const [peekView, setPeekView] = useState<PeekView>('document')
  useEffect(() => {
    setPeekView('document')
  }, [file.id])
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  /**
   * The same-origin signed path for the same bytes, when the optimizer can
   * serve them. Separate from `previewUrl` rather than replacing it: the
   * "open in new tab" link wants the object-store URL, and a format the
   * optimizer rejects still has to render. (A PDF reads neither: the viewer
   * fetches the same-origin stream, see `documentFileUrl`.)
   */
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null)
  /**
   * What the preview route said it is serving, for an office file only.
   *
   * An office file is never shown as itself: the BFF converts it to a PDF
   * rendition (ADR-0070) and the preview answers with `contentType:
   * 'application/pdf'`. The renderer is chosen from THAT answer rather than
   * from the stored type — the stored `.docx` type would send the URL into the
   * image branch — and anything but a PDF is treated as no rendition at all.
   */
  const [renditionType, setRenditionType] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [previewFailed, setPreviewFailed] = useState(false)
  /** The document is not there any more (or not the reader's) — see `loadPreview`. */
  const [previewGone, setPreviewGone] = useState(false)
  /**
   * A text document's content, when the pane renders the bytes itself rather
   * than handing a URL to an element. Null for every other format, and for a
   * text document whose fetch has not landed — `previewFailed`/`previewGone`
   * carry the failure, exactly as they do for the URL path.
   */
  const [previewText, setPreviewText] = useState<{ text: string; truncated: boolean } | null>(null)
  const [isLargePreviewOpen, setIsLargePreviewOpen] = useState(false)
  // „Auf den Seiten": per-page VLM descriptions of the document's visual
  // chunks (drawings/images/charts), loaded with any document that has them
  // (`PageReadings` says why they lead the rail rather than trail it).
  const [details, setDetails] = useState<VisualDetail[] | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  /**
   * The descriptions could not be READ — a network error, a 500. Not the same
   * answer as "there are none", and it used to say exactly that: a hiccup told
   * the reader the drawing had no descriptions, with no way to ask again.
   */
  const [detailsFailed, setDetailsFailed] = useState(false)
  /**
   * The page a reading asked the viewer to turn to. `'turning'` for the one
   * frame between two asks: the viewer scrolls when its `page` CHANGES, and
   * 7 → 7 is no change, so a second ask for the page the reader has since
   * scrolled away from goes through null first. Null-for-a-frame alone would
   * hand the viewer the quarantine finding's page in between, a second jump.
   */
  const [shownPage, setShownPage] = useState<number | 'turning' | null>(null)
  const turnFrame = useRef<number | null>(null)
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
  const kind = inferDocumentKind({
    filename: file.filename,
    contentType: file.contentType,
    tags: file.tags,
  })
  const isModel = kind === 'model'
  /**
   * Word, Excel, PowerPoint and their ODF kin are shown through a PDF the BFF
   * makes from them (ADR-0070). They ask the same preview route, so they are
   * `canPreview` too; what differs is what comes back and what a refusal means.
   */
  const isOfficeRendition = isOfficeRenditionSource(file)
  const canPreview = PREVIEW_TYPES.includes(file.contentType ?? '') || isOfficeRendition
  /**
   * Text, Markdown and CSV are previewable too, by a different route: the pane
   * fetches the CONTENT and renders it, because the object store publishes no
   * CORS policy and a presigned URL is therefore unreadable to a `fetch`. Kept
   * out of `canPreview` rather than folded into it — that flag means "there is
   * a URL to put in an element", and these have none.
   */
  const isTextual = isTextPageType(file.contentType)
  const isImage = !isOfficeRendition && (file.contentType ?? '').startsWith('image/')
  /** The type of the bytes the well actually shows: the rendition's, for an office file. */
  const shownType = isOfficeRendition ? renditionType : file.contentType
  // The large viewer dialog enlarges PDFs (the same pdf.js viewer) and images
  // (img mode). Offer the expand affordance for both. An office file's
  // rendition is a PDF, and `/file` streams the rendition for it.
  const canExpandPreview = shownType === 'application/pdf' || isImage
  const isFailed = file.status === 'failed'
  /**
   * Held back by the content check (ADR-0086). Not a failure: nothing broke and
   * nothing is retried; someone has to look. So the pane shows what was found
   * and where, and opens the document at the first finding with the office's
   * term marked, as a citation opens at its Fundstelle. Only the uploader and the
   * reviewers can open a held file, and both are meant to see why.
   */
  const isHeld = file.status === 'quarantined'
  const heldVerdict = useMemo(
    () => (isHeld ? quarantineVerdictOf({ quarantine: file.quarantine, errorMessage: file.errorMessage }) : null),
    [isHeld, file.quarantine, file.errorMessage]
  )
  const [shownFinding, setShownFinding] = useState<QuarantineFinding | null>(null)
  useEffect(() => {
    setShownFinding(firstFinding(heldVerdict))
  }, [file.id, heldVerdict])
  const Icon = fileTypeIcon(file.contentType, file.filename)
  const fileFacts = useFileFacts(file)
  const responsibleNames = (file.assignees ?? [])
    .map((person) => person.name || person.email || '')
    .filter(Boolean)
    .join(', ')
  // The document has visual chunks (drawings/images/charts) whose per-page VLM
  // descriptions can be browsed in the "detailed information" section.
  const hasVisualContent = (file.contentTypes ?? []).some((c) => VISUAL_CONTENT_TYPES.includes(c))
  // The ingestion-detected document type (first document-type tag), shown as
  // the indexed panel's Type row. Only real metadata — nothing is inferred here.
  const detectedType = documentTypeOf(file.tags)
  /**
   * Whether the rail's ownership block has anything in it. In the chat peek an
   * ordinary upload has no Piloti byline, no Discuss button (the reader is
   * already in the conversation) and, without collaboration, no assignees:
   * the block was an empty box with a rule under it, heading the Details tab.
   */
  const hasOwnershipBlock =
    file.authoredBy === 'agent' || canCollaborate || Boolean(projectId && !inChat)

  /**
   * The request the well is waiting on, so a newer one can retire it.
   *
   * An office file's rendition takes seconds. Open one, then open another file
   * before it lands, and the first answer arrived last and won: the pane showed
   * document A under document B's name. Every answer is checked against the
   * request that asked for it; a retired one changes nothing.
   */
  const previewRequest = useRef<AbortController | null>(null)
  const loadPreview = useCallback(() => {
    previewRequest.current?.abort()
    const request = new AbortController()
    previewRequest.current = request
    const { signal } = request
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
      fetch(`/api/documents/${file.id}/text`, { signal })
        .then(async (r) => {
          if (r.status === 404) {
            gone = true
            return null
          }
          return r.ok ? await r.json() : null
        })
        .then((data) => {
          if (signal.aborted) return
          if (typeof data?.text === 'string') {
            setPreviewText({ text: data.text, truncated: data.truncated === true })
          } else if (gone) {
            setPreviewGone(true)
          } else {
            setPreviewFailed(true)
          }
        })
        .catch(() => {
          if (signal.aborted) return
          setPreviewText(null)
          setPreviewFailed(true)
        })
        .finally(() => {
          if (!signal.aborted) setIsLoading(false)
        })
      return
    }

    setPreviewText(null)
    if (!canPreview) {
      setPreviewUrl(null)
      return
    }

    setIsLoading(true)
    setRenditionType(null)
    // A local, not the state above: the branch that sets it and the branch that
    // reads it are two links of the same promise chain, and a `useState` value
    // does not change between them.
    let gone = false
    // An office file the BFF will not or could not convert: 415 when
    // conversion is switched off, 502 when the converter failed. Neither is a
    // hiccup a retry fixes, so the pane says what it said before renditions
    // existed — no inline preview — and offers the download of the original.
    let noRendition = false
    fetch(`/api/documents/${file.id}/preview`, { signal })
      .then(async (r) => {
        if (isOfficeRendition && (r.status === 415 || r.status === 502)) {
          noRendition = true
          return null
        }
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
        if (signal.aborted) return
        if (isOfficeRendition && data?.url && data.contentType !== 'application/pdf') {
          noRendition = true
        }
        if (noRendition) {
          setPreviewUrl(null)
          setPreviewImageUrl(null)
        } else if (data?.url) {
          if (isOfficeRendition) setRenditionType(data.contentType)
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
        if (signal.aborted) return
        setPreviewUrl(null)
        setPreviewImageUrl(null)
        setPreviewFailed(true)
      })
      .finally(() => {
        if (!signal.aborted) setIsLoading(false)
      })
  }, [file.id, canPreview, isTextual, isOfficeRendition])

  /**
   * The viewer could not open the bytes the preview route vouched for: the
   * stream refused, the worker failed to load, the file is not a PDF after
   * all. The same failed state the fetch path and the image `onError` use, so
   * the reader gets the caption and the retry, never a blank frame.
   */
  const handlePdfFailed = useCallback(() => {
    setPreviewUrl(null)
    setPreviewImageUrl(null)
    setPreviewFailed(true)
  }, [])
  /**
   * pdf.js is a megabyte of parser plus a worker, and a document open in it
   * holds its page cache. So it mounts only once the well has been on screen,
   * and steps aside while the enlarged dialog shows the same file: one
   * document open at a time, not two copies of one.
   */
  const [wellRef, wellSeen] = useSeenOnce<HTMLDivElement>()
  const showInlinePdf = wellSeen && !isLargePreviewOpen
  /**
   * The well hands its whole area to a viewer that scrolls and zooms itself —
   * pdf.js, the IFC viewport — instead of padding and scrolling it a second
   * time. In the peek that is what lets a PDF's pages sit directly on the
   * stage with their controls floating over them, rather than a bordered
   * scroller boxed inside a padded box.
   */
  const pdfInWell = canPreview && Boolean(previewUrl) && shownType === 'application/pdf'
  const wellHostsViewer = peeking && (isModel || pdfInWell)
  /**
   * The document's Anmerkungen and its room: who else has it open, their
   * pointers, and Piloti's proposals landing. Only where the well IS the PDF
   * viewer (a mark needs a page under it), and never for a held upload, which
   * nobody but its reviewers reads. One instance for the inline preview and
   * the focused review, so the tab is in the room once.
   */
  const reviewEnabled = pdfInWell && showMetadataPanel && !isHeld
  // Where the document stands among its Fassungen under other names, as the
  // reader may see them: the review says it, and lists the open marks of the
  // documents this one replaces to carry them on.
  const replacedBy = file.revision?.supersededBy ?? null
  const replaces = file.revision?.supersedes
  const reviewRevision = useMemo(() => ({ replacedBy, replaces: replaces ?? [] }), [replacedBy, replaces])
  const review = useDocumentReview(file.id, {
    enabled: reviewEnabled,
    viewerUserId,
    revision: reviewRevision,
    // Piloti on the canvas. Over the chat (the pane is its peek) a question is
    // a turn of the chat's own conversation, through its driver, so closing
    // the review finds it in the transcript; elsewhere it goes into the
    // document's own conversation (`use-canvas-ask.ts`).
    piloti: {
      projectId: scope === 'officeShelf' ? null : projectId,
      fileName: file.filename,
      versionState: file.versionState ?? null,
      shelf: 'project',
      chatHosted: inChat,
    },
  })
  const liveMarks = review.annotations.filter(isLive).length
  /**
   * The row behind the pane says what the review says: once the list is read,
   * and whenever a decision changes it, the tally goes to the listing in the
   * shape the server sends (`marks`, `null` with nothing live). „für Sie“ is
   * the review's own „Für Sie“ count (`tabCounts`, `isForReader`). Only a
   * tally the row does not already hold is sent.
   */
  const marksForYou = useMemo(
    () => tabCounts(review.annotations, { on: true, me: review.me }).open,
    [review.annotations, review.me]
  )
  const shownMarks = file.marks ?? null
  useEffect(() => {
    if (!reviewEnabled || review.load !== 'ready' || !onMarksChanged) return
    const { open, proposed } = review.counts
    const tally: MarkTally | null = open + proposed > 0 ? { open, proposed, forYou: marksForYou } : null
    const same =
      tally === null
        ? shownMarks === null
        : shownMarks !== null &&
          shownMarks.open === tally.open &&
          shownMarks.proposed === tally.proposed &&
          shownMarks.forYou === tally.forYou
    if (!same) onMarksChanged(file.id, tally)
  }, [reviewEnabled, review.load, review.counts, marksForYou, shownMarks, onMarksChanged, file.id])
  const [reviewOpen, setReviewOpen] = useState(false)
  /**
   * The inline viewer steps aside while the review is open, as it does for the
   * enlarged dialog: the review is the document full screen, and a second
   * viewer under it rasterised the same pages and redrew the same marks and
   * pointers for nobody to see.
   */
  const inlineViewer = showInlinePdf && !reviewOpen
  /**
   * The page the reader was on in the review: once it closes, the inline
   * viewer (mounted afresh) opens there, not at the first page.
   */
  const reviewPage = useRef<number | null>(null)
  const onReviewPage = useCallback((page: number) => {
    reviewPage.current = page
  }, [])
  const reviewWasOpen = useRef(false)
  useEffect(() => {
    const was = reviewWasOpen.current
    reviewWasOpen.current = reviewOpen
    if (reviewOpen) {
      if (!was) reviewPage.current = null
      return
    }
    const page = reviewPage.current
    reviewPage.current = null
    if (was && page !== null) setShownPage(page)
  }, [reviewOpen])
  const [reviewFocus, setReviewFocus] = useState<{ annotationId: string; key: number } | null>(null)
  /** The tool the review opens with: the point, from „Anmerken". */
  const [reviewTool, setReviewTool] = useState<ReviewLinkTool | null>(null)
  const { setTool: setReviewToolInHand } = review
  /** Open the review's state, at a mark and with a tool when given; the URL is the callers'. */
  const showReview = useCallback(
    (annotationId?: string | null, tool?: ReviewLinkTool | null) => {
      setReviewFocus(annotationId ? { annotationId, key: Date.now() } : null)
      setReviewTool(tool ?? null)
      if (tool) setReviewToolInHand(tool)
      setReviewOpen(true)
    },
    [setReviewToolInHand]
  )
  const router = useRouter()
  const searchParams = useSearchParams()
  const pathname = usePathname()
  /**
   * THE REVIEW HAS AN ADDRESS while it is open: `review=1`, with `mark` and
   * `tool` following the selection and the tool in hand
   * (`lib/open-review.ts`). A reload stays in it, Back leaves it, and a
   * bookmark or a copied link comes back to it. Opening from here pushes, so
   * Back closes; what follows replaces, so walking the marks is one entry.
   * A link this pane did not push is taken off on closing, or, when it came
   * from another page and says so (`back`: Offene Punkte, the Postfach),
   * closing returns there.
   *
   * In the chat the pane is the peek, and `doc` there means „a new chat about
   * this file" (`project-chat-client.tsx`): the review of the peeked document
   * is `review`, `mark` and `tool` alone, and this pane writes no `doc`.
   */
  const reviewLink = readReviewParams(searchParams)
  /** This page's address names this pane's document: Dateien's `doc`, or the chat's peek. Elsewhere the pane writes no address. */
  const addressed = reviewLink.documentId === file.id || (reviewLink.documentId === null && inChat)
  const urlOpen = reviewLink.open && addressed && pdfInWell
  /** This pane pushed the entry the review is on, so closing goes Back to the one before. */
  const pushedReview = useRef(false)
  const urlWasOpen = useRef(false)
  const reviewOpenRef = useRef(reviewOpen)
  useEffect(() => {
    reviewOpenRef.current = reviewOpen
  }, [reviewOpen])
  const replaceParams = useCallback(
    (params: URLSearchParams, how: 'push' | 'replace' = 'replace') => {
      const href = hrefWithParams(pathname ?? '', params)
      if (how === 'push') router.push(href, { scroll: false })
      else router.replace(href, { scroll: false })
    },
    [pathname, router]
  )
  // The address moved: a link arrived (or this pane's push landed), or Back took it away.
  useEffect(() => {
    const was = urlWasOpen.current
    urlWasOpen.current = urlOpen
    if (urlOpen && !was && !reviewOpenRef.current) showReview(reviewLink.annotationId, reviewLink.tool)
    if (!urlOpen && was && reviewOpenRef.current) {
      pushedReview.current = false
      setReviewOpen(false)
      setReviewToolInHand('select')
    }
  }, [urlOpen, reviewLink.annotationId, reviewLink.tool, showReview, setReviewToolInHand])
  /** Open the review from this pane: its state, and its address pushed. */
  const openReview = useCallback(
    (annotationId?: string, tool?: ReviewLinkTool) => {
      showReview(annotationId, tool)
      if (urlOpen || !addressed) return
      const params = setReviewParams(
        new URLSearchParams(searchParams?.toString() ?? ''),
        { documentId: file.id, annotationId, tool },
        { withDocument: false }
      )
      pushedReview.current = true
      replaceParams(params, 'push')
    },
    [showReview, urlOpen, addressed, searchParams, file.id, replaceParams]
  )
  /**
   * What the approve confirm names before the signature: the open marks and
   * Piloti's untaken proposals, told apart, and the review to see them in. Until the review has read them, or when it
   * could not, the confirm says so: an unknown count is not a zero.
   */
  const openMarks = useMemo((): OpenMarksAtApproval | null => {
    if (!reviewEnabled) return null
    const onOpen = () => openReview()
    if (review.load === 'ready') {
      return { status: 'counted', open: review.counts.open, proposed: review.counts.proposed, onOpen }
    }
    return review.load === 'loading' ? { status: 'loading' } : { status: 'unavailable', onOpen }
  }, [reviewEnabled, review.load, review.counts.open, review.counts.proposed, openReview])
  // While open, the address follows the mark selected and the tool in hand.
  const linkTool: ReviewLinkTool | null = review.tool === 'point' || review.tool === 'region' ? review.tool : null
  useEffect(() => {
    if (!reviewOpen || !urlOpen) return
    if (reviewLink.annotationId === review.selectedId && reviewLink.tool === linkTool) return
    // A link's mark waits for the list: the review opens at it once it is read.
    if (review.load !== 'ready' && reviewLink.annotationId && !review.selectedId) return
    replaceParams(
      setReviewParams(
        new URLSearchParams(searchParams?.toString() ?? ''),
        { documentId: file.id, annotationId: review.selectedId, tool: linkTool },
        { withDocument: false }
      )
    )
  }, [reviewOpen, urlOpen, reviewLink.annotationId, reviewLink.tool, review.selectedId, review.load, linkTool, searchParams, file.id, replaceParams])
  const onReviewOpenChange = useCallback(
    (open: boolean) => {
      if (open) return openReview()
      setReviewOpen(false)
      if (!urlOpen) return
      if (pushedReview.current) {
        pushedReview.current = false
        router.back()
        return
      }
      // A link from another page (Offene Punkte, the Postfach) says where it came from: closing goes there.
      // When that page, query and all, is the entry one step back in this tab (`backLandsOn`, read off
      // the tab's own history), Back is the way: a replace would leave the page in history twice, and a
      // sheet over it closes with Back. Otherwise (a new tab, a shared link, a review reached from
      // another review, no Navigation API) the entry behind is not that page, and this one is replaced.
      if (reviewLink.back) {
        if (backLandsOn(reviewLink.back)) router.back()
        else router.replace(reviewLink.back, { scroll: false })
        return
      }
      replaceParams(clearReviewParams(new URLSearchParams(searchParams?.toString() ?? '')))
    },
    [openReview, urlOpen, router, replaceParams, searchParams, reviewLink.back]
  )
  /** The review on its own, in a tab of its own: the document on its shelf, at the review. */
  const popoutHref =
    projectId && scope !== 'officeShelf' && typeof window !== 'undefined'
      ? new URL(reviewFilesHref(projectId, { documentId: file.id }), window.location.origin).toString()
      : undefined
  const { locale } = useLocale()
  // Who is here, read off the room by membership: a pointer moving does not re-render this pane.
  const company = useRoomCompany(review.room)
  const presenceNames = [...company.people.map((person) => person.name), ...(company.piloti ? ['Piloti'] : [])]
  const presenceSentence =
    presenceNames.length > 0
      ? t('annotations.peopleHere', {
          count: presenceNames.length,
          names: new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(presenceNames),
        })
      : null
  /** „Anmerken" in the viewer's pill: the review, with the point in hand. */
  const annotateLead =
    reviewEnabled && review.load === 'ready' && review.canAnnotate && !reader ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <ToolbarTextButton
            className="text-foreground gap-1 px-2 [&_svg]:size-3.5"
            data-testid="inline-annotate"
            onClick={() => openReview(undefined, 'point')}
          >
            <MessageSquarePlus aria-hidden />
            {t('annotations.annotate')}
          </ToolbarTextButton>
        </TooltipTrigger>
        <TooltipContent side="top">{t('annotations.annotateHint')}</TooltipContent>
      </Tooltip>
    ) : undefined
  /**
   * The reader's way onto the marks, at the thumb beside Details: „Anmerken"
   * arms the point; with marks it says how many and opens them.
   */
  const readerAnnotate: ReaderAnnotate | null =
    reviewEnabled && review.load === 'ready' && (review.canAnnotate || liveMarks > 0)
      ? {
          label: liveMarks > 0 ? t('annotations.section') : t('annotations.annotate'),
          count: liveMarks,
          countLabel: t('annotations.readerCount', { count: liveMarks }),
          onClick: () => (liveMarks > 0 ? openReview() : openReview(undefined, 'point')),
        }
      : null

  useEffect(() => {
    loadPreview()
    // A different document (or an unmount) retires whatever was in flight.
    return () => previewRequest.current?.abort()
  }, [loadPreview])

  // Reset the detailed-info section when the selected document changes, so it
  // never shows a previous document's descriptions.
  useEffect(() => {
    setDetails(null)
    setDetailsFailed(false)
    // A turn still in flight belongs to the previous document.
    if (turnFrame.current !== null) cancelAnimationFrame(turnFrame.current)
    turnFrame.current = null
    setShownPage(null)
  }, [file.id])
  useEffect(
    () => () => {
      if (turnFrame.current !== null) cancelAnimationFrame(turnFrame.current)
    },
    [],
  )

  // An answer is about the document AS IT WAS when asked. Opened while it was
  // still being read, the section got an empty list and kept it for good, so
  // the descriptions indexing produced a minute later never appeared without
  // closing the file. What the answer depends on changing — the status, the
  // content types that decide there is anything visual at all — makes it
  // stale, and the effect below asks again.
  const detailsBasis = `${file.status ?? ''}|${(file.contentTypes ?? []).join(',')}`
  useEffect(() => {
    setDetails(null)
    setDetailsFailed(false)
  }, [detailsBasis])

  // Once per basis, and only for a document with visual content: a text-only
  // document has nothing to describe and costs no request. Cancelled on change
  // so a slow answer for the previous document, or basis, never lands.
  useEffect(() => {
    // Nothing to show them in when the metadata panel is off (the peek's
    // Details-less mount, a host that hides the rail): no request either.
    if (!showMetadataPanel || !hasVisualContent || details !== null) return
    let cancelled = false
    setDetailsLoading(true)
    fetch(`/api/documents/${file.id}/visual-details`)
      .then((r) => {
        if (!r.ok) throw new Error(`visual-details ${r.status}`)
        return r.json()
      })
      .then((data) => {
        if (!cancelled) setDetails(Array.isArray(data?.details) ? data.details : [])
      })
      .catch(() => {
        if (cancelled) return
        // An answer, so the effect does not ask again on its own; the retry
        // below is how the reader does.
        setDetails([])
        setDetailsFailed(true)
      })
      .finally(() => {
        if (!cancelled) setDetailsLoading(false)
      })
    return () => {
      cancelled = true
      setDetailsLoading(false)
    }
    // `detailsBasis` too: a change that lands while a request is in flight
    // retires that request rather than letting its older answer stand.
  }, [showMetadataPanel, hasVisualContent, details, file.id, detailsBasis])

  /** Turn the viewer to `page`, from the reading that describes it. */
  const showPage = useCallback((page: number) => {
    setPeekView('document')
    setShownPage('turning')
    if (turnFrame.current !== null) cancelAnimationFrame(turnFrame.current)
    turnFrame.current = requestAnimationFrame(() => {
      turnFrame.current = null
      setShownPage(page)
    })
  }, [])
  const retryDetails = useCallback(() => {
    setDetailsFailed(false)
    setDetails(null)
  }, [])

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
  const handleDeleted = useCallback(
    (fileId: string) => {
      onDeleted?.(fileId)
      onClose?.()
    },
    [onDeleted, onClose]
  )
  // `onDeleted` for the held block's „Löschen", which deletes through this hook.
  const actions = useDocumentActions({ document: file, scope, onReingested, onDeleted: handleDeleted })

  // Re-dispatch a failed document to the ingest pipeline. The request itself
  // lives in `useDocumentActions` with rename/delete/download — one document
  // operation belongs in one place, and the actions MENU offers the same retry
  // now, on the card where the failure is actually read.
  const handleReingest = useCallback(() => void actions.reingest(), [actions])

  // „Im Büro behandelt" for a passage the reader selects: only in a document
  // Piloti has read (an unread one has no passages to compare), opened large
  // with the rail of similar passages beside it.
  const [similarAsk, setSimilarAsk] = useState<SimilarPassagesRequest | null>(null)
  const findSimilar = isCitable(file)
    ? ({ text, page }: { text: string; page: number }) =>
        setSimilarAsk({
          document: { kind: 'stored', documentId: file.id },
          passage: { text, page, cited: false },
          projectId: projectId ?? null,
        })
    : undefined

  return (
    <div className="@container bg-card flex h-full min-h-0 flex-col">
      {/* Peek chrome lives on the host — this header is the modal/expanded one,
          and it is deliberately the SAME six elements on every document.

          It used to be the surface's noticeboard: the name, the byline, the
          type · status line, the assignment faces with their popover, "Piloti
          dazu fragen", "Kollegin fragen", Herunterladen, the actions menu,
          expand and close. Ten things, five of them conditional, in a row that
          had to WRAP on anything narrower than a laptop — so the chrome
          reflowed into two or three lines as you moved between files, and the
          controls that were always there moved to make room for the ones that
          were not. A header that changes shape per document cannot be learned;
          the reader re-reads it every time.

          What is left is what acts on THIS FILE AS A FILE — download it, rename
          or delete it, enlarge it, close it — beside the document's identity:
          its name, and under it the two chips that say WHICH document this is,
          status and category. Every one of those is unconditional (or as good
          as: the menu goes with `canManage`, expand with a previewable format),
          so the shape is the same at every width and the icons never move.
          Everything that DESCRIBES what Piloti made of the document, and
          everything that acts on it, moved to the rail — see the identity block
          there. */}
      {reader && (
        <ReaderHeader
          name={actions.name}
          title={actions.isRenamed ? `${actions.name}\n${file.filename}` : actions.name}
          facts={fileFacts}
          contentType={file.contentType}
          status={
            <>
              {!isCitable(file) && (
                <DocumentStatusBadge status={file.status} queueAhead={file.queueAhead} className="shrink-0" />
              )}
              <DocumentVersionStateBadge
                versionState={file.versionState}
                versionCount={file.versionCount}
                lifecycle={file.lifecycle ?? undefined}
                authoredBy={file.authoredBy}
                className="shrink-0"
                testId="file-preview-lifecycle-badge"
              />
            </>
          }
          closeLabel={t('preview.closePreview')}
          onClose={onClose}
          actions={
            sideways ? (
              <ReaderActions
                layout="header"
                detailsLabel={t('preview.peekViews.details')}
                detailsOpen={detailsOpen}
                onDetails={() => setDetailsOpen(true)}
                annotate={readerAnnotate}
                discuss={
                  projectId && !inChat ? (
                    <DiscussDocumentButton
                      projectId={projectId}
                      documentId={file.id}
                      filename={file.filename}
                      file={file}
                      hint={discussHint}
                      withIcon
                      className="h-9 gap-1.5 pointer-coarse:h-11"
                    />
                  ) : null
                }
                menu={
                  <DocumentActionsMenu
                    document={file}
                    scope={scope}
                    actions={['download', 'rename', 'delete']}
                    canManage={canManage}
                    surface="toolbar"
                    moveInSheet={moveInSheet}
                    onRenamed={onRenamed}
                    onDeleted={handleDeleted}
                  />
                }
              />
            ) : null
          }
        />
      )}
      {!peeking && !reader && (
        <div className="@md:gap-x-3 @md:px-5 flex shrink-0 items-start gap-x-2 border-b px-3.5 pb-3.5 pt-[max(0.875rem,env(safe-area-inset-top))] sm:pt-3.5">
          <FileExtChip filename={file.filename} fallback={<Icon className="size-4" />} />
          {/* The name the document was GIVEN, if it was given one. `title`
            carries it in full for the truncated case — and the file's own name
            underneath it, which is the answer to "which file is this actually"
            for anyone who renamed it. */}
          <div className="min-w-0 flex-1">
            <h3
              className="text-foreground truncate text-sm font-semibold leading-tight tracking-[-0.01em]"
              title={actions.isRenamed ? `${actions.name}\n${file.filename}` : actions.name}
            >
              {actions.name}
            </h3>
            {/* The subheading: what kind of document this is, and — only when
              it matters — that Piloti cannot quote it.

              „Zitierbar" is the case for almost every document in the library,
              so a green badge saying so was a chip that appeared on everything
              and therefore distinguished nothing; a reader scanning the header
              learned only that the app has badges. The states worth a chip are
              the ones that change what the reader can do next: „Wird
              verarbeitet", „Fehlgeschlagen", and „Abgelegt" for a report Piloti
              wrote and deliberately never indexed. In all three the Ask button
              in the rail is grey, and this chip is why. Citable stays silent,
              and the ordinary case has an ordinary header.

              Neither chip is restated in the rail: the Status row and the
              Document type row are gone from Properties, because the same fact
              stated twice on one surface reads as two facts. */}
            {/* `overflow-hidden` on the row and `shrink` on the type badge, and
              both are load-bearing at phone width: `Badge` is `w-fit shrink-0`
              by construction, so `min-w-0` alone never made it narrow — at
              390px „Grundriss" simply ran out of the name column and under the
              Download button beside it. It truncates now instead. The status
              badge keeps `shrink-0` on purpose: „Wird verarbeitet" clipped to
              „Wird ver…" is a state nobody can read, and it is the chip that
              explains why the Ask button in the rail is grey. */}
            <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden">
              {/* What the file is, before any chip: „PDF · 24 Seiten · 4,8 MB",
                the line the chat peek's header already carries. Format and
                size used to be two rows of the rail's Properties list, read
                only by someone who scrolled to them. */}
              {fileFacts && (
                <span
                  className="text-muted-foreground min-w-0 shrink truncate text-xs tabular-nums"
                  // The MIME type a reader cannot parse, for whoever needs it.
                  title={file.contentType ?? undefined}
                  data-testid="file-preview-facts"
                >
                  {fileFacts}
                </span>
              )}
              {!isCitable(file) && (
                <DocumentStatusBadge
                  status={file.status}
                  queueAhead={file.queueAhead}
                  className="shrink-0"
                />
              )}
              {/* WHERE THE DOCUMENT STANDS, at the top with its name.

                „Fassungen und Freigabe" sits in the rail, which is right
                for the machinery and wrong for the one word: whether the office
                stands behind this document is a fact about the document, in the
                class of its name and its type, and a reader should not have to
                scroll a rail to the bottom to learn it.

                It obeys `showsVersionStateBadge` rather than `always`, so it is
                silent on the ordinary upload — one version, born published, a
                person put it there — exactly like the file card's. A chip that
                appeared on every document in the library would distinguish
                nothing, which is the same argument the „Zitierbar" chip lost
                two paragraphs up.

                Restating it on the section's own row at the far end of the rail
                is not the „same fact twice" the Properties rows were: those sat
                in the reader's eyeful directly under this header. These two are
                never on screen together — one names the document, the other
                labels the section you have just opened. */}
              <DocumentVersionStateBadge
                versionState={file.versionState}
                versionCount={file.versionCount}
                lifecycle={file.lifecycle ?? undefined}
                authoredBy={file.authoredBy}
                className="shrink-0"
                testId="file-preview-lifecycle-badge"
              />
              {/* A file of a closed project says which project, and that it is
                  closed (ADR-0090), wherever it is previewed. */}
              {closedProjectName !== null && (
                <ProjectClosedChip projectName={closedProjectName} className="shrink-0" />
              )}
              {/* The well shows a PDF made from this file, not the file. Said
                once, calmly, next to the name, so nobody mistakes the rendition's
                pagination or fonts for the original's; Download beside it still
                hands out the original. */}
              {isOfficeRendition && previewUrl && (
                <Badge
                  variant="outline"
                  className="min-w-0 max-w-full shrink font-normal"
                  data-testid="file-preview-rendition-note"
                  title={t('preview.renditionNote', { name: file.filename })}
                >
                  <span className="truncate">
                    {t('preview.renditionNote', { name: file.filename })}
                  </span>
                </Badge>
              )}
              {showMetadataPanel && detectedType && (
                <Badge variant="secondary" className="min-w-0 max-w-full shrink font-normal">
                  <span className="truncate">{tagLabel(detectedType, t)}</span>
                </Badge>
              )}
            </div>
          </div>
          {/* Who is in the document right now. Following someone is the
            review's; here the faces only tell, and the words say who. */}
          {reviewEnabled && presenceSentence && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="img"
                  tabIndex={0}
                  aria-label={presenceSentence}
                  data-testid="file-preview-presence"
                  className="flex h-8 shrink-0 items-center rounded-full outline-none focus-visible:ring-2"
                >
                  <Presence review={review} />
                </span>
              </TooltipTrigger>
              <TooltipContent>{presenceSentence}</TooltipContent>
            </Tooltip>
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
            surface="toolbar"
            moveInSheet={moveInSheet}
            onRenamed={onRenamed}
            onDeleted={handleDeleted}
          />
          {/* A PDF that carries Anmerkungen opens full screen AS the review,
            with its marks, the room and the tools; the bare enlarged viewer
            showed the same pages without any of them. Images (and a PDF that
            cannot carry marks) keep the enlarged viewer. */}
          {reviewEnabled ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={() => openReview()}
                  aria-label={t('annotations.openReview')}
                  data-testid="file-preview-open-review"
                >
                  <ScanEye className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <span className="block">{t('annotations.openReview')}</span>
                <span className="block opacity-80">{t('annotations.openReviewHint')}</span>
              </TooltipContent>
            </Tooltip>
          ) : canExpandPreview && previewUrl && (
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

      {canExpandPreview && previewUrl && !reviewEnabled && (
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

      <SimilarPassagesDialog
        request={similarAsk}
        source={{ src: documentFileUrl(file.id), fileName: actions.name, title: actions.name }}
        onClose={() => setSimilarAsk(null)}
      />


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
      <PeekTabs
        peeking={peeking}
        value={peekView}
        onValueChange={setPeekView}
        labels={{
          list: t('preview.peekViews.label'),
          document: t('preview.peekViews.document'),
          details: t('preview.peekViews.details'),
        }}
      >
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overscroll-contain',
          peeking || reader ? 'overflow-hidden' : '@2xl:flex-row @2xl:overflow-hidden overflow-y-auto'
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
        <PeekPanel peeking={peeking} value="document">
        <PeekStage peeking={peeking}>
          <div
            ref={wellRef}
            data-testid="file-preview-well"
            className={cn(
              'flex min-w-0 justify-center',
              // A PDF brings its own stage (the viewer's), so the well under it
              // is no ground of its own: the document looks the same here as in
              // every other place a PDF opens.
              !peeking && !pdfInWell && 'from-muted/25 to-muted/60 bg-gradient-to-b',
              wellHostsViewer || (reader && (isModel || pdfInWell))
                ? cn(
                    'h-full min-h-0 flex-1 overflow-hidden',
                    // On its side the reader has no bar below the stage, so the
                    // stage itself stops above the home indicator.
                    reader && sideways && 'pb-[env(safe-area-inset-bottom)]',
                  )
                : reader
                ? // The reader's well for what is not a viewer of its own (an
                  // image, a text page, the page mock): the whole height, one
                  // scroll, the document centred while it is shorter than that.
                  'min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))] [&>*]:my-auto'
                : peeking
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
                  //
                  // The well is also the peek's document SCROLL container. The peek
                  // body above is `overflow-hidden` and a text page only scrolls
                  // horizontally, so a tall document used to clip here with no way
                  // to reach the rest. Bounded by `flex-1 min-h-0` in the peek
                  // column (the summary footer below is capped and shrink-0), in
                  // the same `scroll-fade-bottom` language the summary speaks.
                  // Centring is per-child `my-auto` rather than `items-center` on
                  // purpose: a centred flex container clips the TOP of overflowing
                  // content unreachably, while auto margins collapse to
                  // top-aligned the moment the document outgrows the well — short
                  // docs sit centred, tall ones scroll from the top.
                  'scroll-fade-bottom h-full min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-4 [&>*]:my-auto'
                  : pdfInWell
                    ? '@2xl:h-auto @2xl:min-h-0 @2xl:flex-1 @2xl:p-4 h-[50dvh] min-h-[50dvh] shrink-0 overflow-hidden p-3'
                    : '@2xl:h-auto @2xl:min-h-0 @2xl:flex-1 @2xl:overflow-y-auto @2xl:overscroll-contain @2xl:p-7 h-[50dvh] min-h-[50dvh] shrink-0 overflow-hidden p-5'
            )}
          >
            {isModel ? (
              <IfcFilePreview
                documentId={file.id}
                filename={file.filename}
                projectId={projectId}
                canOpenWorkspace={showModels}
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
              // Converting an office file can take seconds on first open, so the
              // skeleton says what it is waiting for instead of looking stuck.
              <PageMock
                skeleton
                caption={isOfficeRendition ? t('preview.renditionPending') : undefined}
              />
            ) : canPreview && previewUrl ? (
              shownType === 'application/pdf' ? (
                // THE APP'S OWN VIEWER, NOT THE BROWSER'S. A frame on the
                // presigned URL drew nothing on Android Chrome (no inline PDF
                // renderer: a blank box, or a download), little on iOS, and
                // navigated, zoomed and searched unlike the citation viewer
                // beside it. pdf.js renders it the same everywhere, fitted to the
                // well's width with pages rasterised only near the viewport. It
                // FETCHES the bytes, so it reads the same-origin stream, which
                // for an office file streams the rendition (ADR-0070). The
                // preview route above still decides whether there is anything
                // to show; this only decides how it is drawn.
                inlineViewer ? (
                  <PdfDocumentView
                    key={file.id}
                    src={documentFileUrl(file.id)}
                    title={actions.name}
                    page={shownPage === 'turning' ? null : (shownPage ?? shownFinding?.page ?? null)}
                    highlight={shownPage === null ? (shownFinding?.highlight ?? null) : null}
                    onFindSimilar={findSimilar}
                    onLoadError={handlePdfFailed}
                    ground={peeking ? 'host' : 'stage'}
                    bleed={reader}
                    pageOverlay={(page) => (
                      <>
                        <ReviewPageLayer page={page} review={review} focused={false} onOpenMark={openReview} />
                        <InlineMarkPeek page={page} review={review} onOpenMark={openReview} />
                      </>
                    )}
                    toolbarLead={annotateLead}
                    className="size-full"
                  />
                ) : (
                  <PageMock skeleton />
                )
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
                    'bg-background h-fit max-h-full w-auto max-w-full rounded-lg border object-contain',
                    // The reader's well is the screen: the image fits it whole,
                    // on a phone on its side too (852px wide is past `@2xl`).
                    !reader && '@2xl:max-h-none',
                    peeking ? 'shadow-md' : 'shadow-lg'
                  )}
                />
              )
            ) : (
              <PageMock
                kind={kind}
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
        </PeekStage>

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
        {/* Set on the card, not boxed: the stage above is the one framed
            thing in the column, and a bordered card inside a tinted band under
            it was the third frame in 300px. The label and the text are enough
            to make it a section; a capped height keeps a long summary from
            taking the document's place. */}
        {peeking && file.summary && (
          <section
            aria-label={t('preview.indexed.title')}
            data-testid="file-peek-summary"
            className="scroll-fade-bottom max-h-[38%] shrink-0 overflow-y-auto overscroll-contain px-4 pt-3.5 pb-4"
          >
            <SectionLabel as="p" icon={Sparkles} className="font-semibold tracking-[0.05em]">
              {t('preview.indexed.title')}
            </SectionLabel>
            <ClampedText
              key={file.id}
              lines={PEEK_SUMMARY_CLAMP_LINES}
              moreLabel={t('preview.summaryMore')}
              lessLabel={t('preview.summaryLess')}
              className="text-foreground/90 mt-2 text-[13px] leading-[1.6] text-pretty"
            >
              {file.summary}
            </ClampedText>
          </section>
        )}
        </PeekPanel>

        {/* Right: indexed-metadata panel (FB-8; off only in the peek).
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
        <PeekPanel peeking={peeking} value="details">
          <ReaderDetails
            sheet={reader}
            open={detailsOpen}
            onOpenChange={setDetailsOpen}
            title={t('preview.peekViews.details')}
            description={t('preview.dialogLabel', { name: actions.name })}
          >
          <div
            data-testid="file-preview-rail"
            className={
              reader
                ? // In the reader's sheet: the rail's content, on the sheet's
                  // own paper, scrolling with it and clear of the home indicator.
                  'flex flex-col px-4 pt-1 pb-[max(1.25rem,env(safe-area-inset-bottom))]'
                : peeking
                ? // The details view of the peek: the whole column, scrolling
                  // on its own, on the same sunken ground the stage uses.
                  'scroll-fade-bottom bg-surface-sunken border-base mx-3 mb-3 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain rounded-lg border p-4'
                : 'scroll-fade-bottom bg-surface-sunken @2xl:w-[280px] @2xl:shrink-0 @2xl:min-h-0 @2xl:overflow-y-auto @2xl:overscroll-contain @2xl:border-l @2xl:border-t-0 @2xl:pb-4 flex w-full flex-col border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]'
            }
          >
            {/* WHO OWNS THIS DOCUMENT, AND WHAT YOU CAN ASK OF IT.

              The byline, who is responsible and „Piloti dazu fragen" all used
              to sit in the chrome above the document, where they made the row
              wrap and where each was conditional. None of them acts on the
              FILE: they say where the document came from, who is on the hook
              for it, and what the agent can do with it — which is the rail's
              whole subject. The Ask button in particular belongs next to the
              summary that tells the reader whether asking is worth it.

              It leads the rail, above the model facts and the summary, so
              „Verantwortlich" and Ask never need a scroll. In the split layout
              (@2xl+) it is level with the top of the document; stacked, it is
              the first thing under the preview. */}
            {hasOwnershipBlock && (
            <div className="mb-5 space-y-2.5">
              {/* Provenance, not status: the badge is up in the header with
                the name. „Von Piloti erstellt" leads the rail instead, because
                for the one document where it appears it is the reason the Ask
                button below is grey. */}
              <AuthorshipLine authoredBy={file.authoredBy} />
              {/* Responsibility, as one more label/value row so it reads with
                the facts below rather than as chrome. Never merged with the
                byline above: provenance and responsibility are two answers, and
                the design forbids reading them as one. */}
              {canCollaborate && (
                /* A contact row: the face and the NAME, „Verantwortlich" under
                  it. The row used to read „Verantwortlich · MH · Bearbeiten",
                  and initials are a thing to recall, not to recognise; with
                  the label, the name and the control on one 248px line the
                  name was the part that could not fit. */
                <InspectorGroup className="mb-3.5" data-testid="file-preview-responsible">
                  <Item className="gap-2.5 px-3 py-2 hover:bg-transparent">
                    <AssignmentFaces assignees={file.assignees} faceOnly />
                    <ItemContent>
                      <ItemTitle className="text-xs/5">
                        {responsibleNames || t('assignment.unassigned')}
                      </ItemTitle>
                      <ItemDescription className="text-[11px]/4">{t('assignment.responsible')}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <AssignPopover
                        documentId={file.id}
                        assignees={file.assignees ?? []}
                        onChanged={(next) => onAssigneesChanged?.(next)}
                      />
                    </ItemActions>
                  </Item>
                </InspectorGroup>
              )}
              {/* Full width, stacked, in the rail's own column. In the header
                these were two 90px pills competing with four icon controls for
                the same row; here they are the block's conclusion, and the
                reader has just been told whether the document is citable. */}
              {/* „Besprechen" — never conditional on the document being
                citable any more, and that is the whole change.

                This control used to be a PAIR: an enabled „Piloti dazu fragen"
                for a citable file and a greyed-out twin for everything else,
                with a hint explaining the grey. The grey covered exactly the
                documents a reader most wants to talk about — every report Piloti
                wrote, and every version nobody has published — because a turn
                could only reach a document through the retrieval index, and only
                a published version is dispatched to it (ADR-0054). The turn now
                reads an unpublished subject version's own bytes into the
                conversation's working directory, so the reason for the grey is
                gone and the pair collapses into one always-live button.

                What survives is the SENTENCE: `discussHint` still says whether
                this document is in the knowledge base, because that changes what
                the answer will be able to cite — it no longer changes whether the
                conversation can happen. */}
              {projectId && !inChat && !reader && (
                <DiscussDocumentButton
                  projectId={projectId}
                  documentId={file.id}
                  filename={file.filename}
                  file={file}
                  hint={discussHint}
                  withIcon
                  className="w-full gap-1.5"
                />
              )}
              {projectId && canCollaborate && isCitable(file) && (
                <AskColleagueButton projectId={projectId} file={file} documentId={file.id} />
              )}
            </div>
            )}
            {/* The building's own numbers lead the rail: they are what the file
              IS. Ungated by the metadata flag, which covers what INGESTION
              derived — these come out of the IFC itself. Renders nothing until
              a model has actually been read. */}
            {isModel && (
              <IfcFileFacts
                documentId={file.id}
                projectId={projectId}
                className="mb-5"
              />
            )}
            {/* What Piloti made of the document, in its own words.
              Promoted out of the fact list and onto a raised card: it is the
              single most valuable thing on this rail — the answer to "does the
              agent actually understand this file" — and it used to sit as one
              more 12.5px paragraph between an eyebrow and six key/value rows,
              read at the same weight as the MIME type. */}
            {showIndexedHeading && (
              <InspectorSection label={t('preview.indexed.title')} icon={Sparkles}>
                {/* ONE region for one statement. The summary, how much was read
                  and what Piloti took the file to be are a single answer to
                  "does the agent understand this document", and they used to
                  be a card and two loose blocks under it. */}
                <InspectorGroup>
                  {indexedReady ? (
                    <>
                      {/* Keyed by file so a newly-selected document always
                        starts collapsed and re-measures against its own text. */}
                      {file.summary && <IndexedSummary key={file.id} summary={file.summary} />}
                      {/* What Piloti took the document to be, and the way to
                          correct it — see `piloti-reading.tsx` for why this is
                          no longer an always-open tag form. */}
                      <div className={cn('p-3', file.summary && 'border-border/60 border-t')}>
                        <PilotiReading file={file} canManage={canManage} onTagsUpdated={onTagsUpdated} />
                      </div>
                    </>
                  ) : (
                    <p className="text-muted-foreground p-3 text-xs leading-relaxed">
                      {t('preview.indexed.pending')}
                    </p>
                  )}
                </InspectorGroup>
              </InspectorSection>
            )}

            {/* FASSUNGEN UND FREIGABE — one section, right under what Piloti
              made of the document.

              It used to be two: „Fassungen" here (the older documents linked
              under other names) and „Freigabe und Fassungen" at the bottom of
              the rail (this document's own uploads and the approval controls).
              Both were the document's history; neither could be believed alone.
              Now the header says where the document stands, in words, and the
              body is one timeline.

              OUTSIDE the indexed section on purpose: a report Piloti wrote is
              never indexed, and it is exactly the document whose approval is
              the point. The section is shut at rest and opens itself when
              something is asked of this reader (a decision, or Piloti's
              suggestion). Review controls need the reader's lifecycle
              permissions, which only the Files workspace resolves; the Archiv
              sheet and the chat peek show the timeline and the suggestion
              without them. */}
            {revisionsShown && (
              <DocumentRevisions
                key={file.id}
                file={file}
                canManage={canManage}
                viewer={reviewViewer}
                names={assigneeNames}
                onOpenDocument={onOpenDocument}
                onRevisionChanged={onRevisionChanged}
                onLifecycleChanged={(summary) =>
                  onLifecycleChanged?.(file.id, {
                    versionState: summary.state,
                    versionCount: summary.versionCount,
                  })
                }
                openMarks={openMarks}
                className={cn(showIndexedHeading && 'mt-5')}
              />
            )}

            {/* ANMERKUNGEN — how much is open on the pages, and the door into
              the focused review where marks are set and worked. After the
              approval state, before the page readings: what the office found
              on the sheets is work waiting, and the readings are the longest
              list on the rail. */}
            {reviewEnabled && (
              <AnnotationsSummary
                review={review}
                onOpenReview={openReview}
                className={cn((showIndexedHeading || revisionsShown) && 'mt-5')}
              />
            )}

            {/* After the approval state, not before it: whether the office
              stands behind the document outranks what is on sheet 7, and this
              list is the longest thing on the rail. */}
            {showMetadataPanel && hasVisualContent && (
              <PageReadings
                details={details}
                loading={detailsLoading}
                failed={detailsFailed}
                onRetry={retryDetails}
                // Only where the well IS the inline PDF viewer: an image, a
                // PDF whose preview failed or is still loading has no page to
                // turn to, and a link that does nothing is worse than none.
                onShowPage={pdfInWell && showInlinePdf ? showPage : undefined}
                className={cn((showIndexedHeading || revisionsShown) && 'mt-5')}
              />
            )}

            {/* Where the file came from, the one fact about the FILE that has
              no other home. Project, Type, Size and Updated used to be rows
              here: the project is the one the reader is standing in, format
              and size are the line under the name, and the date is on the
              Fassung in „Fassungen und Freigabe". Each was a row the eye had
              to pass on the way to something it came for. */}
            {file.originPath && (
              <InspectorSection
                label={t('preview.properties')}
                icon={Info}
                className="mt-5"
              >
                <InspectorGroup>
                  {/* WHERE THIS FILE CAME FROM, so the reader can go back to it.
                     The alternative on offer was download-and-edit, which makes
                     a duplicate that the office server never hears about and
                     that diverges from the moment it is saved. A path they can
                     copy and paste into Explorer or Finder is the whole
                     feature. Recorded by a folder upload only — a picked file
                     genuinely has no origin path, and the row is absent rather
                     than empty. */}
                  <InspectorRow label={t('preview.originPath')} icon={FolderTree}>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard
                          ?.writeText(file.originPath!)
                          .then(() => toast.success(t('preview.originPathCopied')))
                          .catch(() => toast.error(t('preview.originPathCopyFailed')))
                      }}
                      title={file.originPath}
                      className="hover:text-foreground/80 block max-w-full truncate text-left font-mono font-normal underline-offset-2 hover:underline"
                      data-testid="file-origin-path"
                    >
                      {file.originPath}
                    </button>
                  </InspectorRow>
                </InspectorGroup>
              </InspectorSection>
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
                    <IngestFailureNotice
                      errorMessage={file.errorMessage}
                      sentenceClassName="text-muted-foreground"
                      testId="preview-ingest-failure"
                    />
                    {/* A failed NEW version: the row already points at its
                      bytes, while the ingestor kept the previous version's
                      passages. Without this the two surfaces disagree
                      silently — the download is the new file, the answers
                      quote the old one. */}
                    {failedWithPreviousVersion(file) && (
                      <p className="text-muted-foreground break-words text-xs">
                        {t('preview.ingestionFailedPreviousVersionKept')}
                      </p>
                    )}
                  </div>
                </div>
                {/* A file that failed for a lasting reason would fail the same
                  way again (`lib/documents/retry-policy.ts`): no button that
                  can only repeat the failure, the way out instead. */}
                {file.retryable === false ? (
                  <p className="text-muted-foreground break-words text-xs" data-testid="preview-retry-would-fail-again">
                    {t('preview.retryWouldFailAgain')}
                  </p>
                ) : (
                  canManage && (
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
                  )
                )}
              </div>
            )}

            {isHeld && (
              <div className="mt-4 space-y-2.5 border-t pt-4" data-testid="preview-held">
                <div className="flex items-start gap-2">
                  <ShieldAlert className="text-warning mt-0.5 size-4 shrink-0" aria-hidden />
                  <div className="min-w-0 space-y-2">
                    <p className="text-warning text-sm font-medium">{t('preview.heldTitle')}</p>
                    <QuarantineFindings
                      verdict={heldVerdict}
                      // A page to jump to only where the well is the PDF viewer.
                      onShowFinding={
                        shownType === 'application/pdf'
                          ? (finding) => {
                              // The finding is the page asked for now; a page
                              // reading picked earlier must not mask it.
                              setShownPage(null)
                              setShownFinding(finding)
                            }
                          : undefined
                      }
                      shownFinding={shownFinding}
                      testId="preview-held-findings"
                    />
                    {/* The decision, where the reviewer is looking at the
                        document and the finding, rather than only in the
                        Quarantäne list. The uploader gets the request instead. */}
                    <HeldReview
                      key={file.id}
                      documentId={file.id}
                      scope={scope}
                      actions={actions}
                      onReleased={(status) => onReingested?.(file.id, status)}
                    />
                  </div>
                </div>
              </div>
            )}

            {/* No Delete block here any more. A full-width red button under the
              tags made the most dangerous operation the loudest thing on a
              column whose job is to DESCRIBE the document, and its confirm step
              expanded in place, pushing the rest of the rail down. Both moved
              into the header's actions menu, beside the other controls that act
              on this file. */}

            <div className="flex-1" />
          </div>
          </ReaderDetails>
        </PeekPanel>
      </div>
      </PeekTabs>

      {reader && !sideways && (
        <ReaderActions
          layout="bar"
          detailsLabel={t('preview.peekViews.details')}
          detailsOpen={detailsOpen}
          onDetails={() => setDetailsOpen(true)}
          annotate={readerAnnotate}
          discuss={
            projectId && !inChat ? (
              <DiscussDocumentButton
                projectId={projectId}
                documentId={file.id}
                filename={file.filename}
                file={file}
                hint={discussHint}
                withIcon
                size="default"
                className="h-11 min-w-0 flex-1 gap-1.5"
              />
            ) : null
          }
          menu={
            <DocumentActionsMenu
              document={file}
              scope={scope}
              actions={['download', 'rename', 'delete']}
              canManage={canManage}
              surface="toolbar"
              moveInSheet={moveInSheet}
              side="top"
              onRenamed={onRenamed}
              onDeleted={handleDeleted}
            />
          }
        />
      )}

      {/* No footer page band. It stated the page count a second time, three
          rows below the "Pages" row that already stated it, in a band that cost
          the preview column ~32px of height on every document — the definition
          of a part that could be removed without losing anything. */}

      {pdfInWell && (
        <DocumentReviewMode
          open={reviewOpen}
          onOpenChange={onReviewOpenChange}
          review={review}
          documentName={actions.name}
          revisionLabel={
            file.versionCount && file.versionCount > 1
              ? t('review.revision', { number: file.versionCount })
              : null
          }
          canPickAssignee={canCollaborate}
          focusRequest={reviewFocus}
          popoutHref={popoutHref}
          initialTool={reviewTool ?? undefined}
          onPage={onReviewPage}
          // The Protokoll filed as a document: a project's file, in its own folder. Who may file there
          // (write in that folder) the review knows, and decides (`canAnnotate`).
          protocolFiling={
            projectId && scope !== 'officeShelf' && !closedProjectName ? { projectId, folderId: file.folderId } : null
          }
        />
      )}
    </div>
  )
}

/** Lines of summary shown before it has to ask for the space. */
const SUMMARY_CLAMP_LINES = 5

/**
 * The peek's summary is a footer under the document, not a rail beside it:
 * three lines say what the file is, and the toggle has the rest.
 */
const PEEK_SUMMARY_CLAMP_LINES = 3

type PeekView = 'document' | 'details'

/**
 * The peek's two faces, as tabs. Both panels stay MOUNTED and the inactive
 * one is hidden: switching to Details must not reload a PDF or reset an IFC
 * camera, which is the same reason the host parks the pane rather than
 * unmounting it. Off the peek this renders its children untouched.
 */
function PeekTabs({
  peeking,
  value,
  onValueChange,
  labels,
  children,
}: {
  peeking: boolean
  value: PeekView
  onValueChange: (next: PeekView) => void
  labels: { list: string; document: string; details: string }
  children: ReactNode
}): JSX.Element {
  if (!peeking) return <>{children}</>
  return (
    <Tabs
      value={value}
      onValueChange={(next) => onValueChange(next === 'details' ? 'details' : 'document')}
      className="min-h-0 flex-1 gap-0"
    >
      <TabsList aria-label={labels.list} className="mx-3 mb-2.5 h-8 w-auto shrink-0">
        <TabsTrigger value="document" className="text-xs" data-testid="file-peek-tab-document">
          <FileText aria-hidden className="size-3.5" />
          {labels.document}
        </TabsTrigger>
        <TabsTrigger value="details" className="text-xs" data-testid="file-peek-tab-details">
          <ListTree aria-hidden className="size-3.5" />
          {labels.details}
        </TabsTrigger>
      </TabsList>
      {children}
    </Tabs>
  )
}

function PeekPanel({
  peeking,
  value,
  children,
}: {
  peeking: boolean
  value: PeekView
  children: ReactNode
}): JSX.Element {
  if (!peeking) return <>{children}</>
  return (
    <TabsContent
      value={value}
      forceMount
      className="mt-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"
    >
      {children}
    </TabsContent>
  )
}

/**
 * In the peek the well sits ON a stage — inset from the pane's edges, recessed,
 * with the drawing-paper grid — so the document reads as a sheet laid on a
 * desk. Elsewhere the well is its own ground and needs no frame.
 */
function PeekStage({ peeking, children }: { peeking: boolean; children: ReactNode }): JSX.Element {
  if (!peeking) return <>{children}</>
  return (
    <InsetStage data-testid="file-peek-stage" className="mx-3 flex min-h-0 flex-1 flex-col">
      {children}
    </InsetStage>
  )
}

/**
 * The indexed summary, clamped until asked. It is the first part of the
 * reading group, not a card of its own: the group is the sheet.
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
  return (
    <div className="p-3">
      <ClampedText
        lines={SUMMARY_CLAMP_LINES}
        moreLabel={t('preview.summaryMore')}
        lessLabel={t('preview.summaryLess')}
        className="text-foreground text-sm leading-[1.55]"
      >
        {summary}
      </ClampedText>
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
  kind,
}: {
  caption?: string
  action?: ReactNode
  skeleton?: boolean
  /**
   * What the file IS, when there is no preview to show. The empty state used
   * to be a dashed box with a sentence in it — the same box for a contract, a
   * spreadsheet and a DWG floor plan — so the surface that exists to show a
   * document showed nothing about it at all. The card in the grid behind this
   * modal already draws the document's kind; borrowing that sketch means the
   * reader recognises the file they clicked, and the two surfaces speak one
   * visual language instead of two.
   */
  kind?: DocumentKind
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
        {/* Faint, and never while loading: a skeleton claims content is coming,
            and a line drawing is not that claim. */}
        {!skeleton && kind && (
          <DocumentKindThumbnail kind={kind} className="text-muted-foreground/45 h-16 w-24" />
        )}
        {/* A caption while loading is a statement of what is coming ("PDF
            preview being created"), which a skeleton may make; most loads have
            none and stay bare. */}
        {caption && (
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

/**
 * What this reader can do about a held file, under its findings (ADR-0086).
 *
 * A reviewer allows it or deletes it here, looking at the page the check found
 * it on, with the same question the Quarantäne list asks. The uploader who may
 * not decide asks those who may. Which of the two is the server's answer
 * (`GET /api/documents/{id}/quarantine`), never a role read here; until it
 * lands, and for anyone else, nothing is offered.
 */
function HeldReview({
  documentId,
  scope,
  actions,
  onReleased,
}: {
  documentId: string
  scope: DocumentScope
  /** The pane's document actions: its name, and the delete the menu uses. */
  actions: DocumentActions
  /** The file was allowed and sent to be read, with this status. */
  onReleased: (status: string) => void
}): JSX.Element | null {
  const t = useTranslations('files')
  const tOrg = useTranslations('organization')
  const tc = useTranslations('common')
  const [access, setAccess] = useState<QuarantineReviewAccess | null>(null)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    getQuarantineReviewAccess(documentId, controller.signal)
      .then(setAccess)
      .catch(() => {
        // Not knowing offers nothing: both actions check for themselves anyway.
        if (!controller.signal.aborted) setAccess({ canReview: false, canAskForReview: false })
      })
    return () => controller.abort()
  }, [documentId])

  const release = async (): Promise<void> => {
    try {
      const { status } = await releaseQuarantinedDocument(documentId)
      notifyDocumentsChanged()
      toast.success(tOrg('quarantine.released', { name: actions.name }))
      onReleased(status)
    } catch (error) {
      // Someone else allowed or deleted it first: what was on screen was stale.
      const decided = error instanceof ApiRequestError && (error.status === 409 || error.status === 404)
      if (decided) notifyDocumentsChanged()
      toast.error(decided ? t('preview.heldDecided') : tOrg('quarantine.releaseError'))
    }
  }

  if (access?.canAskForReview) {
    return <RequestReviewButton documentId={documentId} name={actions.name} testId="preview-held-request-review" />
  }
  if (!access?.canReview) return null

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" data-testid="preview-held-review">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setReleaseOpen(true)}
          data-testid="preview-held-release"
        >
          {tOrg('quarantine.release')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setDeleteOpen(true)}
          disabled={actions.isDeleting}
          data-testid="preview-held-delete"
        >
          <Trash2 className="size-4" aria-hidden />
          {tOrg('quarantine.delete')}
        </Button>
      </div>
      <ConfirmDialog
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title={tOrg('quarantine.releaseTitle', { name: actions.name })}
        description={tOrg('quarantine.releaseDescription')}
        confirmLabel={tOrg('quarantine.release')}
        cancelLabel={tc('actions.cancel')}
        tone="warning"
        icon={ShieldOff}
        confirmTestId="preview-held-release-confirm"
        onConfirm={release}
      />
      <DeleteDocumentDialog open={deleteOpen} onOpenChange={setDeleteOpen} scope={scope} actions={actions} />
    </>
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
      // Full width in the rail, beside „Piloti dazu fragen", rather than the
      // ghost pill the popover draws for the Files list. The two Ask affordances
      // are one pair and have to read as one.
      trigger={
        <Button type="button" variant="outline" size="sm" className="h-8 w-full">
          {t('assignment.askColleague')}
        </Button>
      }
    />
  )
}

/**
 * The reader's header on a phone: the document's name across the whole width,
 * cut in the MIDDLE so a revision suffix (`…_1OG_C.pdf`) survives, the facts
 * and the state chips under it, and the close where every full-screen surface
 * on a phone keeps it. Nothing else competes with the name for the row; on a
 * phone on its side the actions join it, because there is no height for a bar.
 */
function ReaderHeader({
  name,
  title,
  facts,
  contentType,
  status,
  actions,
  closeLabel,
  onClose,
}: {
  name: string
  title: string
  facts: string | null
  contentType: string | null | undefined
  status: ReactNode
  actions: ReactNode
  closeLabel: string
  onClose?: () => void
}): JSX.Element {
  return (
    <div
      data-testid="file-reader-header"
      className="bg-card flex shrink-0 items-center gap-2 border-b pt-[max(0.375rem,env(safe-area-inset-top))] pr-[max(0.25rem,env(safe-area-inset-right))] pb-1.5 pl-[max(1rem,env(safe-area-inset-left))]"
    >
      <div className="min-w-0 flex-1 py-1">
        <h3 className="text-foreground flex text-[15px] font-semibold leading-tight tracking-[-0.01em]" title={title}>
          <MiddleTruncate text={name} />
        </h3>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden">
          {facts && (
            <span
              className="text-muted-foreground min-w-0 shrink truncate text-xs tabular-nums"
              title={contentType ?? undefined}
              data-testid="file-preview-facts"
            >
              {facts}
            </span>
          )}
          {status}
        </div>
      </div>
      {actions}
      {onClose && (
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0 rounded-full"
          onClick={onClose}
          aria-label={closeLabel}
          data-testid="file-reader-close"
        >
          <X className="size-5" aria-hidden />
        </Button>
      )}
    </div>
  )
}

/**
 * What acts on the document from the reader: its details, the conversation
 * about it, and the file's own menu (download, rename, delete). One set of controls in two
 * places: a bar at the thumb in portrait, a cluster in the header on its side.
 * The details are a sheet over the document rather than a scroll under it, so
 * the drawing keeps the screen while the reader checks its Fassung.
 */
interface ReaderAnnotate {
  label: string
  /** Live marks; none shows „Anmerken" alone. */
  count: number
  /** The count in words, for a screen reader. */
  countLabel: string
  onClick: () => void
}

function ReaderActions({
  layout,
  detailsLabel,
  detailsOpen,
  onDetails,
  annotate,
  discuss,
  menu,
}: {
  layout: 'bar' | 'header'
  detailsLabel: string
  detailsOpen: boolean
  onDetails: () => void
  /** The document's marks, where it can carry them. */
  annotate: ReaderAnnotate | null
  discuss: ReactNode
  menu: ReactNode
}): JSX.Element {
  const bar = layout === 'bar'
  return (
    <div
      data-testid={bar ? 'file-reader-bar' : 'file-reader-actions'}
      className={cn(
        'flex items-center',
        bar
          ? 'bg-card shrink-0 gap-2 border-t pt-2 pr-[max(0.75rem,env(safe-area-inset-right))] pb-[max(0.5rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))]'
          : 'shrink-0 gap-1',
      )}
    >
      <Button
        type="button"
        variant="outline"
        size={bar ? 'default' : 'sm'}
        className={cn(
          'gap-1.5',
          bar ? 'h-11' : 'h-9 pointer-coarse:h-11',
          bar && annotate && 'max-[27.5rem]:w-11 max-[27.5rem]:px-0',
          bar && !discuss && 'flex-1'
        )}
        aria-expanded={detailsOpen}
        aria-haspopup="dialog"
        onClick={onDetails}
        data-testid="file-reader-details"
      >
        <ListTree className="size-4" aria-hidden />
        {/* Three actions and the menu do not fit a 393px bar in words: the two
            beside „Besprechen" keep their glyphs and give their names to a
            screen reader. */}
        <span className={cn(bar && annotate && 'max-[27.5rem]:sr-only')}>{detailsLabel}</span>
      </Button>
      {annotate && (
        <Button
          type="button"
          variant="outline"
          size={bar ? 'default' : 'sm'}
          className={cn('gap-1.5', bar ? 'h-11 min-w-11 shrink-0 px-3' : 'h-9 pointer-coarse:h-11')}
          // On a narrow bar the words give way to the glyph and the count, so
          // „Besprechen" keeps its label; the name stays for a screen reader.
          aria-label={annotate.count > 0 ? annotate.countLabel : annotate.label}
          onClick={annotate.onClick}
          data-testid="file-reader-annotate"
        >
          {annotate.count > 0 ? <MessageSquareText className="size-4" aria-hidden /> : <MessageSquarePlus className="size-4" aria-hidden />}
          <span className={cn('truncate', bar && 'max-[27.5rem]:sr-only')}>{annotate.label}</span>
          {annotate.count > 0 && <CountPill aria-hidden count={annotate.count} />}
        </Button>
      )}
      {discuss}
      <span className="[&_[data-testid=document-actions-trigger]]:size-11 contents">{menu}</span>
    </div>
  )
}

/**
 * The rail, where it lives: beside or under the document on a wide screen,
 * and in a sheet from the bottom edge in the phone reader, so it is one tap
 * away without ever taking the document's height.
 */
function ReaderDetails({
  sheet,
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  sheet: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  children: ReactNode
}): JSX.Element {
  if (!sheet) return <>{children}</>
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        data-testid="file-reader-details-sheet"
        className="bg-card max-h-[85dvh] gap-0 overflow-y-auto overscroll-contain rounded-t-2xl p-0"
      >
        <SheetHeader className="bg-card sticky top-0 z-[1] px-4 pt-4 pb-2">
          <SheetTitle className="text-base">{title}</SheetTitle>
          <SheetDescription className="sr-only">{description}</SheetDescription>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  )
}
