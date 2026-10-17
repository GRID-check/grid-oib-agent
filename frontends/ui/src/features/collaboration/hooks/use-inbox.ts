'use client'

/**
 * Inbox data hooks: the badge count and the list.
 *
 * The typed inbox client (`lib/inbox/client.ts`, ADR-0055) + `useState`,
 * matching how the rest of this codebase loads data (SWR and react-query are in
 * `package.json` but unused anywhere in `src`).
 *
 * Both hooks treat live events strictly as a nudge to re-read (spec RT-4). The
 * badge takes one shortcut — an `inbox.changed` event carries the count the
 * publisher computed, so a non-negative value updates the number directly and
 * saves a request. A negative value means "unknown" and forces a real read.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { inboxClient, type InboxClient } from '@/lib/inbox/client'
import type { InboxItemView, InboxListFilter, InboxListResponse } from '@/lib/inbox/types'
import { closeNotifications, setAppBadge, type CloseNotificationsRequest } from '@/lib/push/browser'
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
export function useInboxBadge(enabled: boolean, client: InboxClient = inboxClient): UseInboxBadgeResult {
  const [pending, setPending] = useState(0)

  const refresh = useCallback(async () => {
    if (!enabled) return
    try {
      const data = await client.summary()
      setPending(Math.max(0, data.pending ?? 0))
    } catch {
      // Keep the last known count. A failed poll must not blank the badge —
      // showing zero when there are outstanding requests is worse than stale.
    }
  }, [enabled, client])

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

  // The number on the app icon, where the platform has one (an installed app on
  // a phone or desktop). Cleared at zero.
  useEffect(() => {
    if (enabled) setAppBadge(pending)
  }, [enabled, pending])

  return { pending, connected, refresh: () => void refresh() }
}

export interface UseInboxListResult {
  items: InboxItemView[]
  pending: number
  /** The numbers beside the filters: requests still open, rows not opened yet. */
  counts: InboxListResponse['counts']
  loading: boolean
  /** The LIST could not be read. The rows on screen, if any, are stale. */
  error: boolean
  /**
   * A mutation was refused. Distinct from `error` on purpose: the rows are fine,
   * one action did not land. Folding the two together meant that archiving a row
   * a second tab had already archived replaced the entire inbox with "your inbox
   * could not be loaded" — a sentence that was not true.
   */
  mutationError: boolean
  dismissMutationError: () => void
  /** True while a mutation is in flight, so a bulk action can say it is working. */
  mutating: boolean
  connected: boolean
  refresh: () => void
  /** Whether older rows exist behind the ones loaded. */
  hasMore: boolean
  /** An older page is being read. */
  loadingMore: boolean
  /** The last older page could not be read; the button asks again. */
  loadMoreFailed: boolean
  loadMore: () => void
  markRead: (itemIds: string[]) => Promise<void>
  markUnread: (itemIds: string[]) => Promise<void>
  markAllRead: () => Promise<void>
  archive: (itemId: string) => Promise<void>
  /** Resolves true once the row is out of the archive, false when the server refused. */
  unarchive: (itemId: string) => Promise<boolean>
}

const NO_COUNTS: InboxListResponse['counts'] = { requests: 0, unread: 0 }

/**
 * The inbox page/panel, through one filter (`InboxListFilter`).
 *
 * A live nudge re-reads what the reader has in front of them: the first page,
 * and as many older pages as they had loaded („Ältere Einträge laden“), each
 * following the cursor the page before handed back. Re-reading only the first
 * page and keeping the older ones as they were left a gap: new rows pushed the
 * last ones of the first page down, past the older pages' start, and they
 * vanished. Changing the filter starts again from one page.
 */
