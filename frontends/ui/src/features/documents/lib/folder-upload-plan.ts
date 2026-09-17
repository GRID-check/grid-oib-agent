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
 *     bytes under an existing one, nothing at all, a document that is already
 *     here under another name, or a name collision inside the drop that the
 *     project cannot hold ({@link PlannedFile});
 *   - the documents that are already correct but filed in the wrong place, and
 *     have to be MOVED for the tree to be reproduced ({@link PlannedMove});
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
 * What "the same filename" means is `@/lib/documents/name-match`, not `===`.
 * A name off a Mac is decomposed and the same name typed here is composed; they
 * render identically and, compared raw, every file in a re-synced Einreichung
 * comes back `new` under a folder that matched. That module also carries the
 * looser key behind {@link PlannedAction} `duplicate` — the names a document
 * answers to without the server treating them as its identity.
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
import { documentAliasKey, documentNameKey } from '@/lib/documents/name-match'

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
  /**
   * The project already holds this file, but under a DIFFERENT filename — the
   * document was renamed here, or the copy on disk was renamed, or the two
   * names differ only in case.
   *
   * It is not an update, because the server replaces by filename and would
   * insert a second row rather than replace the one that is already there; and
   * calling it new would be the silent duplication this exists to stop. So it
   * is neither: not uploaded, and named in the dialog beside the document it
   * appears to be, for a person to settle.
   */
  | 'duplicate'

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
  /** The document this matched, for `update`, `unchanged` and `duplicate`. */
  existingId?: string
  /**
   * What that document is CALLED on screen — its rename when it has one, its
   * filename otherwise.
   *
   * The plan lists the names in the drop; the corpus shows the names people
   * gave the documents. When somebody has renamed one, those are two different
   * words for one row, and a dialog that only ever says `Deckblatt.pdf` is
   * asking a person to approve replacing a document they cannot find. Set
   * whenever it differs from the dropped file's own name.
   */
  existingName?: string
  /**
   * The folder the matched document is filed in NOW, when that is not where
   * the tree puts it.
   *
   * On an `update` the upload re-files it. On an `unchanged` nothing is
   * uploaded, so the move is made on its own — otherwise "the folder structure
   * is recreated" is false for exactly the documents that are already here,
   * which is most of a re-sync.
   */
  refiledFromFolderId?: string | null
}

/** One document that is already correct but filed in the wrong place. */
export interface PlannedMove {
  documentId: string
  /**
   * Where it belongs, as a path relative to where the reader is standing —
   * NOT a folder id, because the folder may not exist yet.
   *
   * A document at the project root and a drop that files it under a new
   * `Pläne/` is the ordinary case, and the id for `Pläne` does not exist until
   * the applier has created it. Resolved there, from the same
   * `folderIdByPath` the files are resolved through, so a move and an upload
   * into one folder cannot disagree about which folder that is. Empty means
   * the level the reader is standing in.
   */
  targetPath: string
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
  /**
   * The unchanged documents that have to MOVE for the tree to be reproduced,
   * as `{ documentId, folderId }`. Derived here rather than in the applier so
   * the count in the dialog and the requests it sends cannot disagree.
   */
  moves: PlannedMove[]
  counts: FolderUploadCounts
}

export interface FolderUploadCounts {
  new: number
  update: number
  unchanged: number
  collision: number
  duplicate: number
  refiled: number
  foldersCreated: number
  foldersMatched: number
  /** Files that will actually cross the wire, given the current choices. */
  uploading: number
  /**
   * Documents that are already here, unchanged, and filed somewhere other than
   * where the tree puts them. Nothing is uploaded for these; they are moved.
   */
  moving: number
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
   * The corpus, by every name a document answers to.
   *
   * `byName` is IDENTITY — `documentNameKey`, which is the filename in the one
   * Unicode form and nothing else folded. A hit here is the row the server will
   * replace, so it can drive an update.
   *
   * `byAlias` is RECOGNITION — the case-folded key over the filename AND over
   * the rename somebody gave the document. A hit here alone means the project
   * already holds this file under a name the server would NOT replace, so it
   * cannot drive an update; it drives a question. See `@/lib/documents/name-match`.
   * `origin_path` is deliberately NOT among the aliases: its last segment is
   * the filename the row already carries, so it can only ever match what the
   * identity key matched first — and a looser key that adds nothing can still
   * hold back a file somebody meant to upload.
   *
   * Machine-authored rows are excluded from both for the same reason the unique
   * index excludes them (0074): a report Piloti wrote carries a name the model
   * chose and owns no chunks, so a person dropping a file of that name is not
   * correcting it, and the two rows coexist.
   */
  const byName = new Map<string, FileItem>()
  const byAlias = new Map<string, FileItem>()
  for (const document of documents) {
    if (document.authoredBy === 'agent') continue
    const key = documentNameKey(document.filename)
    if (!byName.has(key)) byName.set(key, document)
    for (const alias of [document.filename, document.displayName]) {
      if (!alias) continue
      const aliasKey = documentAliasKey(alias)
      if (!byAlias.has(aliasKey)) byAlias.set(aliasKey, document)
    }
  }

