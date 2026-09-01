/**
 * The first turn of a brand-new thread, which is the one case `useSharing` used
 * to get wrong.
 *
 * A conversation is created on the server lazily — `ensureServerConversation`
 * runs when its first message is persisted, and that is a list plus a create —
 * while the thread header starts asking who can read the thread the instant that
 * message appears locally. The sharing read loses that race and is answered with
 * a 404, and a single-attempt read then stayed 404 for the whole session: the
 * Share entry was missing from the menu of the chat you were actually in until
 * you refocused the tab or reloaded.
 *
 * So the property under test is convergence WITHOUT an external trigger: no
 * focus event, no live frame, no second mount. Everything here drives real
 * timers through the hook's own ladder.
 */

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ResourceSharingState } from '@/lib/sharing/types'

// The event hub owns the single EventSource. Stubbing it keeps `useLiveEvents`
// real (its focus and poll fallbacks still run) while nothing opens a connection
// — and makes "the ladder converged on its own" a claim the transport can back:
// no listener here ever fires.
const hub = vi.hoisted(() => ({
  connectionListeners: new Set<(connected: boolean) => void>(),
}))
vi.mock('../lib/event-hub', () => ({
  subscribeToEvents: () => () => {},
  subscribeToConnection: (listener: (connected: boolean) => void) => {
    // Connected: the disconnected 60s poll must NOT be what rescues these tests.
    hub.connectionListeners.add(listener)
    listener(true)
    return () => hub.connectionListeners.delete(listener)
  },
}))

import { useMentionCandidates, useSharing } from './use-sharing'

const RESOURCE_ID = 's_conv_new'
const URL = `/api/sharing/conversation/${RESOURCE_ID}`

/** The ladder in `use-sharing.ts`, summed — one advance covers every rung. */
const LADDER_MS = 500 + 1_000 + 2_000 + 4_000
const LADDER_RUNGS = 4

const sharingState = (): ResourceSharingState => ({
  resourceType: 'conversation',
  resourceId: RESOURCE_ID,
  visibility: 'private',
  allowedVisibilities: ['private', 'project', 'organization'],
  myRole: 'owner',
  canManage: true,
  canEscalate: false,
  entries: [],
  shared: false,
})

const ok = (): Response =>
  ({ ok: true, status: 200, json: async () => sharingState() }) as unknown as Response

/** What `resolveResourceAccess` answers for a resource it cannot find yet. */
const notFound = (): Response =>
  ({ ok: false, status: 404, json: async () => ({ error: 'not-found' }) }) as unknown as Response

const fetchMock = vi.fn<(input: string) => Promise<Response>>()

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockReset()
  hub.connectionListeners.clear()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/**
 * Advance fake time and let every promise it unblocks settle.
 *
 * `waitFor` is deliberately not used anywhere in this file: it schedules its own
 * timers, so under `vi.useFakeTimers()` it waits for a clock only the test can
 * move and hangs until the suite times out. Advancing explicitly is also the
 * stronger assertion — it says exactly how much time the convergence needed.
 */
const tick = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

/** Run the ladder to completion without any external trigger. */
const runLadder = () => tick(LADDER_MS)

describe('useSharing — a resource the server does not have yet', () => {
  test('converges once the conversation lands, with nothing prompting it', async () => {
    // The shape of the real race: the create round-trip finishes between the
    // first read and the second.
    fetchMock.mockResolvedValueOnce(notFound()).mockResolvedValue(ok())

    const { result } = renderHook(() => useSharing('conversation', RESOURCE_ID, true))

    // The first read is the one that used to be the only read.
    await tick(0)
    expect(result.current.state).toBeNull()

    await runLadder()

    expect(result.current.state).not.toBeNull()
    expect(result.current.state?.resourceId).toBe(RESOURCE_ID)
    expect(result.current.loadError).toBe(false)
    expect(result.current.loading).toBe(false)
  })

  test('reports loading, not failure, while the ladder is still walking', async () => {
    fetchMock.mockResolvedValue(notFound())

    const { result } = renderHook(() => useSharing('conversation', RESOURCE_ID, true))

    await tick(600)

    // A second-old thread has not gone wrong — the dialog must show its skeleton
    // here, not "could not load sharing".
    expect(result.current.loadError).toBe(false)
    expect(result.current.loading).toBe(true)
  })

  test('gives up after the ladder rather than polling a resource that is gone', async () => {
    fetchMock.mockResolvedValue(notFound())

    const { result } = renderHook(() => useSharing('conversation', RESOURCE_ID, true))

    await runLadder()
    expect(result.current.loadError).toBe(true)
    expect(result.current.loading).toBe(false)

    const attempts = fetchMock.mock.calls.length
    expect(attempts).toBe(1 + LADDER_RUNGS)

    // Ten minutes later it is still that many: the ladder ended, and the hub is
    // connected so no fallback poll runs either.
    await tick(600_000)
    expect(fetchMock).toHaveBeenCalledTimes(attempts)
  })

  test('a manual refresh walks a fresh ladder after the first one is spent', async () => {
    fetchMock.mockResolvedValue(notFound())

    const { result } = renderHook(() => useSharing('conversation', RESOURCE_ID, true))
    await runLadder()
    expect(result.current.loadError).toBe(true)

    fetchMock.mockResolvedValue(ok())
    act(() => result.current.refresh())
    await tick(0)

    expect(result.current.state).not.toBeNull()
    expect(result.current.loadError).toBe(false)
  })

  test('switching resource abandons the retry in flight', async () => {
    fetchMock.mockResolvedValue(notFound())

    const { rerender } = renderHook(
      ({ id }: { id: string }) => useSharing('conversation', id, true),
      { initialProps: { id: RESOURCE_ID } },
    )
    await tick(0)

    fetchMock.mockClear()
    fetchMock.mockResolvedValue(ok())
    rerender({ id: 's_conv_other' })
    await runLadder()

    // Every read after the switch is for the thread now on screen: a pending
    // retry for the one just left must not answer over it.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
    for (const [input] of fetchMock.mock.calls) {
      expect(input).toBe('/api/sharing/conversation/s_conv_other')
    }
  })

  test('a gated org asks nothing and schedules nothing', async () => {
    const { result } = renderHook(() => useSharing('conversation', RESOURCE_ID, false))

    await runLadder()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.state).toBeNull()
    expect(result.current.loading).toBe(false)
  })
})

