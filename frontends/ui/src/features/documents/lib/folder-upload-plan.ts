/**
 * What a dropped folder is about to do to the project — worked out before
 * anything is uploaded.
 *
 * ## The problem
 *
 * A folder upload used to be a flat list of files. Every one of them landed in
 * whichever folder the reader happened to be standing in, its directory
 * structure surviving only as the `origin_path` string on the row; and because
 * a document is identified inside a project by its FILENAME (migration 0074),
 * two `Deckblatt.pdf` from two different subfolders silently became one
 * document, the second overwriting the first. A büro dragging an Einreichung in
 * got a flat pile with an unknown number of files missing from it, and nothing
 * on screen said so.
 *
 * ## What this computes
 *
 * One plan, from the drop and from the listing the reader is already looking
 * at, with no request of its own:
 *
 *   - the folders the tree needs, each MATCHED to one that already exists or
 *     marked for creation ({@link PlannedFolder});
 *   - for every file, what will actually happen to it — a new document, new
 *     bytes under an existing one, nothing at all, or a name collision inside
 *     the drop that the project cannot hold ({@link PlannedFile});
 *   - the counts a person needs to answer "yes, do that".
 *
 * ## Why the file match is by filename and not by folder
 *
 * Because that is the rule the server enforces. `documents` has a unique index
 * on `(organization_id, collection_name, filename)` for human-uploaded rows, the
 * ingest pipeline replaces a file's chunks BY NAME, and the upload path replaces
 * rather than accumulates. A plan that matched per folder would promise two
 * `Deckblatt.pdf` and get one, which is the defect this exists to surface rather
 * than a nicer rule to adopt. So: one filename, one document, project-wide — and
 * a drop carrying the same name twice is reported as such instead of being
 * resolved by whichever upload happened to finish last.
 *
 * ## Two passes, because a digest is asynchronous
 *
 * The first pass classifies everything and names {@link FolderUploadPlan.hashCandidates}
 * — the files whose name AND size already match a document that has a stored
 * digest, which is the only case where "unchanged" is even possible. The caller
 * hashes those (bounded work: it is the plausible-duplicate set, not the drop)
 * and asks again with the answers. Everything else is an upload either way, and
 * reading it to find that out would be work spent to learn nothing.
 */

import type { FileItem, FolderItem } from '../components/project-file-workspace'
import { folderMatchKey, pathSegments } from '@/lib/projects/folders'

/** What will happen to one dropped file. */
export type PlannedAction =
  /** No document of this name exists — it becomes one. */
  | 'new'
  /** A document of this name exists and the bytes differ (or are unknown). */
  | 'update'
  /** A document of this name exists and the bytes are identical. Not uploaded. */
  | 'unchanged'
  /**
   * Another file in this same drop claims the same filename. The project can
   * hold one document under that name, so uploading both would mean one
   * overwriting the other — which is the silent loss this classification exists
   * to prevent. Not uploaded; named in the dialog so the reader can act.
   */
  | 'collision'

export interface PlannedFile {
  file: File
  /** The path it had in the dropped tree — `Wohnbau Nord/03_Einreichung/EG.pdf`. */
  originPath: string
  /**
   * The folder path it lands in, relative to where the reader is standing.
   * Empty means the level they are standing in.
   */
  targetPath: string
  action: PlannedAction
  /** The document it replaces, for `update` and `unchanged`. */
  existingId?: string
  /**
   * Set on an `update` whose existing document is filed somewhere OTHER than
   * where the tree puts it — the upload re-files it, and a person is entitled
   * to know that before it moves under them.
   */
  refiledFromFolderId?: string | null
}

export interface PlannedFolder {
  /** Path relative to where the reader is standing. */
  path: string
  /** The existing folder this matched, or null when it has to be created. */
  existingId: string | null
}

export interface FolderUploadPlan {
  /** The dropped folder's own name, when the drop had a single root. */
  rootName: string | null
  /**
   * Whether the drop's root segment was folded into the folder the reader is
   * standing in, because the two are the same folder by name.
   *
   * This is the re-sync case: somebody opens `Wohnbau Nord` in Piloti and drops
   * `Wohnbau Nord` from the office server onto it. Without the fold they would
   * get `Wohnbau Nord/Wohnbau Nord`, which is nobody's intent — and the second
   * sync would make a third.
   */
  mergedIntoCurrentFolder: boolean
  folders: PlannedFolder[]
  files: PlannedFile[]
  /**
   * Files worth hashing before deciding — same name and same size as a document
   * that already carries a digest. Empty on the second pass.
   */
  hashCandidates: File[]
  counts: FolderUploadCounts
}

