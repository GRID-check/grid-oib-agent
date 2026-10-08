/**
 * Which stored content types this product can show, and where.
 *
 * ONE LIST, because there are three readers of it and they have already drifted
 * twice. `PREVIEW_CONTENT_TYPES` in `lib/documents/service.ts` is what actually
 * gates the presign, so it was the authority and the other two were copies:
 * `file-preview-pane.tsx` carried a copy that had lost BMP and TIFF — the BFF
 * would presign bytes the pane never asked for, and the reader got the "no
 * inline preview" mock for a file the product could show — and the citation
 * resolver later grew a third copy that lost them again, plus the text types.
 * Each copy looked locally correct, which is exactly why the drift was
 * invisible.
 *
 * This module is pure, with no `server-only` import, precisely so the browser
 * tiers can share it: that was the reason the copies existed at all.
 */

/**
 * Rendered inline from the object store — a PDF frame or an `<img>`.
 *
 * The gate on `/api/documents/{id}/preview`: a type outside this list is a 415,
 * so a surface that offers a preview for one is offering something the BFF will
 * refuse.
 */
export const INLINE_PREVIEW_CONTENT_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/tiff',
] as const

/**
 * Read as TEXT through this origin instead — `/api/documents/{id}/text`.
 *
 * A different shape of answer (a string, not an object-store URL), which is why
 * it is a second list rather than more entries in the first. `text/html` is
 * deliberately absent and must stay absent: these bytes are uploaded by users
 * and would be returned same-origin.
 */
export const TEXT_PREVIEW_CONTENT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
] as const

const inline = new Set<string>(INLINE_PREVIEW_CONTENT_TYPES)

/** Whether the object-store preview route will serve this type inline. */
export const isInlinePreviewable = (contentType: string | null | undefined): boolean =>
  contentType != null && inline.has(contentType.trim().toLowerCase())

/**
 * Office formats the BFF converts to a PDF RENDITION for viewing (ADR-0070).
 *
 * A third way of being shown, and a different promise from the two lists
 * above: these bytes are never served inline themselves. The preview and file
 * routes serve `<dir>/_render.pdf`, a PDF the BFF made from them through
 * Gotenberg, and the ORIGINAL stays exactly as uploaded — the download route
 * still hands out the Word, Excel or PowerPoint file and nothing else. Keyed by
 * extension as well as by type because the stored type is whatever the browser
 * sent, and an empty one is stored as NULL.
 */
export const OFFICE_RENDITION_CONTENT_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-word.document.macroenabled.12',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel.sheet.macroenabled.12',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'text/rtf',
] as const

/** The extensions of {@link OFFICE_RENDITION_CONTENT_TYPES}, lower case, with the dot. */
export const OFFICE_RENDITION_EXTENSIONS = [
  '.docx',
  '.docm',
  '.doc',
  '.xlsx',
  '.xlsm',
  '.xls',
  '.pptx',
  '.pptm',
  '.ppt',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
] as const

const officeTypes = new Set<string>(OFFICE_RENDITION_CONTENT_TYPES)
const officeExtensions = new Set<string>(OFFICE_RENDITION_EXTENSIONS)

/**
 * Whether this file is shown through a PDF rendition rather than its own bytes.
 *
 * True when EITHER the stored type or the filename's extension names an office
 * format. A filename alone is enough on purpose: a `.docx` stored as NULL or
 * `application/octet-stream` is still a Word file, and LibreOffice reads the
 * bytes, not the label.
 */
export function isOfficeRenditionSource(file: {
  contentType?: string | null
  filename?: string | null
}): boolean {
  const type = file.contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (type && officeTypes.has(type)) return true
  const name = file.filename?.trim().toLowerCase() ?? ''
  const dot = name.lastIndexOf('.')
  return dot >= 0 && officeExtensions.has(name.slice(dot))
}

/**
 * Office formats whose TEXT the backend indexes from the PDF rendition, not the
 * original (ADR-0071).
 *
 * The rendition carries what the original's text-only readers never saw: the
 * pictures in a deck or a Word file, and real page numbers a citation can open
 * at. `.xls` and `.ods` are here because they have no extractor of their own and
 * would otherwise fall back to raw bytes. `.xlsx` and `.xlsm` are deliberately
 * absent: openpyxl keeps a sheet's rows and columns, and LibreOffice splits one
 * sheet across as many printed pages as its width needs.
 *
 * The BFF dispatch decides with this list and the citation resolver trusts a
 * locus page for the same formats, so both import it from here. The backend has
 * no list of its own: it reads the rendition iff the request carries one.
 */
export const RENDITION_INDEXED_EXTENSIONS = [
  '.docx',
  '.docm',
  '.doc',
  '.odt',
  '.rtf',
  '.pptx',
  '.pptm',
  '.ppt',
  '.odp',
  '.xls',
  '.ods',
] as const

const renditionIndexedExtensions = new Set<string>(RENDITION_INDEXED_EXTENSIONS)

/**
 * Whether this file's chunks come from its rendition, so a locus page is a
 * rendition page. Keyed by extension only: the dispatch and the resolver both
 * hold the filename, and the stored type is whatever the browser sent.
 */
export function isIndexedFromRendition(filename: string | null | undefined): boolean {
  const name = filename?.trim().toLowerCase() ?? ''
  const dot = name.lastIndexOf('.')
  return dot >= 0 && renditionIndexedExtensions.has(name.slice(dot))
}
