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