export interface FolderUploadCounts {
  new: number
  update: number
  unchanged: number
  collision: number
  refiled: number
  foldersCreated: number
  foldersMatched: number
  /** Files that will actually cross the wire, given the current choices. */
  uploading: number
}

export interface FolderUploadPlanInput {
  files: readonly File[]
  /** The project's corpus, as the browser already has it. */
  documents: readonly FileItem[]
  folders: readonly FolderItem[]
  /** The folder the reader is standing in; null is the project root. */
  currentFolderId: string | null
  /** Digests for {@link FolderUploadPlan.hashCandidates}, on the second pass. */
  digests?: ReadonlyMap<File, string>
}

/** The path a file had in the tree — a folder input reports it, a drop is stamped with it. */
export function droppedPath(file: File): string {
  return file.webkitRelativePath || file.name
}

/**
 * Whether this selection is a folder at all, rather than a handful of picked
 * files.
 *
 * Optional access, not a bare read: the property is guaranteed on a real `File`
 * and is absent on jsdom's, on the object a polyfill hands over, and on
 * anything reconstructed from a drop by a browser that does not implement it.
 * The honest answer in all three cases is "not a folder upload", which is the
 * path that already worked.
 */
export function isFolderUpload(files: readonly File[]): boolean {
  return files.some((file) => (file.webkitRelativePath ?? '').includes('/'))
}

/** Compare two folder paths the way {@link folderMatchKey} compares one segment. */
function pathKey(path: string): string {
  return pathSegments(path).map(folderMatchKey).join('/')
}

