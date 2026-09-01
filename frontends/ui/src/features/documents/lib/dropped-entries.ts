/**
 * Reading a DROPPED FOLDER, which `dataTransfer.files` cannot see.
 *
 * A drop handler that reads `dataTransfer.files` gets an empty list for a
 * folder — the browser reports directories only through the entries API, and
 * only synchronously, from the drop event itself. So dragging a project folder
 * onto the file area did nothing at all, silently: the overlay appeared, the
 * finger let go, and the page carried on as though nothing had happened.
 *
 * The traversal is breadth-first with three bounds, because a dropped folder is
 * whatever was on somebody's desktop: a file ceiling, a depth ceiling, and a
 * wall clock. Each is reported rather than enforced quietly — a bulk upload
 * that silently took the first 500 of 900 files is worse than one that refuses,
 * because the missing 400 are indistinguishable from files nobody uploaded.
 */

/** A file, with the path it had in the dropped tree. */
export interface DroppedFile {
  file: File
  /** `Wohnbau Nord/03_Einreichung/EG.pdf`, or `undefined` for a loose file. */
  relativePath?: string
}

export interface DroppedTree {
  files: DroppedFile[]
  /** A bound was reached, so this is not everything that was dropped. */
  truncated: boolean
}

/** Bounds. Generous enough for a real Einreichung, finite enough to end. */
const MAX_FILES = 2000
const MAX_DEPTH = 12
const MAX_MILLISECONDS = 20_000

/**
 * The DataTransferItemList entry API, which TypeScript's DOM lib types only
 * partially. Declared here rather than cast at each call site so the shape is
 * stated once and the traversal below reads as ordinary code.
 */
interface FileSystemEntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  fullPath?: string
  file?: (onSuccess: (file: File) => void, onError: (error: unknown) => void) => void
  createReader?: () => {
    readEntries: (
      onSuccess: (entries: FileSystemEntryLike[]) => void,
      onError: (error: unknown) => void
    ) => void
  }
}

const entryFile = (entry: FileSystemEntryLike): Promise<File | null> =>
  new Promise((resolve) => {
    if (!entry.file) return resolve(null)
    entry.file(
      (file) => resolve(file),
      () => resolve(null)
    )
  })

/**
 * One `readEntries` call returns at most 100 entries and signals the end with an
 * empty batch — a directory of 400 files read once yields 100 and looks
 * complete. Draining is not an optimisation here; a single read is a bug.
 */
const readAllEntries = async (entry: FileSystemEntryLike): Promise<FileSystemEntryLike[]> => {
  const reader = entry.createReader?.()
  if (!reader) return []
  const all: FileSystemEntryLike[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve) => {
      reader.readEntries(
        (entries) => resolve(entries),
        () => resolve([])
      )
    })
    if (batch.length === 0) return all
    all.push(...batch)
    // A directory that never reports an empty batch would loop forever.
    if (all.length > MAX_FILES) return all
  }
}

/**
 * Every file under a drop, with its path in the dropped tree.
 *
 * Returns `null` when the browser exposes no entries at all, which is the
 * caller's signal to fall back to `dataTransfer.files` — that path is still
 * correct for a plain multi-file drop and is what every existing caller did.
 */
export async function readDroppedTree(dataTransfer: DataTransfer): Promise<DroppedTree | null> {
  const items = dataTransfer.items
  if (!items || items.length === 0) return null

  // MUST happen synchronously, before any await: the DataTransferItemList is
  // emptied when the drop event finishes, so an entry captured one tick later
  // is null and the whole drop reads as empty.
  const roots: FileSystemEntryLike[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item?.kind !== 'file') continue
    const getEntry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null }
    ).webkitGetAsEntry
    const entry = getEntry?.call(item)
    if (entry) roots.push(entry)
  }
  if (roots.length === 0) return null

  const startedAt = Date.now()
  const files: DroppedFile[] = []
  let truncated = false

  const queue: Array<{ entry: FileSystemEntryLike; path: string; depth: number }> = roots.map(
    (entry) => ({ entry, path: entry.name, depth: 0 })
  )

  while (queue.length > 0) {
    if (files.length >= MAX_FILES || Date.now() - startedAt > MAX_MILLISECONDS) {
      truncated = true
      break
    }
    const { entry, path, depth } = queue.shift()!

    if (entry.isFile) {
      const file = await entryFile(entry)
      // A folder drop of one file still carries a path; a LOOSE file dropped
      // beside it does not, and must not be given a fabricated one.
      if (file) files.push({ file, relativePath: depth > 0 ? path : undefined })
      continue
    }

    if (entry.isDirectory) {
      if (depth >= MAX_DEPTH) {
        truncated = true
        continue
      }
      const children = await readAllEntries(entry)
      for (const child of children) {
        queue.push({ entry: child, path: `${path}/${child.name}`, depth: depth + 1 })
      }
    }
  }

  if (files.length === 0) return null
  return { files, truncated }
}

/**
 * The dropped tree as plain `File`s, each carrying its path the way a folder
 * INPUT would.
 *
 * `<input webkitdirectory>` already gives every file a `webkitRelativePath`,
 * and that property means exactly what the traversal above computed. Stamping
 * it here rather than inventing a parallel shape means the two ways of
 * choosing a folder produce the same thing, and every caller downstream —
 * validation, the upload hook, the request body — reads one property instead
 * of branching on how the files arrived.
 */
export function asPathStampedFiles(tree: DroppedTree): File[] {
  return tree.files.map(({ file, relativePath }) => {
    if (!relativePath) return file
    try {
      Object.defineProperty(file, 'webkitRelativePath', {
        value: relativePath,
        configurable: true,
      })
    } catch {
      // A File implementation that refuses the definition costs the origin
      // path, never the upload.
    }
    return file
  })
}
