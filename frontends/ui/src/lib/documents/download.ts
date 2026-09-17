/**
 * Getting a stored document onto the reader's disk.
 *
 * Two surfaces do this — the Files workspace's document actions and a citation
 * whose document has no in-app viewer — and they were two copies of the same
 * six lines, including a re-typed rationale for the one thing that must not
 * change. The copies had already started to drift: one honoured the filename
 * the route returns and the other did not.
 *
 * DO NOT `location.assign` the presigned URL. The route answers with JSON
 * (`{ downloadUrl, filename }`) rather than bytes, and if the object store
 * ignores `Content-Disposition` a navigation replaces the whole app with the
 * file (#434). Fetch the link, then hand it to `startBrowserDownload`.
 */

import { startBrowserDownload } from '@/lib/browser-download'

/**
 * Presign and start the download. Resolves `true` when the browser was handed a
 * file, `false` when the route refused or the network failed — the caller owns
 * how that reads (a toast, an inline failure line).
 *
 * `fallbackName` is used only when the route names none; the route's own
 * filename wins, because it is the one that matches the stored object.
 */
export async function startDocumentDownload(
  documentId: string,
  fallbackName?: string
): Promise<boolean> {
  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/download`)
    const data = response.ok ? await response.json() : null
    const url = typeof data?.downloadUrl === 'string' ? data.downloadUrl : ''
    if (!url) return false
    const named =
      typeof data?.filename === 'string' && data.filename !== '' ? data.filename : fallbackName
    startBrowserDownload(url, named)
    return true
  } catch {
    return false
  }
}
