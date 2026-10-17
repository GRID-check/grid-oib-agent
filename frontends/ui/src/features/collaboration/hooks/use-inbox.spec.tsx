/**
 * The inbox list's data hook over the typed client: one slice at a time, and
 * older pages kept below the first when the reader asks for them.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./use-live-events', () => ({ useLiveEvents: () => ({ connected: false }) }))
vi.mock('@/lib/push/browser', () => ({ closeNotifications: vi.fn(async () => undefined), setAppBadge: vi.fn() }))

import type { InboxClient } from '@/lib/inbox/client'
import type { InboxItemView, InboxListFilter, InboxListResponse } from '@/lib/inbox/types'
import { useInboxList } from './use-inbox'

const view = (id: string): InboxItemView =>
  ({ id, type: 'conversation.activity', state: 'unread', archived: false }) as Partial<InboxItemView> as InboxItemView

const page = (ids: string[], nextCursor: string | null): InboxListResponse => ({
  items: ids.map(view),
  pending: 1,
  counts: { requests: 1, unread: 2 },
  hasMore: nextCursor !== null,
  nextCursor,
})

function client(pages: Record<string, InboxListResponse>): InboxClient {
  const ok = async () => ({ affected: 1, pending: 0 })
  return {
    list: vi.fn(async ({ cursor } = {}) => pages[cursor ?? 'first']),
    summary: vi.fn(async () => ({ pending: 0 })),
    markRead: vi.fn(ok),
    markAllRead: vi.fn(ok),
    markMarkRead: vi.fn(ok),
    markUnread: vi.fn(ok),
    archive: vi.fn(ok),
    unarchive: vi.fn(ok),
  }
}

describe('useInboxList', () => {
  it('reads the slice it is given, with the numbers beside the filters', async () => {
    const inbox = client({ first: page(['a'], null) })
    const { result } = renderHook(() => useInboxList(true, 'requests', inbox))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(inbox.list).toHaveBeenCalledWith({ filter: 'requests' })
    expect(result.current.counts).toEqual({ requests: 1, unread: 2 })
    expect(result.current.hasMore).toBe(false)
  })

  it('loads older pages below the first, and keeps them when the first is read again', async () => {
    const inbox = client({ first: page(['a', 'b'], 'c1'), c1: page(['c', 'd'], 'c2'), c2: page(['e'], null) })
    const { result } = renderHook(() => useInboxList(true, 'all', inbox))
    await waitFor(() => expect(result.current.hasMore).toBe(true))

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']))
    expect(inbox.list).toHaveBeenLastCalledWith({ filter: 'all', cursor: 'c1' })
    expect(result.current.hasMore).toBe(true)

    // A mutation re-reads the first page; the older rows stay, the cursor too.
    await act(() => result.current.markRead(['a']))
    expect(result.current.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd'])

    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'e']))
    expect(result.current.hasMore).toBe(false)
  })

  it('re-reads every page the reader loaded, so a row pushed off the first page is not lost in the gap', async () => {
    const pages: Record<string, InboxListResponse> = { first: page(['a', 'b'], 'c1'), c1: page(['c', 'd'], null) }
    const inbox = client(pages)
    const { result } = renderHook(() => useInboxList(true, 'all', inbox))
    await waitFor(() => expect(result.current.hasMore).toBe(true))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd']))

    // A new row arrives on top: „b“ moves to the second page, which now starts there.
    pages.first = page(['new', 'a'], 'c2')
    pages.c2 = page(['b', 'c'], 'c3')
    pages.c3 = page(['d'], null)
    act(() => result.current.refresh())

    await waitFor(() => expect(result.current.items.map((item) => item.id)).toEqual(['new', 'a', 'b', 'c']))
    expect(result.current.hasMore).toBe(true)
  })

  it('drops an older page that arrives after the filter changed', async () => {
    let release: (value: InboxListResponse) => void = () => undefined
    const inbox = client({ first: page(['a'], 'c1') })
    vi.mocked(inbox.list).mockImplementation(async ({ cursor } = {}) =>
      cursor ? new Promise<InboxListResponse>((resolve) => (release = resolve)) : page(['a'], 'c1')
    )
    const { result, rerender } = renderHook(({ filter }) => useInboxList(true, filter, inbox), {
      initialProps: { filter: 'all' as InboxListFilter },
    })
    await waitFor(() => expect(result.current.hasMore).toBe(true))
    act(() => result.current.loadMore())
    rerender({ filter: 'unread' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => release(page(['stale'], 'stale-cursor')))
    expect(result.current.items.map((item) => item.id)).toEqual(['a'])
    expect(inbox.list).not.toHaveBeenCalledWith({ filter: 'unread', cursor: 'stale-cursor' })
  })

  it('takes a change back when the server refuses it', async () => {
    const inbox = client({ first: page(['a'], null) })
    vi.mocked(inbox.markRead).mockRejectedValueOnce(new Error('refused'))
    const { result } = renderHook(() => useInboxList(true, 'all', inbox))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.markRead(['a']))
    expect(result.current.items[0]?.state).toBe('unread')
    expect(result.current.mutationError).toBe(true)
  })

  it('marks unread, restores and archives through the client', async () => {
    const inbox = client({ first: page(['a'], null) })
    const { result } = renderHook(() => useInboxList(true, 'archived', inbox))
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(() => result.current.markUnread(['a']))
    await act(() => result.current.unarchive('a'))
    await act(() => result.current.archive('a'))
    expect(inbox.markUnread).toHaveBeenCalledWith(['a'])
    expect(inbox.unarchive).toHaveBeenCalledWith('a')
    expect(inbox.archive).toHaveBeenCalledWith('a')
  })
})