describe('useSharing — the ordinary path', () => {
  test('reads once when the resource is already there', async () => {
    fetchMock.mockResolvedValue(ok())

    const { result } = renderHook(() => useSharing('conversation', RESOURCE_ID, true))

    await tick(0)
    expect(result.current.state).not.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(URL)

    await runLadder()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

/**
 * The mention picker's own read, which had NO test at all — and that absence is
 * why a fix that could not work shipped looking green.
 *
 * The reported symptom was "@ still does not work in a new window". A new window
 * nulls the conversation; typing `@` creates a CLIENT-SIDE session only, since
 * the server row is written by `_appendMessage` at send time. So every rung of
 * this ladder 404s, the hook clears its data, and the composer renders no picker
 * at all — not an empty one. Re-arming the ladder against the same missing row
 * could only 404 again, which is what the previous attempt did.
 *
 * The composer's fix is to create the row before asking. These pin the hook's
 * half of the contract: what it does with no id, and what a `restart()` against
 * a row that is still missing actually buys.
 */
const CONVERSATION_ID = 's_conv_new'
const MENTION_URL = `/api/conversations/${CONVERSATION_ID}/mention-candidates`

const candidates = (): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ kind: 'agent', id: 'agent', name: 'Piloti' }] }),
  }) as unknown as Response

describe('useMentionCandidates — before the conversation exists', () => {
  test('asks nothing at all while there is no conversation id', async () => {
    const { result } = renderHook(() => useMentionCandidates(null, true))

    await runLadder()
    act(() => result.current.restart())
    await runLadder()

    // Not one request, ever. `restart()` on a null id is a no-op, so the
    // composer cannot recover by asking harder — the ROW has to exist first.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  test('gives up after the ladder when the row is genuinely absent', async () => {
    fetchMock.mockResolvedValue(notFound())

    const { result } = renderHook(() => useMentionCandidates(CONVERSATION_ID, true))

    await runLadder()

    expect(fetchMock).toHaveBeenCalledTimes(LADDER_RUNGS + 1)
    expect(fetchMock).toHaveBeenCalledWith(MENTION_URL)
    // Null, not an empty list — and null is what makes the composer render
    // NOTHING rather than an empty picker.
    expect(result.current.data).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  test('a restart against a row that is STILL missing only burns the ladder again', async () => {
    fetchMock.mockResolvedValue(notFound())
    const { result } = renderHook(() => useMentionCandidates(CONVERSATION_ID, true))
    await runLadder()
    fetchMock.mockClear()

    act(() => result.current.restart())
    await runLadder()

    // This is the whole point: the re-arm works exactly as designed and buys
    // nothing, because nothing about the server changed between the two.
    expect(fetchMock).toHaveBeenCalledTimes(LADDER_RUNGS + 1)
    expect(result.current.data).toBeNull()
  })

  test('converges the moment the row appears, with nothing prompting it', async () => {
    // The shape of the real recovery: the composer creates the row while the
    // ladder is still climbing.
    fetchMock.mockResolvedValueOnce(notFound()).mockResolvedValue(candidates())

    const { result } = renderHook(() => useMentionCandidates(CONVERSATION_ID, true))

    await runLadder()

    expect(result.current.data).not.toBeNull()
    expect(result.current.loading).toBe(false)
  })

  test('a gated org asks nothing and schedules nothing', async () => {
    const { result } = renderHook(() => useMentionCandidates(CONVERSATION_ID, false))

    await runLadder()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.data).toBeNull()
  })
})
