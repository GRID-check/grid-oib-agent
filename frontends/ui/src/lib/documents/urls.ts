/**
 * Browser-facing URLs for a stored document.
 *
 * A stored document has two addresses and they are not interchangeable, which
 * is the whole reason this module exists rather than each caller writing the
 * path inline:
 *
 * - the PRESIGNED object-store URL from `/api/documents/{id}/preview`, for
 *   anything the browser NAVIGATES to — a new tab, a download, an `<img>`. It
 *   costs this origin nothing to serve and it expires.
 * - the SAME-ORIGIN stream below, for anything the browser FETCHES. The in-app
 *   PDF viewer reads the file with XHR to build a text layer, and a cross-origin
 *   fetch needs a CORS policy the object store does not publish — so the
 *   presigned URL loads in an iframe and fails in the viewer, which is the least
 *   obvious way these two could differ.
 *
 * Reach for `documentFileUrl` whenever code will *read* the bytes; leave the
 * presigned URL to the cases that hand a URL to the browser to open.
 */

/** Same-origin, session-authorized stream of a stored document's bytes. */
export const documentFileUrl = (documentId: string): string =>
  `/api/documents/${encodeURIComponent(documentId)}/file`
