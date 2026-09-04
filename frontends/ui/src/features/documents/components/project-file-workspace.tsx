'use client'

import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { AlertCircle, Boxes, FileText, LayoutGrid, List, RotateCcw, X } from 'lucide-react'
import { sourceBase } from '@/lib/ui/source-tint'
import { useProjectDocuments } from '../hooks/use-project-documents'
import { useFileDragDrop } from '../hooks/use-file-drag-drop'
import { useIngestionCompleteToast } from '../hooks/use-ingestion-complete-toast'
import { useSettlingRefresh } from '../hooks/use-settling-refresh'
import { useFileSearch } from '../hooks/use-file-search'
import { toFileItem, type DocumentWireRow } from '../lib/file-item'
import { digestFiles } from '../lib/content-digest'
import {
  buildFolderUploadPlan,
  filesToUpload,
  isFolderUpload,
  type FolderUploadPlan,
} from '../lib/folder-upload-plan'
import { FolderUploadDialog } from './folder-upload-dialog'
import { inferDocumentKind } from '../document-kind'
import { FileBrowserPane } from './file-browser-pane'
import { FileSearchField } from './file-search-bar'
import { FileFilterMenu } from './file-filter-menu'
import {
  NO_FILE_FILTERS,
  applyFileFilters,
  activeFilterCount,
  type FileFilters,
} from '../lib/file-filters'
import { DEFAULT_FILE_SORT, type FileSort } from '../lib/file-sort'
import { DocumentActionsMenu } from './document-actions'
import { useFilePreviewStore } from '../stores/file-preview-store'
import { FileDropOverlay, useWindowDragGuard } from './file-drop-overlay'
import { ProjectUppyUpload } from './project-uppy-upload'
import { UploadTray } from './upload-tray'
import { ProjectSectionActions } from '@/components/shell/project-section-frame'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import type { DocumentAuthor } from '@/lib/db/schema'

interface ProjectFileWorkspaceProps {
  projectId: string
  projectName: string
  collectionName: string
  /**
   * Whether the file preview's ingestion-metadata block renders (WorkOS
   * `files-metadata-panel` flag, FB-8). Threaded to FilePreviewPane. Defaults
   * to true so the feature stays visible with flag enforcement off (fail-open).
   */
  showMetadataPanel?: boolean
  /**
   * Whether the model workspace is reachable (WorkOS `ifc-models`, ADR-0046).
   *
   * The flag has been three things. It hid a `/model` route; then, once the
   * route was folded in here, it decided whether a click on a model card
   * SKIPPED the file preview and went straight to the full-screen stage. That
   * second meaning is what made an `.ifc` the one file type with no preview,
   * and made the same file behave differently in Dateien and in the Archiv.
   *
   * It decides the smallest of the three things now: whether the preview offers
   * the way on. A click always opens the preview, and `?model=` always opens
   * the stage — the flag only gates the affordance between them, which is the
   * shape a flag should have. Off by default here, because a viewer whose
   * endpoints answer 403 is worse than no viewer.
   */
  showModels?: boolean
  /**
   * Whether a click on an `.ifc` opens the preview first (`ifc-preview-first`).
   *
   * Defaults to preview-first, which is the safer direction to be wrong in: a
   * reader who wanted the stage is one button from it inside the preview, while
   * a reader thrown into a full-screen viewport has lost the preview entirely.
   * Threaded from the page alongside the Archiv's copy of the same flag — the
   * two surfaces must move together or the defect this fixes comes back.
   */
  previewFirst?: boolean
  /** Faces, Unvergeben, Zuweisen — behind the collaboration flag. */
  canCollaborate?: boolean
  currentUserId?: string
  /**
   * The folder tree and the corpus as the SERVER already read them, for the
   * first paint.
   *
   * Absent means "ask for them" — which is what every other caller of this
   * component does, and what the page itself did until the two reads moved
   * into it. Present means the first frame is the listing rather than a grid
   * of grey rectangles waiting on three round trips behind the bundle.
   *
   * They seed state; they do not own it. Everything after the first frame — a
   * filter, a settling poll, an upload landing, a retry — goes through the
   * same loaders it always did.
   */
  initialFolders?: readonly FolderItem[]
  initialFiles?: readonly DocumentWireRow[]
}

/**
 * The building, full screen.
 *
 * `dynamic` with `ssr: false` because everything under it reaches for
 * `navigator.gpu` and, one boundary further down, a multi-megabyte WASM
 * geometry kernel. None of that belongs in the bundle of a page that is
 * usually opened to look at PDFs.
 */
const ModelStage = dynamic(
  () => import('@/features/bim/components/model-stage').then((module) => module.ModelStage),
  { ssr: false }
)

export interface FolderItem {
  id: string
  parentId: string | null
  name: string
  path: string
  createdAt?: string
  updatedAt?: string
}

