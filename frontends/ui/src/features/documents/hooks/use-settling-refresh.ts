'use client'

import { useEffect, useMemo } from 'react'
import { isSettlingStatus } from '../components/document-status'

/**
 * How often a list re-asks while something on it is unsettled. Matches the
 * model surfaces' extraction poll, which is sized against the same work: a
 * model takes tens of seconds, so this is a handful of requests, and none at
 * all once everything has landed.
 */
export const SETTLING_POLL_MS = 4_000

/** The one field this poll reads — every document surface's row has it. */
interface SettlingItem {
  status: string | null | undefined
}

/**
 * Re-ask while anything in a list is still being read.
 *
 * A list fetched once and never again leaves a document that finished indexing
 * after the page loaded wearing its "Wird gelesen…" badge until someone
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
 * @param refresh The list loader, called with `quiet = true` so the poll never
 *   flashes a skeleton over a grid the user is reading.
 * @param intervalMs Gap between a settled refresh and the next one.
 */
export function useSettlingRefresh(
  items: readonly SettlingItem[],
  refresh: (quiet?: boolean) => Promise<unknown>,
  intervalMs: number = SETTLING_POLL_MS
): void {
  const hasSettlingItem = useMemo(() => items.some((item) => isSettlingStatus(item.status)), [items])

  useEffect(() => {
    if (!hasSettlingItem) return
    // Chained, not `setInterval`. An interval fires again whether or not the
    // previous refresh came back, so a slow endpoint accumulated requests and
    // let an older response land after a newer one — overwriting a document
    // that had just finished with its earlier "still reading" row. Scheduling
    // the next poll only once the current one settles makes at most one in
    // flight and puts them in order by construction.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = () => {
      void refresh(true).finally(() => {
        if (!cancelled) timer = setTimeout(tick, intervalMs)
      })
    }
    timer = setTimeout(tick, intervalMs)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [hasSettlingItem, refresh, intervalMs])
}
