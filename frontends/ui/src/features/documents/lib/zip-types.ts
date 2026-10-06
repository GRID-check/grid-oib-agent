/**
 * What a ZIP is, as the upload surfaces see it.
 *
 * Kept apart from `expand-zip.ts` on purpose: the drag overlay and the file
 * picker both need to know that a `.zip` is acceptable, and they live in the
 * chat's bundle too. Importing these from the module that owns the unzip
 * library would put the library in every page that accepts a file.
 */

/** A ZIP of documents, which the browser unpacks before anything is uploaded. */
export const ZIP_EXTENSION = '.zip'

/**
 * What a browser reports for a dragged zip. Windows says `x-zip-compressed`
 * through the picker AND through a drag, the same quirk `.ifczip` has in
 * `shared/config/file-upload.ts`.
 */
export const ZIP_MIME_TYPES: readonly string[] = [
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
]

/**
 * Whether a file is a ZIP of documents.
 *
 * `.ifczip` is NOT one: it is a building model that the IFC pipeline reads as
 * it is, and unpacking it would turn one model into a heap of loose members.
 * The dot in the pattern is what keeps the two apart.
 */
export const isZipArchive = (file: { name: string }): boolean => /\.zip$/i.test(file.name)

/** An accept-list that also offers `.zip`, for the pickers of a durable shelf. */
export const withZipAccepted = (accept: string): string =>
  accept
    .split(',')
    .map((extension) => extension.trim().toLowerCase())
    .includes(ZIP_EXTENSION)
    ? accept
    : `${accept},${ZIP_EXTENSION}`