export interface FileItem {
  id: string
  /**
   * The file's own name — its identity, and what its format is read from.
   * What to SHOW is `documentDisplayName(file)`, never this directly.
   */
  filename: string
  /** The rename, when somebody has given the document one; else null. */
  displayName: string | null
  fileSize: number | null
  contentType: string | null
  status: string | null
  folderId: string | null
  /**
   * Where the file sat before it was uploaded, for a folder upload — e.g.
   * `Wohnbau Nord/03_Einreichung/EG.pdf`. Null for a picked file, and null for
   * everything uploaded before this was recorded.
   *
   * NOT `folderId`: that is Piloti's own filing, which somebody here chose and
   * can change. This is a fact about the original, and it is what a person
   * needs in order to go back and work on that original instead of editing a
   * downloaded duplicate.
   */
  originPath?: string | null
  /**
   * A digest of the stored bytes (`sha256:<hex>`), or null when unknown.
   *
   * Read by the folder-upload planner and by nothing else on screen. It is on
   * the row so the plan can be computed from the listing the reader is already
   * looking at, instead of a request per candidate file to discover that
   * nothing needs uploading.
   */
  contentHash?: string | null
  createdAt: string
  /** Server-persisted reason a document is in `failed` status, if any. */
  errorMessage: string | null
  /** One-sentence summary of the document content, if the backend generated one. */
  summary: string | null
  /** Number of pages the backend indexed for this document. */
  pageCount: number | null
  /** Number of retrieval chunks the backend produced for this document. */
  chunkCount: number | null
  /** Content categories present in the document (e.g. text, table, chart, image). */
  contentTypes: string[] | null
  /** Controlled ingestion-generated tags (document type + OIB discipline). */
  tags: string[] | null
  /** Who is on the hook. Empty = Unvergeben. Absent when collaboration is off. */
  assignees?: readonly FileAssignee[]
  /**
   * Whose hand wrote the bytes — `agent` for a report Piloti produced on a
   * commissioned run. PROVENANCE, never responsibility: an agent-authored file
   * has no assignees and its footer says `Unvergeben` like any other unclaimed
   * file. Absent on a listing served before the column existed, which means
   * exactly what the column's default means — a person uploaded it.
   */
  authoredBy?: DocumentAuthor
}

export interface FileAssignee {
  userId: string
  name: string | null
  email: string | null
  profilePictureUrl: string | null
}

/**
 * Presentation of the file browser.
 *
 * `cards` browses, `list` is the explorer detail view for a corpus too large
 * to skim as tiles. Both read the same documents through the same search and
 * the same Finder-style folder drill-down (the tree view is gone — drilling
 * IS the folder navigation now, in both views).
 */
type FileView = 'cards' | 'list'

const VIEW_STORAGE_KEY = 'grid.files.view'

