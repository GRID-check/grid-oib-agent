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
import { inferDocumentKind } from '../document-kind'
import { FileBrowserPane } from './file-browser-pane'
import { FileSearchField } from './file-search-bar'
import { FileFilterStrip, type AssignmentFilter } from './file-filter-strip'
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
   * Whether an `.ifc` opens as a building (WorkOS `ifc-models`, ADR-0046).
   *
   * The model viewer used to be a page of its own behind this flag. It is a
   * file preview now — there is no route left to hide — so the flag decides
   * what a click on a model card DOES: open the viewer, or fall through to the
   * ordinary file preview. Off by default here, because a viewer whose
   * endpoints answer 403 is worse than no viewer.
   */
  showModels?: boolean
  /** Faces, Unvergeben, Zuweisen — behind the collaboration flag. */
  canCollaborate?: boolean
  currentUserId?: string
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
 * A `/api/documents` row as it arrives over the wire — the JSON projection of
 * `listDocuments`. Everything ingestion derives (summary, page/chunk counts,
 * content types, tags) is absent until the backend has produced it, which is
 * why each is normalized to `null` when the response is mapped to `FileItem`.
 */
type DocumentWireRow = Omit<FileItem, OptionalWireField> & Partial<Pick<FileItem, OptionalWireField>>

type OptionalWireField =
  | 'authoredBy'
  | 'displayName'
  | 'folderId'
  | 'errorMessage'
  | 'summary'
  | 'pageCount'
  | 'chunkCount'
  | 'contentTypes'
  | 'tags'
  | 'assignees'

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

