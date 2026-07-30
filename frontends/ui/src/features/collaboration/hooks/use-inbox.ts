'use client'

/**
 * Inbox data hooks: the badge count and the list.
 *
 * Plain `fetch` + `useState`, matching how the rest of this codebase loads data
 * (SWR and react-query are in `package.json` but unused anywhere in `src`).
 *
 * Both hooks treat live events strictly as a nudge to re-read (spec RT-4). The
 * badge takes one shortcut — an `inbox.changed` event carries the count the
 * publisher computed, so a non-negative value updates the number directly and
 * saves a request. A negative value means "unknown" and forces a real read.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { InboxListResponse, InboxItemView, InboxSummaryResponse } from '@/lib/inbox/types'
import { useLiveEvents } from './use-live-events'

export interface UseInboxBadgeResult {
  pending: number
  connected: boolean
  refresh: () => void
}

/**
 * The count rendered in the nav. Mounted on every page, so it does exactly one
 * request on mount and then rides the event channel.
 */
export function useInboxBadge(enabled: boolean): UseInboxBadgeResult {
  const [pending, setPending] = useState(0)

  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const response = await fetch('/api/inbox/summary')
      if (!response.ok) return
      const data = (await response.json()) as InboxSummaryResponse
      setPending(Math.max(0, data.pending ?? 0))
    } catch {
      // Keep the last known count. A failed poll must not blank the badge —
      // showing zero when there are outstanding requests is worse than stale.
    }
  }, [enabled])

  const { connected } = useLiveEvents({
    enabled,
    onEvent: (event) => {
      if (event.kind !== 'inbox.changed') return
      // Trust a non-negative count from the publisher; anything else is a signal
      // to go and read the real number.
      if (event.pending >= 0) setPending(event.pending)
      else void refresh()
    },
    onRefresh: () => void refresh(),
  })

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { pending, connected, refresh: () => void refresh() }
}

export interface UseInboxListResult {
  items: InboxItemView[]
  pending: number
  loading: boolean
  error: boolean
  connected: boolean
  refresh: () => void
  markRead: (itemIds: string[]) => Promise<void>
  markAllRead: () => Promise<void>
  archive: (itemId: string) => Promise<void>
}

/** The inbox page/panel. */
export function useInboxList(enabled: boolean, pendingOnly: boolean): UseInboxListResult {
  const [items, setItems] = useState<InboxItemView[]>([])
  const [pending, setPending] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  // Guards an out-of-order response from overwriting a newer one: switching the
  // filter twice quickly would otherwise let the first (slower) reply win.
  const requestSeq = useRef(0)

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const seq = ++requestSeq.current
    try {
      const response = await fetch(`/api/inbox?pendingOnly=${pendingOnly ? 'true' : 'false'}`)
      if (!response.ok) throw new Error(`inbox ${response.status}`)
      const data = (await response.json()) as InboxListResponse
      if (seq !== requestSeq.current) return
      setItems(data.items ?? [])
      setPending(Math.max(0, data.pending ?? 0))
      setError(false)
    } catch {
      if (seq !== requestSeq.current) return
      setError(true)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [enabled, pendingOnly])

  const { connected } = useLiveEvents({
    enabled,
    // The list re-reads on ANY inbox change: unlike the badge there is no payload
    // shortcut that could reconstruct a row.
    onEvent: (event) => {
      if (event.kind === 'inbox.changed') void refresh()
    },
    onRefresh: () => void refresh(),
  })

  useEffect(() => {
    setLoading(true)
    void refresh()
  }, [refresh])

  const mutate = useCallback(
    async (input: RequestInfo, init: RequestInit) => {
      try {
        await fetch(input, init)
      } catch {
        // Swallow: the refresh below re-reads the truth either way.
      }
      await refresh()
    },
    [refresh],
  )

  const markRead = useCallback(
    async (itemIds: string[]) => {
      if (itemIds.length === 0) return
      await mutate('/api/inbox/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds }),
      })
    },
    [mutate],
  )

  const markAllRead = useCallback(async () => {
    await mutate('/api/inbox/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
  }, [mutate])

  const archive = useCallback(
    async (itemId: string) => {
      await mutate(`/api/inbox/${encodeURIComponent(itemId)}/archive`, { method: 'POST' })
    },
    [mutate],
  )

  return { items, pending, loading, error, connected, refresh: () => void refresh(), markRead, markAllRead, archive }
}