  // Names claimed more than once inside this one drop — compared the way the
  // server compares them, so two spellings of one name are one claim.
  const dropNameCounts = new Map<string, number>()
  for (const entry of entries) {
    const key = documentNameKey(entry.file.name)
    dropNameCounts.set(key, (dropNameCounts.get(key) ?? 0) + 1)
  }

  /** What to call the matched document, when that is not the dropped name. */
  const matchedName = (document: FileItem, droppedName: string): string | undefined => {
    const shown = document.displayName ?? document.filename
    return documentNameKey(shown) === documentNameKey(droppedName) ? undefined : shown
  }

  const hashCandidates: File[] = []
  const moves: PlannedMove[] = []
  const plannedFiles: PlannedFile[] = entries.map(({ file, path }) => {
    const targetPath = relativeDirectory(path)
    /*
     * Where the tree puts this file, as a folder id — `null` when that folder
     * does not exist yet, which is NOT the same as the project root.
     *
     * `refiled` below is what the two are for, and keeping them apart is what
     * makes it right: a folder that has still to be created cannot already
     * hold the document, so anything bound for one is filed wrongly by
     * definition. Reading the unresolved `null` as "the project root" is how a
     * re-file into a new folder went uncounted — and how a move would have sent
     * the document to the root instead of into the folder.
     */
    const targetExists = targetPath ? existingByRelativePath.has(pathKey(targetPath)) : true
    const targetFolderId = targetPath
      ? (existingByRelativePath.get(pathKey(targetPath)) ?? null)
      : (currentFolderId ?? null)
    const base: PlannedFile = { file, originPath: path, targetPath, action: 'new' }
    const nameKey = documentNameKey(file.name)

    if ((dropNameCounts.get(nameKey) ?? 0) > 1) {
      return { ...base, action: 'collision' }
    }

    const existing = byName.get(nameKey)
    if (!existing) {
      // Not the same document to the server — but possibly the same document to
      // the person looking at it. Saying "new" there is how a project ends up
      // holding one file twice under two spellings of its name.
      const alias = byAlias.get(documentAliasKey(file.name))
      if (!alias) return base
      return {
        ...base,
        action: 'duplicate',
        existingId: alias.id,
        existingName: alias.displayName ?? alias.filename,
      }
    }

    const refiled = !targetExists || (existing.folderId ?? null) !== targetFolderId
    const shownAs = matchedName(existing, file.name)

    const sameSize = existing.fileSize === file.size
    const storedDigest = existing.contentHash ?? null

    if (sameSize && storedDigest) {
      const digest = digests?.get(file)
      if (digest === undefined) {
        // Not hashed yet — worth asking about, and an update until we know.
        hashCandidates.push(file)
      } else if (digest === storedDigest) {
        // Nothing to send. But the tree still says where this belongs, and an
        // upload is not the only way to put it there.
        if (refiled) moves.push({ documentId: existing.id, targetPath })
        return {
          ...base,
          action: 'unchanged',
          existingId: existing.id,
          ...(shownAs ? { existingName: shownAs } : {}),
          ...(refiled ? { refiledFromFolderId: existing.folderId ?? null } : {}),
        }
      }
    }

    return {
      ...base,
      action: 'update',
      existingId: existing.id,
      ...(shownAs ? { existingName: shownAs } : {}),
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
    moves,
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
    duplicate: 0,
    refiled: 0,
    foldersCreated: 0,
    foldersMatched: 0,
    uploading: 0,
    moving: 0,
  }
  for (const file of files) {
    counts[file.action] += 1
    // `refiledFromFolderId` is only present when the document really is filed
    // elsewhere, and its value is legitimately null (the project root) — so the
    // test is presence, not truthiness.
    if (file.refiledFromFolderId === undefined) continue
    if (file.action === 'update') counts.refiled += 1
    // An unchanged document sends no bytes, so its re-filing is a move of its
    // own rather than a side effect of the upload. Counted apart for the same
    // reason: the sentence a reader needs is different.
    if (file.action === 'unchanged') counts.moving += 1
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