export function useInboxList(
  enabled: boolean,
  filter: InboxListFilter,
  client: InboxClient = inboxClient
): UseInboxListResult {
  const [items, setItems] = useState<InboxItemView[]>([])
  // The rows as last rendered, for a change to snapshot before it patches them.
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  const [pending, setPending] = useState(0)
  const [counts, setCounts] = useState<InboxListResponse['counts']>(NO_COUNTS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [mutationError, setMutationError] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreFailed, setLoadMoreFailed] = useState(false)
  // How many pages the reader has loaded: a re-read reads as many again.
  const pagesRef = useRef(1)

  // Guards an out-of-order response from overwriting a newer one: switching the
  // filter twice quickly would otherwise let the first (slower) reply win, and
  // an older page read for the previous filter must not land in this one.
  const requestSeq = useRef(0)

  const refresh = useCallback(async () => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const seq = ++requestSeq.current
    try {
      const first = await client.list({ filter })
      let rows = first.items
      let next = first.hasMore ? first.nextCursor : null
      for (let page = 1; page < pagesRef.current && next; page++) {
        const older = await client.list({ filter, cursor: next })
        rows = [...rows, ...older.items]
        next = older.hasMore ? older.nextCursor : null
      }
      if (seq !== requestSeq.current) return
      const seen = new Set<string>()
      setItems(rows.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true))))
      setPending(Math.max(0, first.pending))
      setCounts(first.counts)
      setCursor(next)
      setError(false)
    } catch {
      if (seq !== requestSeq.current) return
      setError(true)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [enabled, filter, client])

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
    setCursor(null)
    setLoadMoreFailed(false)
    pagesRef.current = 1
    void refresh()
  }, [refresh])

  const loadMore = useCallback(async () => {
    if (!enabled || !cursor || loadingMore) return
    const seq = requestSeq.current
    setLoadingMore(true)
    setLoadMoreFailed(false)
    try {
      const data = await client.list({ filter, cursor })
      // The filter changed, or a re-read rebuilt the list, while this page was
      // on its way: it belongs to a list that is no longer on screen.
      if (seq !== requestSeq.current) return
      pagesRef.current += 1
      setItems((current) => {
        const shown = new Set(current.map((item) => item.id))
        return [...current, ...data.items.filter((item) => !shown.has(item.id))]
      })
      setCursor(data.hasMore ? data.nextCursor : null)
    } catch {
      if (seq === requestSeq.current) setLoadMoreFailed(true)
    } finally {
      setLoadingMore(false)
    }
  }, [enabled, cursor, loadingMore, client, filter])

  const mutate = useCallback(
    async (run: () => Promise<unknown>, closes?: CloseNotificationsRequest): Promise<boolean> => {
      setMutating(true)
      setMutationError(false)
      try {
        await run()
        // The mutation landed; the refresh below re-reads the truth. What the
        // person has dealt with here is no longer news on this device.
        if (closes) void closeNotifications(closes).catch(() => undefined)
        await refresh()
        return true
      } catch {
        // A refusal (e.g. a 404 for an item another tab already archived) must
        // not look like a no-op: surface it. As a MUTATION failure, though — the
        // list itself is intact and blanking it would be the bigger lie.
        setMutationError(true)
        return false
      } finally {
        setMutating(false)
      }
    },
    [refresh],
  )

  /**
   * Show a change at once, and take it back if the server refused it: the
   * re-read after a success brings the truth either way, so the patch only
   * has to cover the moment in between, and must not outlive a refusal.
   */
  const optimistic = useCallback(
    async (
      patch: (item: InboxItemView) => InboxItemView | null,
      ids: readonly string[] | 'all',
      run: () => Promise<unknown>,
      closes?: CloseNotificationsRequest,
    ): Promise<boolean> => {
      const before = itemsRef.current
      setItems((current) =>
        current.flatMap((item) => {
          if (ids !== 'all' && !ids.includes(item.id)) return [item]
          const next = patch(item)
          return next ? [next] : []
        })
      )
      const ok = await mutate(run, closes)
      if (!ok) setItems(before)
      return ok
    },
    [mutate],
  )

  const markRead = useCallback(
    async (itemIds: string[]) => {
      if (itemIds.length === 0) return
      await optimistic(
        (item) => ({ ...item, state: item.state === 'unread' ? 'read' : item.state }),
        itemIds,
        () => client.markRead(itemIds),
        { itemIds },
      )
    },
    [optimistic, client],
  )

  const markUnread = useCallback(
    async (itemIds: string[]) => {
      if (itemIds.length === 0) return
      await optimistic(
        (item) => ({ ...item, state: item.state === 'read' ? 'unread' : item.state }),
        itemIds,
        () => client.markUnread(itemIds),
      )
    },
    [optimistic, client],
  )

  const markAllRead = useCallback(async () => {
    await optimistic(
      (item) => (item.state === 'unread' ? { ...item, state: 'read' } : item),
      'all',
      () => client.markAllRead(),
      { all: true },
    )
  }, [optimistic, client])

  const archive = useCallback(
    async (itemId: string) => {
      await optimistic(() => null, [itemId], () => client.archive(itemId), { itemIds: [itemId] })
    },
    [optimistic, client],
  )

  const unarchive = useCallback(
    async (itemId: string): Promise<boolean> => optimistic(() => null, [itemId], () => client.unarchive(itemId)),
    [optimistic, client],
  )

  return {
    items,
    pending,
    counts,
    loading,
    error,
    mutationError,
    dismissMutationError: () => setMutationError(false),
    mutating,
    connected,
    refresh: () => void refresh(),
    hasMore: cursor !== null,
    loadingMore,
    loadMoreFailed,
    loadMore: () => void loadMore(),
    markRead,
    markUnread,
    markAllRead,
    archive,
    unarchive,
  }
}
