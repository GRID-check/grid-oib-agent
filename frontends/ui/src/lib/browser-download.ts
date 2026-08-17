/**
 * Start a file download without navigating the SPA away.
 *
 * `window.location.assign` on a presigned object-store URL leaves the app
 * whenever the store ignores `ResponseContentDisposition` — SeaweedFS often
 * does, so the "download" button used to replace the whole tab with the file.
 * An `<a download>` keeps the page. The attribute is only a hint on
 * cross-origin URLs, so the click also opens a new browsing context: if the
 * store honours attachment the file saves; if it does not, the file still
 * arrives in a tab instead of evicting the app.
 */
export function startBrowserDownload(url: string, filename?: string): void {
  if (typeof document === 'undefined' || url === '') return
  const anchor = document.createElement('a')
  anchor.href = url
  if (filename) anchor.download = filename
  anchor.rel = 'noopener'
  anchor.target = '_blank'
  anchor.referrerPolicy = 'no-referrer'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}
