'use client'

import { useEffect, useMemo, useRef } from 'react'
import { notifyDocumentsChanged } from '@/lib/documents/document-changes'
import { isSettlingStatus } from '../components/document-status'

/**
 * How often a list re-asks while something on it is unsettled. Matches the
 * model surfaces' extraction poll, which is sized against the same work: a
 * model takes tens of seconds, so this is a handful of requests, and none at
 * all once everything has landed.
 */
export const SETTLING_POLL_MS = 4_000

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

/** The one field this poll reads — every document surface's row has it. */
interface SettlingItem {
  status: string | null | undefined
  /**
   * Still worth asking about although the status is terminal: something the
   * row shows (the summary, the counts) is known to trail the status. The
   * caller owns the bound — this poll asks for as long as it says so.
   */
  pending?: boolean
}

/**
 * Re-ask while anything in a list is still being read.
 *
 * A list fetched once and never again leaves a document that finished indexing
 * after the page loaded wearing its "Wird verarbeitet…" badge until someone
 * reloads. For a PDF that is a stale label; for an `.ifc` it hides the only
 * moment that matters. IFC extraction is DETACHED and has no ingest job at
 * upload time (`beginModelExtraction` returns a null job id), so the upload
 * orchestrator — which polls by job id — never watches a model at all. The card
 * for a 150 MB building therefore sat at "processing" forever, on exactly the
 * file whose payoff is "now ask it something".
 *
 * This lives in a hook rather than in one workspace because BOTH document
 * surfaces need it and only one had it: Archiv calls its loader on mount and
 * once more when the BYTES land — which is the moment extraction STARTS — so an
 * `.ifc` uploaded there never settled on screen at all.
 *
 * The poll runs only while something is unsettled and stops the moment
 * everything is terminal, so a corpus of finished documents makes no requests.
 * `useIngestionCompleteToast` turns the transition it observes into the
 * confirmation the user sees.
 *
 * @param items The rows currently on screen; their statuses decide whether to poll.
 * @param refresh What one tick re-reads, called with `quiet = true` so the poll
 *   never flashes a skeleton over a grid the user is reading. A list passes the
 *   cheap read of its settling rows here, never the full drain.
 * @param intervalMs Gap between a settled refresh and the next one.
 */
export function useSettlingRefresh(
  items: readonly SettlingItem[],
  refresh: (quiet?: boolean) => Promise<unknown>,
  intervalMs: number = SETTLING_POLL_MS
): void {
  const hasSettlingItem = useMemo(
    () => items.some((item) => item.pending === true || isSettlingStatus(item.status)),
    [items]
  )

  // THE MOMENT THE LIST SETTLES, the estate changed. The upload announced
  // itself while its rows were still being read, and the caches that listen
  // (the citation index, the surfaced document cards) took that snapshot and
  // kept it: rows without chunks, a file the answer could not be opened into.
  // Nothing else observes completion for a detached extraction (an `.ifc`, an
  // office file converting to its rendition), which has no ingest job for the
  // upload orchestrator to watch. Only a flip with rows still on screen counts:
  // a preview closing mid-read empties its list of one, and nothing settled.
  const wasSettling = useRef(false)
  useEffect(() => {
    if (wasSettling.current && !hasSettlingItem && items.length > 0) notifyDocumentsChanged()
    wasSettling.current = hasSettlingItem
  }, [hasSettlingItem, items.length])

  useEffect(() => {
    if (!hasSettlingItem) return
    // Chained, not `setInterval`. An interval fires again whether or not the
    // previous refresh came back, so a slow endpoint accumulated requests and
    // let an older response land after a newer one — overwriting a document
    // that had just finished with its earlier "still reading" row. Scheduling
    // the next poll only once the current one settles makes at most one in
    // flight and puts them in order by construction.
    //
    // A hidden tab does not ask. Nobody is reading the badge, and a workspace
    // left open in a background tab over a long extraction was the one client
    // still polling at 4 s. The tick that falls due while hidden parks; the tab
    // coming back asks straight away, so the reader never sees a stale badge
    // for a full interval, and the chain resumes from there.
    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (!cancelled) timer = setTimeout(tick, intervalMs)
    }
    const tick = () => {
      timer = null
      if (isDocumentHidden()) return
      inFlight = true
      void refresh(true).finally(() => {
        inFlight = false
        schedule()
      })
    }
    const onVisibilityChange = () => {
      if (cancelled || inFlight || isDocumentHidden()) return
      if (timer) clearTimeout(timer)
      tick()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    schedule()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [hasSettlingItem, refresh, intervalMs])
}