export function ProjectFileWorkspace({ projectId, projectName, collectionName, showMetadataPanel = true, showModels = false, canCollaborate = false, currentUserId }: ProjectFileWorkspaceProps) {
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
   */
  const stageModel = showModels ? (searchParams?.get('model')?.trim() ?? null) : null

  const openModel = useCallback(
    (filename: string) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.set('model', filename)
      // `push`, not `replace`. The comment above says the back button closes
      // the stage; with `replace` it pushed no history entry, so back left the
      // Files page entirely and discarded the camera, the cut, the selection,
      // the hidden set and every measurement. On a phone, back is the primary
      // way anyone dismisses a full-screen overlay.
      //
      // Closing still REPLACES, so shutting the stage does not leave an entry
      // that back would re-open.
      router.push(`${pathname ?? ''}?${params.toString()}`, { scroll: false })
    },
    [pathname, router, searchParams]
  )

  /**
   * Close the viewer, and take its whole view with it.
   *
   * Dropping only `model` would leave `element`, `hl`, `storey` and the camera
   * behind as dead parameters on the file browser — and re-opening any model
   * afterwards would inherit a selection from a different building.
   */
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
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [files, setFiles] = useState<FileItem[]>([])
  const [isLoadingFolders, setIsLoadingFolders] = useState(true)
  const [isLoadingFiles, setIsLoadingFiles] = useState(true)
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
  const [agentAuthoredOnly, setAgentAuthoredOnly] = useState(false)

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
        const docs: FileItem[] = (data.documents ?? []).map((d) => ({
          id: d.id,
          filename: d.filename,
          displayName: d.displayName ?? null,
          fileSize: d.fileSize,
          contentType: d.contentType,
          status: d.status,
          folderId: d.folderId ?? null,
          createdAt: d.createdAt,
          errorMessage: d.errorMessage ?? null,
          summary: d.summary ?? null,
          pageCount: d.pageCount ?? null,
          chunkCount: d.chunkCount ?? null,
          contentTypes: d.contentTypes ?? null,
          tags: d.tags ?? null,
          assignees: d.assignees ?? [],
          authoredBy: d.authoredBy ?? 'user',
        }))
        setFiles(docs)
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

  useEffect(() => {
    void loadFolders()
  }, [loadFolders])

  // Fetch files
  useEffect(() => {
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

  const [assignmentFilter, setAssignmentFilter] = useState<AssignmentFilter>('all')

  const docParam = searchParams?.get('doc')

  /** Assignment/authorship filters, over the whole corpus — the search scope. */
  const assignmentFiltered = useMemo(() => {
    if (!canCollaborate || assignmentFilter === 'all') return files
    if (assignmentFilter === 'unassigned') {
      return files.filter((file) => !file.assignees || file.assignees.length === 0)
    }
    return files.filter((file) => file.assignees?.some((person) => person.userId === currentUserId))
  }, [files, canCollaborate, assignmentFilter, currentUserId])

  /**
   * The current LEVEL, Finder-style: the root shows the unfiled documents plus
   * the top-level folder cards; entering a folder shows what is directly in
   * it. When the folder listing itself failed to load, folder scoping would
   * hide every filed document behind an error, so the level falls open to the
   * whole corpus instead.
   */
  const levelFiles = useMemo(() => {
    if (foldersError) return assignmentFiltered
    return assignmentFiltered.filter((file) => (file.folderId ?? null) === selectedFolderId)
  }, [assignmentFiltered, selectedFolderId, foldersError])

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
    const clear = () => {
      setAgentAuthoredOnly(false)
      setAssignmentFilter('all')
    }
    if (agentAuthoredOnly) {
      return {
        title: t('authorship.emptyTitle'),
        description: t('authorship.emptyDescription'),
        onClear: clear,
      }
    }
    if (!canCollaborate || assignmentFilter === 'all') return null
    return {
      title:
        assignmentFilter === 'mine' ? t('assignment.emptyMine') : t('assignment.emptyUnassigned'),
      description: t('assignment.emptyDescription'),
      onClear: clear,
    }
  }, [agentAuthoredOnly, assignmentFilter, canCollaborate, t])

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

  const handleSelectFile = useCallback(
    (id: string | null) => {
      if (id === null) {
        setSelectedFileId(null)
        useFilePreviewStore.getState().close()
        return
      }
      const file = files.find((candidate) => candidate.id === id)
      if (!file) return
      const isModel =
        inferDocumentKind({
          filename: file.filename,
          contentType: file.contentType,
          tags: file.tags,
        }) === 'model'
      if (showModels && isModel) {
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
        onRenamed: handleRenamed,
        onDeleted: handleDeleted,
        onReingested: handleReingested,
        onTagsUpdated: handleTagsUpdated,
      })
    },
    [
      files,
      showModels,
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

  // Drag-and-drop onto the workspace routes dropped files into the SAME upload
  // path the button uses (uploadFiles), which already targets the selected folder
  // via the hook's folderId. Validation/limits stay in uploadFiles; the drag hook
  // only surfaces a supported/unsupported affordance using the shared AppConfig.
  const { isDragging, isUnsupportedDrag, dragHandlers } = useFileDragDrop({
    onDrop: uploadFiles,
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
    [projectId, t, folders, files, selectedFolderId, loadFolders, loadFiles]
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
          <FileFilterStrip
            canCollaborate={!!canCollaborate}
            assignmentFilter={assignmentFilter}
            onAssignmentFilterChange={setAssignmentFilter}
            agentAuthoredOnly={agentAuthoredOnly}
            onAgentAuthoredOnlyChange={setAgentAuthoredOnly}
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
            onUpload={(files) => uploadFiles(files)}
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
              searchFiles={assignmentFiltered}
              selectedFileId={selectedFileId}
              onSelectFile={handleSelectFile}
              isLoading={isLoadingFiles || isLoadingFolders}
              search={search}
              view={view}
              showAssignment={canCollaborate}
              filterEmptyNotice={filterEmptyNotice}
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
                  onUpload={(files) => uploadFiles(files)}
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
                  onUpload={(files) => uploadFiles(files)}
                  isUploading={isUploading}
                  variant="dropcard"
                />
              }
            />
          )}
        </div>

      </div>

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
