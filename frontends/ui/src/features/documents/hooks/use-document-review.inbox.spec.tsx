/**
 * Opening a mark in the review reads its news in the inbox: the reader's
 * informational items anchored on that mark, through the inbox's own client.
 * A mark only stepped past (J/K) does not count, and one mark is not read
 * twice in a minute from the same tab.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/mocks/server'
import type { InboxClient } from '@/lib/inbox/client'
import type { RoomTransport } from './use-document-room'
import { forgetMarkNewsReads, MARK_NEWS_SETTLE_MS, readMarkNews, useDocumentReview } from './use-document-review'

const transport: RoomTransport = {
  connect({ onFrame, onOpen }) {
    onOpen()
    onFrame({ kind: 'welcome', self: { userId: 'user_me', name: 'Miriam Hofer', kind: 'person' } })
    return () => undefined
  },
  post: () => undefined,
}

let reads: unknown[] = []

beforeEach(() => {
  reads = []
  forgetMarkNewsReads()
  server.use(
    http.get('/api/documents/:id/annotations', () => HttpResponse.json({ annotations: [], canAnnotate: true, pilotiWakes: false })),
    http.post('/api/inbox/read', async ({ request }) => {
      reads.push(await request.json())
      return HttpResponse.json({ affected: 1, pending: 0 })
    })
  )
})
afterEach(() => vi.useRealTimers())

describe('opening a mark reads its news', () => {
  it('reads the news about the mark that stays open, and not about one stepped past', async () => {
    const { result } = renderHook(() => useDocumentReview('doc-1', { enabled: true, transport }))
    await waitFor(() => expect(result.current.load).toBe('ready'))

    act(() => result.current.select('mark-1'))
    act(() => result.current.select('mark-2'))

    await waitFor(() => expect(reads).toEqual([{ resourceType: 'document', resourceId: 'doc-1', anchorId: 'mark-2' }]), {
      timeout: MARK_NEWS_SETTLE_MS * 4,
    })
  })

  it('reads one mark once a minute from this tab, and tries again after a failure', async () => {
    const markMarkRead = vi.fn<InboxClient['markMarkRead']>(async () => ({ affected: 0, pending: 0 }))
    const client = { markMarkRead } as Partial<InboxClient> as InboxClient

    readMarkNews('doc-1', 'mark-4', client)
    readMarkNews('doc-1', 'mark-4', client)
    expect(markMarkRead).toHaveBeenCalledTimes(1)

    markMarkRead.mockRejectedValueOnce(new Error('offline'))
    readMarkNews('doc-1', 'mark-5', client)
    await Promise.resolve()
    await Promise.resolve()
    readMarkNews('doc-1', 'mark-5', client)
    expect(markMarkRead).toHaveBeenCalledTimes(3)
  })
})
