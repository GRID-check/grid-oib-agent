/**
 * What one shelf of documents IS, as data.
 *
 * Dateien (a project's documents) and the Archiv (the office's) are the same
 * workspace over two stores: same folders, same upload plan, same drag and
 * move, same search, same filters. They used to be two components, and the
 * Archiv spent a release flat and without folders because every capability
 * had to be built twice. A shelf is the part that is genuinely different,
 * named once and handed to {@link FileWorkspace}; anything not in this type is
 * not allowed to differ.
 */

import type { ReactNode } from 'react'
import type { DocumentScope } from '../components/document-actions'
import type { FileItem } from '../file-types'
import type { UploadFilesOptions } from '../hooks/use-file-upload'
import type { DocumentNameMatch, RevisionCandidateMatch } from '@/lib/documents/name-probe-types'
import type { DocumentLifecyclePermission } from '@/lib/documents/lifecycle-types'
import type { TrackedFile } from '../types'

/** What the shared workspace needs from whichever upload hook a shelf uses. */
export interface ShelfUploadApi {
  uploadFiles: (files: File[], options?: UploadFilesOptions) => Promise<number>
  isUploading: boolean
  trackedFiles: TrackedFile[]
  error: string | null
  clearError: () => void
  retryFile: (fileId: string) => Promise<void>
  cancelFile: (fileId: string) => void
  cancelUpload: () => void
  dismissFiles: (fileIds: string[]) => void
}

export interface ShelfUploadInput {
  /** The shelf's collection: from the descriptor when it has one, else the listing's. */
  collectionName: string | undefined
  /** The folder the reader is standing in. */
  folderId: string | undefined
  /** Stable and quiet — refresh the listing without a skeleton. */
  onComplete: () => void
}

/** Where a shelf's rows and folders live, and how a search is addressed. */
export interface ShelfEndpoints {
  /** The listing, without its query string (`/api/documents`). */
  list: string
  /** Fixed query parameters of the listing: the shelf (`projectId`, or `scope`). */
  listParams?: Record<string, string>
  /** The folder collection; `/ensure` and `/{id}` hang off it. */
  folders: string
  /** The semantic search route and the fixed body fields it takes. */
  search: string
  searchBody?: Record<string, unknown>
}

/** A project shelf's per-role folder access (ADR-0088). */
export interface ShelfFolderAccess {
  /** The project the access dialog writes to. */
  projectId: string
  /**
   * Whether this reader may change who reads and writes a folder
   * (`project:manage`, resolved on the server). Shows „Zugriff…" in the folder
   * menu; the route checks again.
   */
  canManage: boolean
  /**
   * What the reader may do at the shelf's root, as the server read it for the
   * first paint. The folder listing refreshes it.
   */
  initialRootAccess: FolderAccessLevel
}

export type FolderAccessLevel = 'read' | 'write'

export interface FileShelf {
  /** Which provenance colour and icon the shelf wears (`--source-*`). */
  source: 'project' | 'office'
  /** Namespace of the sentences that name this shelf (rename, delete, move). */
  documentScope: DocumentScope
  endpoints: ShelfEndpoints
  /** The project this shelf belongs to; `null` for the office-wide Archiv. */
  projectId: string | null
  /** The collection, when the page already knows it; else the listing says. */
  collectionName?: string
  /**
   * Whether the viewer may change anything: upload, drag, create/rename/delete
   * and move folders, rename/delete documents. False is the read-only view —
   * list, folders, search, filters, preview and download.
   */
  canManage: boolean
  /**
   * Who may read and write each folder, per WorkOS role (ADR-0088). A project's
   * shelf only: the Archiv's folders are governed by `canManage` alone, so it
   * leaves this out and shows no lock, no „Nur lesen" and no „Zugriff…".
   */
  folderAccess?: ShelfFolderAccess
  /**
   * The shelf's Papierkorb, a project's only (ADR-0088): deleting a folder
   * moves it there with its subfolders and documents, the toast links to it,
   * and the header carries a way in. Without it (the Archiv) deleting a folder
   * re-files its contents into the parent and removes the folder.
   */
  bin?: { href: string }
  /**
   * The shelf's Offene Punkte, a project's only: the open Anmerkungen of all
   * its documents on one page, for the Jour fixe, reached from the header.
   */
  openPoints?: { href: string }
  /**
   * The project's E-Mail-Eingang (ADR-0134), for a reader who may decide its
   * mail: the header entry with its count, the quiet line above the shelf,
   * and „Per E-Mail senden …“ in the upload menu, which opens the address.
   */
  inboundMail?: { href: string; waiting: number | null; more: boolean; openAddress: () => void }
  /** Faces, „Unvergeben", the assignment filter (the collaboration flag). */
  canCollaborate: boolean
  currentUserId?: string
  /** Opens a chat about one file. Only a project has a chat to open it in. */
  askAbout?: (file: FileItem) => void
  /** The shelf's own upload engine (`useProjectDocuments`, `useOfficeShelfDocuments`). */
  useUpload: (input: ShelfUploadInput) => ShelfUploadApi
  /** Which of the shelf's documents already carry these names (upload plan). */
  probeNames: (names: readonly string[]) => Promise<DocumentNameMatch[]>
  /** Which of the shelf's documents these names would be the next Fassung of (upload plan, ADR-0099). */
  probeRevisions: (names: readonly string[], landsIn: ReadonlyMap<string, string | null>) => Promise<RevisionCandidateMatch[]>
  /** Where a drop made elsewhere in the app waits for this shelf (project only). */
  handoverKey?: string
  /**
   * How the preview is held. `store` is the shell-level preview a chat can also
   * drive (a project's shell mounts its host); `dialog` is local to the page,
   * for a surface no host is mounted on (the Archiv sheet).
   */
  preview: { kind: 'dialog' } | { kind: 'store'; projectName: string }
  /** Per-card provenance chip and footer — the Büroablage's gold kind label. */
  cardExtras?: (file: FileItem) => CardExtras
  messages: {
    dropToUpload: string
    ingestionComplete: (name: string) => string
  }
  /** Whether the preview offers the model workspace (`ifc-models`). */
  showModels: boolean
  lifecyclePermissions?: readonly DocumentLifecyclePermission[]
}

export interface CardExtras {
  source?: 'project' | 'office' | null
  sourceLabel?: string
  footerLead?: ReactNode
}

/** The semantic search scope of a project's shelf. */
export function projectSearchScope(projectId: string): Pick<ShelfEndpoints, 'search' | 'searchBody'> {
  return { search: '/api/documents/search', searchBody: { projectId } }
}

/** The semantic search scope of the office Archiv. */
export const OFFICE_SHELF_SEARCH_SCOPE: Pick<ShelfEndpoints, 'search' | 'searchBody'> = {
  search: '/api/documents/search',
  searchBody: { scope: 'office_shelf' },
}

export function projectEndpoints(projectId: string): ShelfEndpoints {
  return {
    list: '/api/documents',
    listParams: { projectId },
    folders: `/api/projects/${projectId}/folders`,
    ...projectSearchScope(projectId),
  }
}

export const OFFICE_SHELF_ENDPOINTS: ShelfEndpoints = {
  list: '/api/documents',
  listParams: { scope: 'office_shelf' },
  folders: '/api/office-shelf/folders',
  ...OFFICE_SHELF_SEARCH_SCOPE,
}
