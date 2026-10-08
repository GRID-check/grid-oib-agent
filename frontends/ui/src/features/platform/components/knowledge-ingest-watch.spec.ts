import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { KnowledgeBaseStatus, KnowledgeFile } from '@/lib/knowledge/service'
import {
  MAX_POLLS,
  MISSING_AFTER_MS,
  POLL_INTERVAL_MS,
  classifyWatched,
  useIngestWatch,
} from './knowledge-ingest-watch'

function file(fileName: string, state: KnowledgeFile['state']): KnowledgeFile {
  return {
    fileName,
    state,
    sizeBytes: 1,
    chunkCount: state === 'ingested' ? 3 : 0,
    ingestedSha256: null,
    currentSha256: null,
    ingestedAt: null,
    summary: null,
    docClass: 'sonstiges',
    docClassSuggestion: null,
    displayTitle: null,
  }
}

function status(...files: KnowledgeFile[]): KnowledgeBaseStatus {
  return {
    collectionName: 'oib',
    collectionExists: true,
    collectionUpdatedAt: null,
    summary: {
      totalFiles: files.length,
      ingested: 0,
      stale: 0,
      pending: 0,
      failed: 0,
      removed: 0,
      inconsistent: 0,
      totalChunks: 0,
    },
    files,
  }
}

/** A fetch whose answers the test hands out one by one. */
function deferredFetch() {
  const pending: ((value: KnowledgeBaseStatus) => void)[] = []
  const fetchStatus = vi.fn(
    () =>
      new Promise<KnowledgeBaseStatus>((resolve) => {
        pending.push(resolve)
      })
  )
  return { fetchStatus, resolveNext: (value: KnowledgeBaseStatus) => pending.shift()?.(value) }
}

describe('classifyWatched', () => {
  test('a listed file is working while pending and done in any other state', () => {
    const watched = new Map([
      ['a.pdf', 0],
      ['b.pdf', 0],
    ])
    const items = classifyWatched([file('a.pdf', 'pending'), file('b.pdf', 'failed')], watched, 1)
    expect(items.map((item) => item.phase)).toEqual(['working', 'done'])
    expect(items[1].state).toBe('failed')
  })

  test('an unlisted file is working at first and missing once the window has passed', () => {
    const watched = new Map([['ghost.pdf', 1_000]])
    expect(classifyWatched([], watched, 1_000 + MISSING_AFTER_MS - 1)[0].phase).toBe('working')
    expect(classifyWatched([], watched, 1_000 + MISSING_AFTER_MS)[0].phase).toBe('missing')
  })
})

describe('useIngestWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('a tick awaiting the status when the component unmounts schedules nothing', async () => {
    // Regression: the cleanup only cleared the timer, so a tick already awaiting
    // its fetch set state and armed a new timer after unmount.
    const { fetchStatus, resolveNext } = deferredFetch()
    const onStatus = vi.fn()
    const { result, unmount } = renderHook(() => useIngestWatch(fetchStatus, onStatus, []))

    act(() => result.current.watch(['a.pdf']))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    unmount()
    await act(async () => {
      resolveNext(status(file('a.pdf', 'pending')))
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    })

    expect(onStatus).not.toHaveBeenCalled()
    expect(fetchStatus).toHaveBeenCalledTimes(1)
  })

  test('a second upload while a tick is in flight joins the one loop', async () => {
    // Regression: each upload started its own loop over a shared watched set,
    // and the first loop to finish cleared the other's files.
    const { fetchStatus, resolveNext } = deferredFetch()
    const { result } = renderHook(() => useIngestWatch(fetchStatus, vi.fn(), []))

    act(() => result.current.watch(['a.pdf']))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(fetchStatus).toHaveBeenCalledTimes(1)

    // Second upload lands while tick 1 is still awaiting its answer.
    act(() => result.current.watch(['b.pdf']))
    // Tick 1 answers with a.pdf done: it belongs to the superseded loop, so it
    // neither ends the watch nor arms a second timer.
    await act(async () => {
      resolveNext(status(file('a.pdf', 'ingested')))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.items.map((item) => item.name)).toEqual(['a.pdf', 'b.pdf'])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    await act(async () => {
      resolveNext(status(file('a.pdf', 'ingested'), file('b.pdf', 'pending')))
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    // One loop: one more fetch per interval, not two.
    expect(fetchStatus).toHaveBeenCalledTimes(3)

    await act(async () => {
      resolveNext(status(file('a.pdf', 'ingested'), file('b.pdf', 'ingested')))
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
    })
    expect(result.current.items).toEqual([])
    expect(fetchStatus).toHaveBeenCalledTimes(3)
  })

  test('a file the status never lists ends the loop as missing instead of polling to the ceiling', async () => {
    const fetchStatus = vi.fn(async () => status(file('other.pdf', 'ingested')))
    const { result } = renderHook(() => useIngestWatch(fetchStatus, vi.fn(), []))

    act(() => result.current.watch(['ghost.pdf']))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MISSING_AFTER_MS + POLL_INTERVAL_MS)
    })

    expect(result.current.missing).toEqual(['ghost.pdf'])
    expect(result.current.items).toEqual([])
    expect(result.current.timedOut).toBe(false)
    const fetched = fetchStatus.mock.calls.length
    expect(fetched).toBeLessThan(MAX_POLLS)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5)
    })
    expect(fetchStatus).toHaveBeenCalledTimes(fetched)
  })

  test('a file still pending at the ceiling times out and can be re-armed', async () => {
    const fetchStatus = vi.fn(async () => status(file('slow.pdf', 'pending')))
    const { result } = renderHook(() =>
      useIngestWatch(fetchStatus, vi.fn(), [file('slow.pdf', 'pending')])
    )

    act(() => result.current.watch(['slow.pdf']))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * (MAX_POLLS + 2))
    })
    expect(result.current.timedOut).toBe(true)
    expect(fetchStatus).toHaveBeenCalledTimes(MAX_POLLS)

    act(() => result.current.rearm())
    expect(result.current.timedOut).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    })
    expect(fetchStatus).toHaveBeenCalledTimes(MAX_POLLS + 1)
  })
})
