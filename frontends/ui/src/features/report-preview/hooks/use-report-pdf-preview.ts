'use client'

/**
 * The report, as the PDF it will actually be exported as.
 *
 * `useDownloadPdfRoute` posts the same markdown to the same route and hands the
 * bytes straight to a download; this keeps them, as an object URL an `<iframe>`
 * can render. The difference matters for one reason: a download's object URL is
 * revoked on the next line, and a preview's is alive for as long as the pane is
 * on screen — which makes its lifetime this hook's problem.
 *
 * OBJECT URLS ARE NOT GARBAGE COLLECTED. `URL.createObjectURL` registers the
 * blob against the DOCUMENT, so dropping the string from React state frees
 * nothing: the PDF's bytes stay resident until the tab is closed. A report of
 * any size regenerated a handful of times (the reader edits the question, the
 * research re-runs, the pane reopens) is then tens of megabytes nobody can
 * reach. So each effect run owns EXACTLY ONE url and revokes it in its own
 * cleanup — which is the same code path for every way the preview can end: the
 * report changing, the pane closing, the tab unmounting, a retry superseding it.
 */

import { useCallback, useEffect, useState } from 'react'

export type ReportPdfPreviewStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ReportPdfPreviewState {
  status: ReportPdfPreviewStatus
  /** Object URL of the generated PDF; null unless `status` is `ready`. */
  url: string | null
  /**
   * The failure as the server/network described it, for the detail line under
   * the localized message. Null when the failure carried nothing quotable.
   */
  error: string | null
  /** Generate again after a failure. */
  retry: () => void
}

export function useReportPdfPreview({
  markdown,
  enabled,
}: {
  markdown: string
  /** False while there is nothing to render, or while research is still running. */
  enabled: boolean
}): ReportPdfPreviewState {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<Omit<ReportPdfPreviewState, 'retry'>>({
    status: 'idle',
    url: null,
    error: null,
  })

  useEffect(() => {
    if (!enabled || !markdown.trim()) {
      setState({ status: 'idle', url: null, error: null })
      return
    }

    // Owned by THIS run, revoked by THIS run's cleanup. Not a ref: a ref would
    // have to be reconciled against whichever run last wrote it, and that
    // bookkeeping is exactly where a leaked url hides.
    let objectUrl: string | null = null
    let cancelled = false
    const controller = new AbortController()

    setState({ status: 'loading', url: null, error: null })

    void (async () => {
      try {
        const response = await fetch('/api/generate-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ markdown }),
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`Failed to generate PDF: ${response.status} ${response.statusText}`.trim())
        }
        const blob = await response.blob()
        // The pane went away (or the report changed) while the bytes were in
        // flight. Creating the url here would hand it to a cleanup that has
        // already run, and it would never be revoked.
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setState({ status: 'ready', url: objectUrl, error: null })
      } catch (error) {
        // An aborted fetch rejects. That is this hook tearing itself down, not
        // a failure the reader should be told about.
        if (cancelled) return
        setState({
          status: 'error',
          url: null,
          error: error instanceof Error ? error.message : null,
        })
      }
    })()

    return () => {
      cancelled = true
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [enabled, markdown, attempt])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])

  return { ...state, retry }
}