export function ProjectFileWorkspace({ projectId, projectName, collectionName, showMetadataPanel = true, showModels = false, previewFirst = true, canCollaborate = false, currentUserId, initialFolders, initialFiles }: ProjectFileWorkspaceProps) {
  const t = useTranslations('files')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  /**
   * `?model=` is what turns this page into the viewer.
   *
   * In the URL rather than in state, and that is the whole integration: the
   * stage is a view of this page, so it is linkable, the back button closes
   * it, and every `/model?…` link ever written into a chat answer redirects
   * here and opens the same thing. Dateien itself learns exactly one fact —
   * whether that parameter is present.
   *
   * Nothing on this page sets it any more: the preview's own
   * open-in-workspace link is the way in, and it is a real `href` so it opens
   * in a new tab on middle-click. The parameter is still read here because
   * chat answers, the `/model` redirect and a copied URL all arrive through
   * it.
   */
  const stageModel = showModels ? (searchParams?.get('model')?.trim() ?? null) : null

  /**
   * Close the viewer, and take its whole view with it.
   *
   * Dropping only `model` would leave `element`, `hl`, `storey` and the camera
   * behind as dead parameters on the file browser — and re-opening any model
   * afterwards would inherit a selection from a different building.
   */
  /**
   * Straight to the stage, for the flag-off path.
   *
   * `push`, not `replace`: with `replace` the back button left the Files page
   * entirely and discarded the camera, the cut, the selection, the hidden set
   * and every measurement. On a phone, back is the primary way anyone dismisses
   * a full-screen overlay. Closing still REPLACES, so shutting the stage does
   * not leave an entry that back would re-open.
   */
  const openModel = useCallback(
    (filename: string) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.set('model', filename)
      router.push(`${pathname ?? ''}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  const closeModel = useCallback(() => {
    const params = new URLSearchParams(searchParams?.toString() ?? '')
    for (const key of ['model', 'element', 'storey', 'xray', 'tab', 'view', 'cut', 'cutup', 'proj']) {
      params.delete(key)
    }
    params.delete('hl')
    const query = params.toString()
    const path = pathname ?? ''
    router.replace(query ? `${path}?${query}` : path, { scroll: false })
  }, [pathname, router, searchParams])
  // Default to the card grid (the click-dummy). The choice persists per
  // browser (sidebar-collapse pattern). A stored 'tree' — the removed third
  // view — falls back to cards rather than surviving as a dead value.
  const [view, setView] = useState<FileView>('cards')
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY)
    if (stored === 'cards' || stored === 'list') setView(stored)
  }, [])
  const selectView = useCallback((next: FileView) => {
    setView(next)
    if (typeof window !== 'undefined') window.localStorage.setItem(VIEW_STORAGE_KEY, next)
  }, [])
  /**
   * Which folder is open, in the URL rather than in state.
   *
   * It was `useState`, and that made the folder tree the one part of this page
   * the browser did not know about: three folders deep, the back button left
   * Dateien entirely instead of going up one level, a reload dropped the reader
   * at the root, and a folder could not be sent to a colleague at all. Every
   * other view on this page — which model, which storey, which element — has
   * lived in the URL for exactly these reasons; the folder was the exception.
   *
   * `?folder=<id>` and not a path segment: the folder tree is arbitrarily deep
   * and folders are renameable, so a route would need either a catch-all
   * segment resolved by name (ambiguous — two siblings may share a name) or the
   * same id in a prettier place. The id is what the API takes.
   */
  const selectedFolderId = searchParams?.get('folder')?.trim() || null

  /**
   * `push`, so each folder is its own history entry and back means "up one
   * level" — which is the whole point of moving this into the URL. `scroll:
   * false` because the listing replaces itself in place.
   */
  const setSelectedFolderId = useCallback(
    (next: string | null) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      if (next === null) params.delete('folder')
      else params.set('folder', next)
      // Leaving a level closes whatever was open in it: a `doc` from the folder
      // you just left is not in the folder you just entered.
      params.delete('doc')
      const query = params.toString()
      const path = pathname ?? ''
      router.push(query ? `${path}?${query}` : path, { scroll: false })
    },
    [pathname, router, searchParams]
  )
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [folders, setFolders] = useState<FolderItem[]>(() => [...(initialFolders ?? [])])
  const [files, setFiles] = useState<FileItem[]>(() => (initialFiles ?? []).map(toFileItem))
  // Seeded means loaded. Starting these at `true` with the answer already in
  // state would draw the skeleton over a listing this render could paint.
  const [isLoadingFolders, setIsLoadingFolders] = useState(initialFolders === undefined)
  const [isLoadingFiles, setIsLoadingFiles] = useState(initialFiles === undefined)
  const [foldersError, setFoldersError] = useState(false)
  const [filesError, setFilesError] = useState(false)

  /**
   * Only the LATEST request may commit its answer.
   *
   * `useSettlingRefresh` serialises its OWN polls, but nothing coordinated a
   * poll already in flight with a FOREGROUND load (mount, upload settled,
   * `onComplete`, retry). A slow poll response carrying `processing` could
   * therefore land after a newer foreground response carrying `ready` and
   * overwrite it — regressing the badge the user was just told had flipped,
   * and, because the row went back to unsettled, restarting the poll. A
   * monotonic generation stamped when the request goes out and re-checked
   * before every state write makes the newest request the only one that can
   * win, whatever order the responses come back in. The Archiv workspace
   * carries the same guard over its own loader.
   */
  const loadGeneration = useRef(0)

  /**
   * The `Von Piloti` filter, and the one filter on this surface that is asked
   * of the SERVER rather than applied to the loaded listing.
   *
   * Assignment can be filtered here because the assignees ride along on every
   * row. Authorship cannot: it is a column with a partial index
   * (`WHERE authored_by = 'agent'`), the listing is capped at 500 rows, and
   * "everything Piloti wrote" has to be able to find a report that fell off the
   * end of a large corpus. So the chip becomes `?authoredBy=agent` and the
   * effect below re-reads the listing, because `loadFiles` changes identity
   * with it.
   */
  const [filters, setFilters] = useState<FileFilters>(NO_FILE_FILTERS)
  const agentAuthoredOnly = filters.agentAuthoredOnly

  /**
   * Ordering, lifted out of the detail view.
   *
   * `FileListView` used to own this. That made the order a property of ONE of
   * the two views: switching to Kacheln threw away the sort you had chosen, and
   * "which is the newest" was a question only the list could answer. It is a
   * question about the listing, so it is asked here and both views read it —
   * the list's column headers write back to this same state.
   */
  const [sort, setSort] = useState<FileSort>(DEFAULT_FILE_SORT)

  /**
   * @param quiet Refresh without the skeleton — used by the settling poll
   *   below, which would otherwise flash the whole grid every few seconds.
   */
  const loadFiles = useCallback((quiet = false) => {
    const generation = ++loadGeneration.current
    const isStale = () => generation !== loadGeneration.current
    if (!quiet) setIsLoadingFiles(true)
    setFilesError(false)
    const params = new URLSearchParams({ projectId })
    if (agentAuthoredOnly) params.set('authoredBy', 'agent')
    return fetch(`/api/documents?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load documents (${r.status})`)
        return r.json() as Promise<{ documents?: DocumentWireRow[] }>
      })
      .then((data) => {
        if (isStale()) return
        setFiles((data.documents ?? []).map(toFileItem))
      })
      .catch(() => {
        // A failed POLL must not empty a list the user is looking at; only a
        // foreground load owns the error state — and only while it is still the
        // latest one, so a late failure cannot blank a newer successful list.
        if (quiet || isStale()) return
        setFiles([])
        setFilesError(true)
      })
      .finally(() => {
        // Deliberately NOT generation-guarded: the spinner belongs to the
        // foreground loads alone, and a quiet poll starting mid-load would
        // otherwise leave it spinning forever with nobody left to clear it.
        if (!quiet) setIsLoadingFiles(false)
      })
  }, [projectId, agentAuthoredOnly])

  // The query lives here rather than in the browser pane: the field sits in the
  // page header (beside the view toggles and Upload) while the results it
  // filters are rendered below, so the state has to be owned above both.
  const search = useFileSearch({ projectId })

  const { uploadFiles, isUploading, trackedFiles, error, clearError, retryFile, cancelFile, cancelUpload, dismissFiles } =
    useProjectDocuments({
      projectId,
      // The page resolved this server-side; the hook used to fetch it again.
      collectionName,
      folderId: selectedFolderId ?? undefined,
      // Refresh the durable file list once ingestion of an upload completes so
      // new documents appear without a manual reload. Wrapped rather than passed
      // directly: `loadFiles` now takes a `quiet` flag, and whatever the
      // orchestrator hands its callback must not decide how this renders.
      onComplete: () => void loadFiles(),
    })

  // Fetch folders
  const loadFolders = useCallback(() => {
    setIsLoadingFolders(true)
    setFoldersError(false)
    return fetch(`/api/projects/${projectId}/folders`)
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load folders (${r.status})`)
        return r.json()
      })
      .then((data) => setFolders(data.folders ?? []))
      .catch(() => {
        setFolders([])
        setFoldersError(true)
      })
      .finally(() => setIsLoadingFolders(false))
  }, [projectId])

  /**
   * The seeded first render is already the answer, so the mount load is
   * skipped once — and only once.
   *
   * A ref rather than a `hasLoaded` state: this must not re-render, and it
   * must be consumed by the FIRST run of each effect rather than by a
   * condition that could still be true when `loadFiles` changes identity. It
   * changes identity when the „Von Piloti" chip flips, and that is a request
   * for a different listing which has to reach the server.
   */
  const seededFolders = useRef(initialFolders !== undefined)
  const seededFiles = useRef(initialFiles !== undefined)

  useEffect(() => {
    if (seededFolders.current) {
      seededFolders.current = false
      return
    }
    void loadFolders()
  }, [loadFolders])

  // Fetch files
  useEffect(() => {
    if (seededFiles.current) {
      seededFiles.current = false
      return
    }
    void loadFiles()
  }, [loadFiles])

  // Surface upload/validation/network errors that the hook computes: a persistent
  // inline Alert plus a transient toast. Previously these were never rendered.
  const lastToastedError = useRef<string | null>(null)
  useEffect(() => {
    if (error && error !== lastToastedError.current) {
      lastToastedError.current = error
      toast.error(error)
    }
    if (!error) {
      lastToastedError.current = null
    }
  }, [error])

  // Confirm the one moment that matters: the instant a document finishes async
  // ingestion and becomes citable. Provenance-correct — project green + doc icon
  // (spec §4, color never travels alone). Fires once per newly-completed file.
  useIngestionCompleteToast(
    files,
    useCallback(
      (file: FileItem) => {
        // A model earns different words. "Citable" describes what happens to a
        // PDF — its text can be quoted back — and it is the wrong promise for a
        // building, whose whole point is that it can be COUNTED. The user has
        // just waited tens of seconds for an extraction with no visible end;
        // this is where that ends, so it says what is now possible.
        const isModel =
          inferDocumentKind({
            filename: file.filename,
            contentType: file.contentType,
            tags: file.tags,
          }) === 'model'
        toast.success(
          t(isModel ? 'toast.modelReady' : 'toast.ingestionComplete', { name: documentDisplayName(file) }),
          {
            icon: isModel ? (
              <Boxes className="size-4" style={{ color: sourceBase('project') }} aria-hidden />
            ) : (
              <FileText className="size-4" style={{ color: sourceBase('project') }} aria-hidden />
            ),
          }
        )
      },
      [t]
    )
  )

  // Re-ask while anything is still being read, and stop the moment everything
  // is terminal. The Archiv workspace runs the same poll over its own loader —
  // see `useSettlingRefresh` for why a detached `.ifc` extraction needs it.
  useSettlingRefresh(files, loadFiles)

  // Refetch the corpus when an upload batch settles (covers non-orchestrated paths).
  const wasUploading = useRef(false)
  useEffect(() => {
    if (wasUploading.current && !isUploading) {
      void loadFiles()
    }
    wasUploading.current = isUploading
  }, [isUploading, loadFiles])

  const docParam = searchParams?.get('doc')

  /**
   * The filter menu applied to the whole corpus — and therefore the search
   * scope too, so a narrowed listing stays narrowed when you search it.
   *
   * `agentAuthoredOnly` is deliberately absent: it is a query parameter on the
   * listing endpoint (see `loadFiles`), so `files` has already been narrowed by
   * it before this runs.
   */
  const filteredFiles = useMemo(
    () => applyFileFilters(files, filters, { canCollaborate: !!canCollaborate, currentUserId }),
    [files, filters, canCollaborate, currentUserId]
  )

  /**
   * The current LEVEL, Finder-style: the root shows the unfiled documents plus
   * the top-level folder cards; entering a folder shows what is directly in
   * it. When the folder listing itself failed to load, folder scoping would
   * hide every filed document behind an error, so the level falls open to the
   * whole corpus instead.
   */
  const levelFiles = useMemo(() => {
    if (foldersError) return filteredFiles
    return filteredFiles.filter((file) => (file.folderId ?? null) === selectedFolderId)
  }, [filteredFiles, selectedFolderId, foldersError])

  /**
   * When a FILTER emptied the level rather than the folder being empty.
   *
   * The browser pane is handed already-filtered files and cannot tell the two
   * apart, so it drew "this folder is empty" over a folder full of documents
   * the moment a filter matched nothing. „Von Piloti" is the one that cost
   * most: it is the filter whose meaning nobody could infer, and the only
   * place the product could have explained it — the state where it matches
   * nothing — said something false instead.
   *
   * Authorship wins when both are on: it is the narrower and the less obvious
   * of the two, so it is the one a reader needs explained.
   */
  const filterEmptyNotice = useMemo(() => {
    const clear = () => setFilters(NO_FILE_FILTERS)
    if (activeFilterCount(filters, !!canCollaborate) === 0) return null
    // The notice REPLACES the whole listing (the pane renders it before every
    // other branch), so it may only exist when the listing is actually empty —
    // otherwise an active filter blanks the files it just matched. A query or
    // semantic search owns its own empty states, so the notice yields to them.
    if (search.query.trim() !== '' || search.semantic.active) return null
    if (levelFiles.length > 0) return null
    // An unfiltered-empty level is an empty folder, not a filter hiding
    // anything — clearing the filter would still show nothing.
    const levelOccupied = foldersError
      ? files.length > 0
      : files.some((file) => (file.folderId ?? null) === selectedFolderId)
    if (!levelOccupied) return null
    if (filters.agentAuthoredOnly) {
      return {
        title: t('authorship.emptyTitle'),
        description: t('authorship.emptyDescription'),
        onClear: clear,
      }
    }
    if (canCollaborate && filters.assignment !== 'all') {
      return {
        title:
          filters.assignment === 'mine'
            ? t('assignment.emptyMine')
            : t('assignment.emptyUnassigned'),
        description: t('assignment.emptyDescription'),
        onClear: clear,
      }
    }
    // Type and status have no explanation of their own to give — unlike „Von
    // Piloti", whose meaning nobody could infer, these two say what they mean
    // on the chip. What the reader needs is the fact that a filter, and not an
    // empty folder, is why they are looking at nothing.
    return {
      title: t('filters.emptyTitle'),
      description: t('filters.emptyDescription'),
      onClear: clear,
    }
  }, [filters, canCollaborate, t, search.query, search.semantic.active, levelFiles, files, selectedFolderId, foldersError])

  // After a successful re-ingestion the document is back to 'pending'; reflect
  // that locally so the badge flips to "Processing" and the dead-end failure UI
  // clears. Server-side reconciliation resolves the final status on the next read.
  const handleReingested = useCallback((fileId: string, status: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.id === fileId ? { ...f, status, errorMessage: null } : f))
    )
  }, [])

  // After the preview pane successfully saves tags, mirror them into the local
  // files state so the pane's `initialTags` is fresh if the file is reselected
  // (the pane is reused across files and re-seeds from initialTags on switch).
  const handleTagsUpdated = useCallback((fileId: string, tags: string[]) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, tags } : f)))
  }, [])

  // After a document is deleted, drop it from the local corpus and close the
  // preview overlay if it was the selected file.
  const handleDeleted = useCallback((fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId))
    setSelectedFileId((current) => (current === fileId ? null : current))
  }, [])

  // A rename is durable the moment the PATCH returns, so the corpus is updated
  // from the response rather than refetched: the card, the list row and the
  // preview header all read the same `files` state, and they should carry the
  // new name in the same frame the dialog closes.
  const handleRenamed = useCallback((fileId: string, displayName: string | null) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, displayName } : f)))
  }, [])

  /**
   * A move is durable the moment the PATCH returns, so the corpus is updated
   * from the answer rather than refetched — same reasoning as the rename above.
   *
   * The consequence worth noticing: if the reader is INSIDE a folder and moves
   * a document out of it, the row leaves the listing under their cursor. That
   * is the correct outcome (the filter says which folder they are looking at),
   * and the toast names where it went, so the disappearance is explained rather
   * than merely observed.
   */
  const handleMoved = useCallback((fileId: string, folderId: string | null) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, folderId } : f)))
  }, [])

  /**
   * A file dragged onto a folder.
   *
   * The same `PATCH .../folder` the „Verschieben" menu item already used — this
   * adds the gesture, not the capability, which is why it goes through one
   * request rather than a second code path that could disagree with the menu
   * about what a move is.
   *
   * The list is updated optimistically and put back on failure: the card
   * visibly leaves the level under the finger, so leaving it there until a
   * round trip returns would make a successful move look broken and a failed
   * one look successful.
   */
  const handleDropInFolder = useCallback(
    async (documentId: string, folderId: string | null) => {
      const file = files.find((candidate) => candidate.id === documentId)
      if (!file || (file.folderId ?? null) === folderId) return
      const previousFolderId = file.folderId ?? null
      const folderName = folderId
        ? (folders.find((folder) => folder.id === folderId)?.name ?? '')
        : t('folders.allFiles')

      setFiles((prev) => prev.map((f) => (f.id === documentId ? { ...f, folderId } : f)))
      try {
        const res = await fetch(`/api/documents/${documentId}/folder`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderId }),
        })
        if (!res.ok) throw new Error(`Move failed (${res.status})`)
        toast.success(
          t('actions.moved', { name: documentDisplayName(file), folder: folderName })
        )
      } catch {
        setFiles((prev) =>
          prev.map((f) => (f.id === documentId ? { ...f, folderId: previousFolderId } : f))
        )
        toast.error(t('actions.moveError'))
      }
    },
    [files, folders, t]
  )

  /**
   * A folder dragged onto another folder — or onto „Alle Dateien", which is the
   * way back out to the project root.
   *
   * Optimistic on the PARENT and then re-read, which is the same split
   * `handleRenameFolder` makes and for the same reason: `path` is materialised
   * on every row, so moving a folder rewrites the path of everything beneath
   * it. The parent is what decides where the tile is drawn, so changing it here
   * moves the tile in the frame the finger let go; the paths are the server's
   * rule and are read back rather than guessed at.
   *
   * The pane refuses a move into a folder's own subtree before the drop, so the
   * failure this puts back is a network one, not a rejected move.
   */
  const handleDropFolderInFolder = useCallback(
    async (draggedFolderId: string, parentId: string | null) => {
      const folder = folders.find((candidate) => candidate.id === draggedFolderId)
      if (!folder || (folder.parentId ?? null) === parentId) return
      const previousParentId = folder.parentId ?? null
      const parentName = parentId
        ? (folders.find((candidate) => candidate.id === parentId)?.name ?? '')
        : t('folders.allFiles')

      setFolders((prev) =>
        prev.map((f) => (f.id === draggedFolderId ? { ...f, parentId } : f))
      )
      try {
        const res = await fetch(`/api/projects/${projectId}/folders/${draggedFolderId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentId }),
        })
        if (!res.ok) throw new Error(`Move failed (${res.status})`)
        await loadFolders()
        toast.success(t('folders.movedFolder', { name: folder.name, parent: parentName }))
      } catch {
        setFolders((prev) =>
          prev.map((f) => (f.id === draggedFolderId ? { ...f, parentId: previousParentId } : f))
        )
        toast.error(t('folders.moveFolderError'))
      }
    },
    [folders, projectId, loadFolders, t]
  )

  const handleSelectFile = useCallback(
    (id: string | null) => {
      if (id === null) {
        setSelectedFileId(null)
        useFilePreviewStore.getState().close()
        return
      }
      const file = files.find((candidate) => candidate.id === id)
      if (!file) return
      // An `.ifc` opens the way every other file opens — by default.
      //
      // It used to be intercepted here unconditionally and thrown at the
      // full-screen stage, which made the model the ONE file type with no
      // preview, and meant the same file behaved differently depending on which
      // workspace you clicked it in: the Archiv had no stage to jump to, so it
      // showed a preview with no way out.
      //
      // Both halves are fixed, and the choice is now a flag rather than a
      // surface's private opinion. The Archiv runs this identical branch off
      // the identical flag, so the two cannot disagree again.
      if (
        !previewFirst &&
        showModels &&
        inferDocumentKind({
          filename: file.filename,
          contentType: file.contentType,
          tags: file.tags,
        }) === 'model'
      ) {
        openModel(file.filename)
        return
      }
      setSelectedFileId(id)
      useFilePreviewStore.getState().open(file, 'modal', {
        projectId,
        projectName,
        scope: 'files',
        canCollaborate,
        showMetadataPanel,
        showModels,
        onRenamed: handleRenamed,
        onDeleted: handleDeleted,
        onReingested: handleReingested,
        onTagsUpdated: handleTagsUpdated,
      })
    },
    [
      files,
      showModels,
      previewFirst,
      openModel,
      projectId,
      projectName,
      canCollaborate,
      showMetadataPanel,
      handleRenamed,
      handleDeleted,
      handleReingested,
      handleTagsUpdated,
    ],
  )

  useEffect(() => {
    if (!docParam || files.length === 0) return
    if (useFilePreviewStore.getState().file?.id === docParam) return
    if (files.some((file) => file.id === docParam)) {
      handleSelectFile(docParam)
    }
  }, [docParam, files, handleSelectFile])

  // This session's own uploads for this project's corpus — every phase, so the
  // tray can carry a batch all the way from queued to its "added" summary
  // instead of dropping rows out from under the user as they settle. `file`
  // being present is what marks a row as ours: server-loaded documents belong
  // in the browser below, never in the upload tray.
  const activeUploads = useMemo(
    () => trackedFiles.filter((f) => f.collectionName === collectionName && f.file != null),
    [trackedFiles, collectionName]
  )

  /*
   * A FOLDER IS NOT A LONGER LIST OF FILES.
   *
   * Every upload on this page — the button, the folder item in its menu, the
   * dashed tile, a drop onto the workspace — comes through here, and this is
   * where the two gestures part company. A handful of picked files goes
   * straight to `uploadFiles`, exactly as before. A directory tree does not:
   * it carries a structure, it usually overlaps what is already in the project,
   * and applying it silently was costing work.
   *
   * Three things were wrong with the silent path, and the plan answers all
   * three. The tree collapsed into whichever folder the reader stood in. Files
   * whose names already existed replaced live documents with no statement that
   * they would. And two files of one name inside a single drop both uploaded,
   * one overwriting the other, because a project holds one document per
   * filename (migration 0074) — a loss nothing on screen mentioned.
   */
  const [folderPlan, setFolderPlan] = useState<FolderUploadPlan | null>(null)
  const [folderPlanOpen, setFolderPlanOpen] = useState(false)
  const [folderPlanPending, setFolderPlanPending] = useState(false)
  /**
   * The plan's own generation, so a second drop while the first is still being
   * hashed cannot land on top of it. Hashing a folder of models is seconds
   * long, which is ample time to drop another folder.
   */
  const planGeneration = useRef(0)

  const handleUpload = useCallback(
    (incoming: File[]) => {
      if (!isFolderUpload(incoming)) {
        void uploadFiles(incoming)
        return
      }
      const generation = ++planGeneration.current
      setFolderPlan(null)
      setFolderPlanPending(false)
      setFolderPlanOpen(true)
      void (async () => {
        const base = { files: incoming, documents: files, folders, currentFolderId: selectedFolderId }
        // First pass names the plausible duplicates; only those are read into
        // memory. Everything else is an upload either way.
        const first = buildFolderUploadPlan(base)
        const digests = await digestFiles(first.hashCandidates)
        if (generation !== planGeneration.current) return
        setFolderPlan(buildFolderUploadPlan({ ...base, digests }))
      })()
    },
    [uploadFiles, files, folders, selectedFolderId]
  )

  /**
   * Apply the plan: make the folders, then send the files into them.
   *
   * The folders first and in ONE request, because a file cannot be filed into a
   * folder that does not exist yet and forty sequential creates from the browser
   * would be forty chances to end up with half a tree. If that request fails
   * nothing is uploaded at all — a half-applied plan is the state that is hardest
   * to reason about afterwards, and the whole thing is safely repeatable.
   */
  const applyFolderPlan = useCallback(
    async (includeUpdates: boolean) => {
      if (!folderPlan) return
      const selected = filesToUpload(folderPlan, includeUpdates)
      if (selected.length === 0) return
      setFolderPlanPending(true)
      try {
        const paths = folderPlan.folders.map((folder) => folder.path)
        let folderIdByPath: Record<string, string> = {}
        if (paths.length > 0) {
          const res = await fetch(`/api/projects/${projectId}/folders/ensure`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parentId: selectedFolderId, paths }),
          })
          if (!res.ok) throw new Error(`Folders failed (${res.status})`)
          const data = (await res.json()) as { folderIdByPath?: Record<string, string> }
          folderIdByPath = data.folderIdByPath ?? {}
        }

        // Resolved per file rather than per batch — that is the whole point of
        // reproducing the tree. A file at the top of the drop has no path of
        // its own and belongs in the level the reader is standing in.
        const folderIdByFile = new Map<File, string | null>()
        for (const planned of selected) {
          folderIdByFile.set(
            planned.file,
            planned.targetPath ? (folderIdByPath[planned.targetPath] ?? selectedFolderId) : selectedFolderId
          )
        }

        setFolderPlanOpen(false)
        await uploadFiles(
          selected.map((planned) => planned.file),
          { folderIdFor: (file) => folderIdByFile.get(file) ?? null }
        )
        // The tree just grew; the breadcrumb and the folder tiles have to know.
        await loadFolders()
        toast.success(
          t('folderUpload.done', {
            uploaded: String(selected.length),
            skipped: String(folderPlan.counts.unchanged),
          })
        )
      } catch {
        toast.error(t('folderUpload.foldersError'))
      } finally {
        setFolderPlanPending(false)
      }
    },
    [folderPlan, projectId, selectedFolderId, uploadFiles, loadFolders, t]
  )

  // Drag-and-drop onto the workspace routes dropped files into the SAME upload
  // path the button uses, which is `handleUpload` — so a folder DRAGGED in gets
  // the same plan a folder PICKED in the menu does. Validation and limits stay
  // in `uploadFiles`; the drag hook only surfaces a supported/unsupported
  // affordance using the shared AppConfig.
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: handleUpload,
    disabled: isUploading,
  })

  // Guard against the browser navigating away when a file is dropped outside the
  // drop zone (e.g. onto a gap in the layout). Prevent the default open-file
  // behaviour at the window level while this workspace is mounted.
  useWindowDragGuard()

  const handleCreateFolder = useCallback(
    async (name: string, parentId?: string) => {
      const res = await fetch(`/api/projects/${projectId}/folders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId }),
      })
      if (res.ok) {
        const data = await res.json()
        setFolders((prev) => [...prev, data.folder])
      } else {
        toast.error(t('workspace.createFolderError'))
      }
      return res.ok
    },
    [projectId, t]
  )

  const handleRenameFolder = useCallback(
    async (folderId: string, name: string) => {
      const res = await fetch(`/api/projects/${projectId}/folders/${folderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        toast.error(t('workspace.renameFolderError'))
        return false
      }
      const data = await res.json()
      // The rename rewrites the paths of everything underneath it, so the tree
      // is re-read rather than patched in place: a folder three levels down
      // carries the new prefix, and guessing that here would be a second
      // implementation of the server's rule.
      await loadFolders()
      setFolders((prev) => prev.map((f) => (f.id === folderId ? { ...f, ...data.folder } : f)))
      return true
    },
    [projectId, t, loadFolders]
  )

  const handleDeleteFolder = useCallback(
    async (folderId: string) => {
      const folder = folders.find((f) => f.id === folderId)
      if (!folder) return false
      const inside = files.filter((f) => f.folderId === folderId).length
      const nested = folders.filter((f) => f.parentId === folderId).length
      const parentName = folder.parentId
        ? (folders.find((f) => f.id === folder.parentId)?.name ?? t('folders.allFiles'))
        : t('folders.allFiles')

      // NAME WHAT HAPPENS TO THE WORK. A folder is a label somebody put on a
      // set of documents, and the one question in this reader's head is "does
      // this delete my files?" — so the confirm answers it, with the count and
      // with where they will be, instead of the generic "this cannot be
      // undone" that would be both frightening and false.
      const confirmed = window.confirm(
        inside > 0 || nested > 0
          ? t('workspace.deleteFolderConfirmWithContents', {
              name: folder.name,
              documents: String(inside),
              folders: String(nested),
              parent: parentName,
            })
          : t('workspace.deleteFolderConfirm', { name: folder.name })
      )
      if (!confirmed) return false

      const res = await fetch(`/api/projects/${projectId}/folders/${folderId}`, { method: 'DELETE' })
      if (!res.ok) {
        toast.error(t('workspace.deleteFolderError'))
        return false
      }
      const moved = (await res.json().catch(() => ({}))) as {
        documentsMoved?: number
        foldersMoved?: number
      }
      // The selection cannot stay on a folder that no longer exists — it would
      // filter the grid to nothing and read as an empty project.
      if (selectedFolderId === folderId) setSelectedFolderId(folder.parentId ?? null)
      await Promise.all([loadFolders(), loadFiles(true)])
      toast.success(
        moved.documentsMoved
          ? t('workspace.deleteFolderMoved', {
              count: String(moved.documentsMoved),
              parent: parentName,
            })
          : t('workspace.deleteFolderDone', { name: folder.name })
      )
      return true
    },
    [projectId, t, folders, files, selectedFolderId, setSelectedFolderId, loadFolders, loadFiles]
  )

  return (
    <div className="relative flex h-full flex-col" {...dragHandlers} data-testid="workspace-dropzone">
      {/* Drag-and-drop overlay — mirrors the chat FileUploadZone affordance. */}
      {isDragging && (
        <FileDropOverlay
          isUnsupported={isUnsupportedDrag}
          uploadLabel={t('workspace.dropToUpload')}
          unsupportedLabel={t('workspace.dropUnsupported')}
          testId="workspace-drop-overlay"
        />
      )}

      <ProjectSectionActions>
        <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-end gap-2">
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(value) => {
              if (value === 'cards' || value === 'list') selectView(value)
            }}
            segmented
            size="icon-sm"
            aria-label={t('workspace.view.label')}
          >
            <ToggleGroupItem value="cards" aria-label={t('workspace.view.cards')} title={t('workspace.view.cards')}>
              <LayoutGrid />
            </ToggleGroupItem>
            <ToggleGroupItem value="list" aria-label={t('workspace.view.list')} title={t('workspace.view.list')}>
              <List />
            </ToggleGroupItem>
          </ToggleGroup>
          <FileFilterMenu
            canCollaborate={!!canCollaborate}
            filters={filters}
            onFiltersChange={setFilters}
            sort={sort}
            onSortChange={setSort}
            // A ranked result set orders itself; offering a column here would
            // throw the ranking away without saying so.
            sortDisabled={search.semantic.active}
          />
          {/* The corpus search, in the header with the other controls that act
              on the listing — one search on the page, not a band under the one
              it duplicates. */}
          <FileSearchField
            className="w-full sm:w-64 lg:w-72"
            value={search.query}
            onChange={search.setQuery}
            onSubmit={search.run}
            onClear={search.clear}
            placeholder={t('browser.searchPlaceholder')}
            searchLabel={t('browser.searchLabel')}
            resetLabel={t('browser.resetSearch')}
            // No run button: the field reads as the plain filter it mostly is,
            // the way History's does. Enter still commits the query to the
            // semantic search.
          />
          <ProjectUppyUpload
            projectId={projectId}
            folderId={selectedFolderId}
            onUpload={handleUpload}
            isUploading={isUploading}
            // The durable corpus is where a büro brings a whole project in.
            allowFolders
          />
        </div>
      </ProjectSectionActions>

      {/* Error banner */}
      {error && (
        <div className="border-b px-4 py-3 animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none">
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>{t('workspace.uploadProblem')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-2 top-2 size-6"
              onClick={clearError}
              aria-label={t('workspace.dismissError')}
            >
              <X className="size-4" />
            </Button>
          </Alert>
        </div>
      )}

      {/* Live upload progress */}
      <UploadTray
        files={activeUploads}
        onRetry={retryFile}
        onCancel={cancelFile}
        onCancelAll={cancelUpload}
        onDismiss={dismissFiles}
      />

      {/* The browser owns the whole column now (the tree band is gone); the
          preview opens as a full-screen overlay. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Folder listing failed: say so once, above a browser that falls open
            to the whole corpus, instead of hiding every filed document. */}
        {foldersError && (
          <div className="border-b px-4 py-2">
            <PaneLoadError message={t('workspace.foldersLoadError')} onRetry={loadFolders} inline />
          </div>
        )}

        {/* File browser */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {filesError ? (
            <PaneLoadError message={t('workspace.documentsLoadError')} onRetry={loadFiles} />
          ) : (
            <FileBrowserPane
              files={levelFiles}
              searchFiles={filteredFiles}
              selectedFileId={selectedFileId}
              onSelectFile={handleSelectFile}
              isLoading={isLoadingFiles || isLoadingFolders}
              search={search}
              view={view}
              sort={sort}
              onSortChange={setSort}
              showAssignment={canCollaborate}
              filterEmptyNotice={filterEmptyNotice}
              onDropDocumentInFolder={handleDropInFolder}
              onDropFolderInFolder={handleDropFolderInFolder}
              renderActions={(file) => (
                <DocumentActionsMenu
                  document={file}
                  scope="files"
                  folders={folders}
                  onRenamed={handleRenamed}
                  onDeleted={handleDeleted}
                  onMoved={handleMoved}
                />
              )}
              {...(foldersError
                ? {}
                : {
                    folderNav: {
                      folders,
                      currentFolderId: selectedFolderId,
                      onNavigate: setSelectedFolderId,
                      onCreateFolder: handleCreateFolder,
                      onRenameFolder: handleRenameFolder,
                      onDeleteFolder: handleDeleteFolder,
                    },
                  })}
              uploadControl={
                <ProjectUppyUpload
                  projectId={projectId}
                  folderId={selectedFolderId}
                  onUpload={handleUpload}
                  isUploading={isUploading}
                  variant="default"
                  size="default"
                  label={t('workspace.uploadDocuments')}
                />
              }
              uploadCard={
                <ProjectUppyUpload
                  projectId={projectId}
                  folderId={selectedFolderId}
                  onUpload={handleUpload}
                  isUploading={isUploading}
                  variant="dropcard"
                />
              }
            />
          )}
        </div>

      </div>

      {/* „Wollen Sie aktualisieren?" — the plan a dropped folder opens, before
          anything moves. Rendered unconditionally so its own exit transition
          runs; `open` is what decides. */}
      <FolderUploadDialog
        open={folderPlanOpen}
        onOpenChange={setFolderPlanOpen}
        plan={folderPlan}
        currentFolderName={
          selectedFolderId
            ? (folders.find((folder) => folder.id === selectedFolderId)?.name ?? null)
            : null
        }
        onConfirm={applyFolderPlan}
        pending={folderPlanPending}
      />

      {/*
        The model, when the URL names one. Full screen inside a popup — the
        page it opened from is still visible at the edges, which is what makes
        closing it feel like closing a preview rather than navigating back.
      */}
      {stageModel && (
        <ModelStage
          projectId={projectId}
          onClose={closeModel}
          // The viewport carries the same file operations as every other
          // document surface, so its renames and deletions have to land in this
          // page's corpus — otherwise closing the stage reveals a grid still
          // showing the old name, or a card for a building that is gone.
          onModelRenamed={handleRenamed}
          onModelDeleted={handleDeleted}
          canCollaborate={canCollaborate}
        />
      )}

    </div>
  )
}

/** Inline pane-level load failure with a retry affordance. */
function PaneLoadError({
  message,
  onRetry,
  inline = false,
}: {
  message: string
  onRetry: () => void
  /** One-row banner variant, for a failure that degrades a pane without emptying it. */
  inline?: boolean
}) {
  const t = useTranslations('files')
  if (inline) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <AlertCircle className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{message}</span>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onRetry}>
          <RotateCcw className="size-3.5" aria-hidden />
          {t('workspace.tryAgain')}
        </Button>
      </div>
    )
  }
  return (
    <EmptyState
      variant="bare"
      icon={AlertCircle}
      title={message}
      action={
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onRetry}>
          <RotateCcw className="size-3.5" aria-hidden />
          {t('workspace.tryAgain')}
        </Button>
      }
    />
  )
}