export function buildFolderUploadPlan(input: FolderUploadPlanInput): FolderUploadPlan {
  const { files, documents, folders, currentFolderId, digests } = input

  const currentFolder = currentFolderId
    ? (folders.find((folder) => folder.id === currentFolderId) ?? null)
    : null

  const entries = files.map((file) => ({ file, path: droppedPath(file) }))

  /*
   * The re-sync fold.
   *
   * Only when the whole drop shares ONE root directory and that directory is,
   * by name, the folder the reader is standing in. Both conditions matter: a
   * drop of several folders at once has no single root to fold, and folding a
   * root that does not match the current folder would quietly flatten a level
   * the reader can see in their own file manager.
   */
  const rootSegments = new Set(
    entries.map((entry) => pathSegments(entry.path)[0]).filter((segment): segment is string => !!segment),
  )
  const rootName = rootSegments.size === 1 ? [...rootSegments][0] : null
  const mergedIntoCurrentFolder =
    rootName !== null &&
    currentFolder !== null &&
    folderMatchKey(rootName) === folderMatchKey(currentFolder.name) &&
    // A drop of loose files whose "root segment" is the filename itself must
    // not be folded: there is no directory there to merge.
    entries.every((entry) => pathSegments(entry.path).length > 1)

  const relativeDirectory = (path: string): string => {
    const segments = pathSegments(path)
    // The last segment is the file itself.
    const directories = segments.slice(0, -1)
    return (mergedIntoCurrentFolder ? directories.slice(1) : directories).join('/')
  }

  // Existing folders by their path relative to where the reader stands. The
  // stored `path` is absolute from the project root, so the reader's own path
  // is the prefix to strip.
  const basePrefix = currentFolder ? `${pathKey(currentFolder.path)}/` : ''
  const existingByRelativePath = new Map<string, string>()
  for (const folder of folders) {
    const key = pathKey(folder.path)
    if (basePrefix) {
      if (!key.startsWith(basePrefix)) continue
      existingByRelativePath.set(key.slice(basePrefix.length), folder.id)
    } else {
      existingByRelativePath.set(key, folder.id)
    }
  }

  // Every directory the tree needs, ancestors included: `a/b/c` needs `a` and
  // `a/b` to exist before it can, and a tree can name a leaf whose parent holds
  // no files of its own.
  const neededPaths = new Set<string>()
  for (const entry of entries) {
    const directory = relativeDirectory(entry.path)
    if (!directory) continue
    const segments = directory.split('/')
    for (let depth = 1; depth <= segments.length; depth += 1) {
      neededPaths.add(segments.slice(0, depth).join('/'))
    }
  }
  const plannedFolders: PlannedFolder[] = [...neededPaths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({ path, existingId: existingByRelativePath.get(pathKey(path)) ?? null }))

  /*
   * The corpus, by filename — the server's own identity rule.
   *
   * Machine-authored rows are excluded for the same reason the unique index
   * excludes them (0074): a report Piloti wrote carries a name the model chose
   * and owns no chunks, so a person dropping a file of that name is not
   * correcting it, and the two rows coexist.
   */
  const byFilename = new Map<string, FileItem>()
  for (const document of documents) {
    if (document.authoredBy === 'agent') continue
    if (!byFilename.has(document.filename)) byFilename.set(document.filename, document)
  }

  // Names claimed more than once inside this one drop.
  const dropNameCounts = new Map<string, number>()
  for (const entry of entries) {
    dropNameCounts.set(entry.file.name, (dropNameCounts.get(entry.file.name) ?? 0) + 1)
  }

  const hashCandidates: File[] = []
  const plannedFiles: PlannedFile[] = entries.map(({ file, path }) => {
    const targetPath = relativeDirectory(path)
    const base: PlannedFile = { file, originPath: path, targetPath, action: 'new' }

    if ((dropNameCounts.get(file.name) ?? 0) > 1) {
      return { ...base, action: 'collision' }
    }

    const existing = byFilename.get(file.name)
    if (!existing) return base

    const targetFolderId = existingByRelativePath.get(pathKey(targetPath)) ?? null
    const refiled =
      (existing.folderId ?? null) !== (targetPath ? targetFolderId : (currentFolderId ?? null))

    const sameSize = existing.fileSize === file.size
    const storedDigest = existing.contentHash ?? null

    if (sameSize && storedDigest) {
      const digest = digests?.get(file)
      if (digest === undefined) {
        // Not hashed yet — worth asking about, and an update until we know.
        hashCandidates.push(file)
      } else if (digest === storedDigest) {
        return { ...base, action: 'unchanged', existingId: existing.id }
      }
    }

    return {
      ...base,
      action: 'update',
      existingId: existing.id,
      // Only reported when it is true; a re-file the reader cannot see coming
      // is the part of an update that surprises.
      ...(refiled ? { refiledFromFolderId: existing.folderId ?? null } : {}),
    }
  })

  return {
    rootName,
    mergedIntoCurrentFolder,
    folders: plannedFolders,
    files: plannedFiles,
    hashCandidates,
    counts: countPlan(plannedFiles, plannedFolders, true),
  }
}

/**
 * The plan's numbers, for a given answer to "update the changed files?".
 *
 * Recomputed rather than stored, because the dialog's one choice changes what
 * `uploading` means and a count that disagrees with the button is worse than no
 * count.
 */
export function countPlan(
  files: readonly PlannedFile[],
  folders: readonly PlannedFolder[],
  includeUpdates: boolean,
): FolderUploadCounts {
  const counts: FolderUploadCounts = {
    new: 0,
    update: 0,
    unchanged: 0,
    collision: 0,
    refiled: 0,
    foldersCreated: 0,
    foldersMatched: 0,
    uploading: 0,
  }
  for (const file of files) {
    counts[file.action] += 1
    if (file.action === 'update' && file.refiledFromFolderId !== undefined) counts.refiled += 1
  }
  for (const folder of folders) {
    if (folder.existingId === null) counts.foldersCreated += 1
    else counts.foldersMatched += 1
  }
  counts.uploading = counts.new + (includeUpdates ? counts.update : 0)
  return counts
}

/** The files a plan will actually send, given the reader's answer about updates. */
export function filesToUpload(
  plan: FolderUploadPlan,
  includeUpdates: boolean,
): PlannedFile[] {
  return plan.files.filter(
    (file) => file.action === 'new' || (includeUpdates && file.action === 'update'),
  )
}
