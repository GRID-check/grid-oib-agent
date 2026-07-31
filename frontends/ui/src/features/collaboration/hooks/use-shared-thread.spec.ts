/**
 * Tests for the ADR-0033 seam.
 *
 * The two properties worth the most here are the ones a reviewer cannot see by
 * reading the component tree:
 *
 *  - **A private thread is untouched** (spec NF-8) — no live subscription, no
 *    message request, no store write. That is asserted at the transport level:
 *    `subscribeToEvents` (the shared `EventSource`) and `fetch` are spied on, so a
 *    regression that "only" adds a request cannot pass.
 *  - **Correctness never depends on an event arriving** (spec CC-10 / RT-4). The
 *    convergence tests drive a real `window.focus` through the real
 *    `useLiveEvents` fallback rather than calling a refresh function, so the path
 *    that actually saves a dropped event is the path under test.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CollaborationEvent } from '@/lib/events/types'

const mockDeepResearchApi = vi.hoisted(() => ({
  getJobStatus: vi.fn().mockResolvedValue(undefined),
  cancelJob: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/adapters/api/deep-research-client', () => ({
  getJobStatus: mockDeepResearchApi.getJobStatus,
  cancelJob: mockDeepResearchApi.cancelJob,
}))

// The event hub owns the single EventSource. Spying on it is how "no subscription"
// becomes a testable claim, and how a live frame is delivered through the real
// `useLiveEvents` plumbing.
const hub = vi.hoisted(() => ({
  listeners: new Set<(event: CollaborationEvent) => void>(),
  subscribeToEvents: vi.fn(),
  subscribeToConnection: vi.fn(),
}))
vi.mock('../lib/event-hub', () => ({
  subscribeToEvents: (listener: (event: CollaborationEvent) => void) => {
    hub.subscribeToEvents(listener)
    hub.listeners.add(listener)
    return () => hub.listeners.delete(listener)
  },
  subscribeToConnection: (listener: (connected: boolean) => void) => {
    hub.subscribeToConnection(listener)
    listener(true)
    return () => {}
  },
}))

import { useChatStore } from '@/features/chat/store'
import { getThreadSharing, resetThreadSharing } from '@/shared/collaboration/thread-sharing'
import { useSharedThread } from './use-shared-thread'

const CONVERSATION_ID = 's_conv_shared'
const ME = 'user_me'
const ANNA = 'user_anna'

const at = (minute: number): string => `2026-07-29T09:0${minute}:00.000Z`

const row = (
  id: string,
  overrides: Partial<{
    role: string
    authorUserId: string | null
    content: string
    createdAt: string
    metadata: Record<string, unknown>
  }> = {}
) => ({
  id,
  conversationId: CONVERSATION_ID,
  role: 'user',
  authorUserId: ME,
  content: `message ${id}`,
  metadata: { messageType: 'user' },
  createdAt: at(1),
  ...overrides,
})

const ROSTER = {
  resourceType: 'conversation',
  resourceId: CONVERSATION_ID,
  visibility: 'project',
  allowedVisibilities: ['private', 'project'],
  myRole: 'collaborator',
  canManage: false,
  canEscalate: false,
  shared: true,
  entries: [
    {
      person: { userId: ME, name: 'Me Myself', email: null, profilePictureUrl: null },
      role: 'owner',
      reason: 'creator',
      grantedBy: null,
    },
    {
      person: { userId: ANNA, name: 'Anna Berger', email: null, profilePictureUrl: 'https://x/a.png' },
      role: 'collaborator',
      reason: 'grant',
      grantedBy: ME,
    },
  ],
}

interface RouteState {
  shared: boolean
  lastReadMessageId: string | null
  messages: ReturnType<typeof row>[]
}

let routes: RouteState
let fetchMock: ReturnType<typeof vi.fn>

/** Requests issued during the test, so "no extra fetch" is assertable. */
const requested = (): string[] =>
  fetchMock.mock.calls.map((call) => String(call[0]))

const seedStore = (messages: Array<{ id: string; content: string; timestamp: Date }> = []) => {
  const conversation = {
    id: CONVERSATION_ID,
    userId: ME,
    projectId: 'p1',
    title: 'Brandschutz',
    messages: messages.map((message) => ({
      id: message.id,
      role: 'user' as const,
      content: message.content,
      timestamp: message.timestamp,
      messageType: 'user' as const,
    })),
    createdAt: new Date(at(0)),
    updatedAt: new Date(at(0)),
  }
  useChatStore.setState({
    currentUserId: ME,
    conversations: [conversation],
    currentConversation: conversation,
  })
}

const storedMessages = () =>
  useChatStore.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.messages ?? []

const emit = async (event: CollaborationEvent) => {
  await act(async () => {
    for (const listener of hub.listeners) listener(event)
  })
}

beforeEach(() => {
  hub.listeners.clear()
  hub.subscribeToEvents.mockClear()
  hub.subscribeToConnection.mockClear()

  routes = { shared: true, lastReadMessageId: null, messages: [row('m1')] }

  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url === `/api/conversations/${CONVERSATION_ID}`) {
      return Response.json({
        id: CONVERSATION_ID,
        title: 'Brandschutz',
        shared: routes.shared,
        myRole: 'collaborator',
        visibility: routes.shared ? 'project' : 'private',
        myReadState: routes.lastReadMessageId
          ? { lastReadAt: at(1), lastReadMessageId: routes.lastReadMessageId }
          : null,
      })
    }
    if (url === `/api/conversations/${CONVERSATION_ID}/messages`) {
      return Response.json(routes.messages)
    }
    if (url === `/api/sharing/conversation/${CONVERSATION_ID}`) {
      return Response.json(ROSTER)
    }
    if (url === `/api/conversations/${CONVERSATION_ID}/read`) {
      return Response.json({ ok: true })
    }
    throw new Error(`unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  seedStore()
})

afterEach(() => {
  vi.unstubAllGlobals()
  useChatStore.setState({ conversations: [], currentConversation: null, currentUserId: null })
})

describe('useSharedThread — the private path is untouched (spec NF-8)', () => {
  test('does nothing at all when collaboration is disabled: no fetch, no subscription', async () => {
    seedStore([{ id: 'local-1', content: 'my private note', timestamp: new Date(at(1)) }])

    const { result } = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: false, currentUserId: ME })
    )

    // Give any effect a chance to misbehave before asserting the absence.
    await act(async () => {
      await Promise.resolve()
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(hub.subscribeToEvents).not.toHaveBeenCalled()
    expect(result.current.shared).toBe(false)
    expect(result.current.turnInFlight).toBeNull()
    // The local-first copy is exactly as it was.
    expect(storedMessages().map((m) => m.id)).toEqual(['local-1'])
  })

  test('a conversation the server reports as private loads no history and opens no channel', async () => {
    routes.shared = false
    seedStore([{ id: 'local-1', content: 'my private note', timestamp: new Date(at(1)) }])

    const { result } = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await act(async () => {
      await Promise.resolve()
    })

    // Exactly ONE request: the access read that decides which path applies.
    // Sharedness is a server-computed fact, so it cannot be known without asking —
    // but nothing follows from it here.
    expect(requested()).toEqual([`/api/conversations/${CONVERSATION_ID}`])
    expect(hub.subscribeToEvents).not.toHaveBeenCalled()
    expect(result.current.shared).toBe(false)
    expect(storedMessages().map((m) => m.id)).toEqual(['local-1'])
  })

  test('subscribes only once the server has confirmed the thread is shared', async () => {
    const { result } = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await waitFor(() => expect(result.current.shared).toBe(true))
    expect(hub.subscribeToEvents).toHaveBeenCalled()
  })
})

describe('useSharedThread — the server is authoritative', () => {
  test('replaces the local copy with the server history on open', async () => {
    // A stale local-first thread: one message the server does not have, and none
    // of the colleague's.
    seedStore([{ id: 'stale', content: 'written before sharing', timestamp: new Date(at(1)) }])
    routes.messages = [
      row('m1', { createdAt: at(2), content: 'my question' }),
      row('m2', { role: 'assistant', authorUserId: null, createdAt: at(3), content: 'the answer' }),
      row('m3', { authorUserId: ANNA, createdAt: at(4), content: "Anna's addition" }),
    ]

    const { result } = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await waitFor(() => expect(storedMessages()).toHaveLength(3))
    expect(storedMessages().map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(result.current.shared).toBe(true)
  })

  test('orders by server timestamp with the message id as the tiebreak (spec CC-11)', async () => {
    routes.messages = [
      row('b', { createdAt: at(3) }),
      row('a', { createdAt: at(3) }),
      row('c', { createdAt: at(2) }),
    ]

    renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await waitFor(() => expect(storedMessages()).toHaveLength(3))
    expect(storedMessages().map((m) => m.id)).toEqual(['c', 'a', 'b'])
  })

  test('resolves author names and avatars from the conversation roster', async () => {
    routes.messages = [row('m1', { authorUserId: ANNA, createdAt: at(2) })]

    const { result } = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await waitFor(() => expect(storedMessages()).toHaveLength(1))
    await waitFor(() => expect(storedMessages()[0].authorName).toBe('Anna Berger'))
    expect(storedMessages()[0].authorUserId).toBe(ANNA)
    expect(storedMessages()[0].authorAvatarUrl).toBe('https://x/a.png')
    expect(result.current.authorOf(ANNA)?.name).toBe('Anna Berger')
  })

  test('keeps the in-flight streaming bubble the server has not been told about', async () => {
    useChatStore.setState({
      conversations: [
        {
          id: CONVERSATION_ID,
          userId: ME,
          projectId: 'p1',
          title: 'Brandschutz',
          messages: [
            {
              id: 'live-answer',
              role: 'assistant',
              content: 'partial…',
              timestamp: new Date(at(1)),
              messageType: 'agent_response',
              isStreaming: true,
            },
          ],
          createdAt: new Date(at(0)),
          updatedAt: new Date(at(0)),
        },
      ],
      currentConversation: null,
      currentUserId: ME,
    })
    routes.messages = [row('m1', { createdAt: at(4) })]

    renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await waitFor(() => expect(storedMessages().some((m) => m.id === 'm1')).toBe(true))
    expect(storedMessages().map((m) => m.id)).toContain('live-answer')
  })
})

describe('useSharedThread — reconciliation', () => {
  test("a colleague's message arrives on the event, deduplicated against our own echo", async () => {
    routes.messages = [row('m1', { createdAt: at(2) })]

    renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )
    await waitFor(() => expect(storedMessages()).toHaveLength(1))

    // Anna writes. The event is only a hint: the hook re-reads.
    routes.messages = [...routes.messages, row('m2', { authorUserId: ANNA, createdAt: at(3) })]
    await emit({
      kind: 'conversation.message',
      conversationId: CONVERSATION_ID,
      authorUserId: ANNA,
      messageId: 'm2',
    })

    await waitFor(() => expect(storedMessages()).toHaveLength(2))
    // The same event again (a duplicate frame, or a second reader's refresh) must
    // not double-render it.
    await emit({
      kind: 'conversation.message',
      conversationId: CONVERSATION_ID,
      authorUserId: ANNA,
      messageId: 'm2',
    })
    await waitFor(() => expect(storedMessages()).toHaveLength(2))
    expect(storedMessages().filter((m) => m.id === 'm2')).toHaveLength(1)
  })

  /**
   * A self-authored event is NOT skipped: the same event fires for a message we
   * sent from a second device, where this tab holds no optimistic echo of it. The
   * id-keyed merge is what makes the re-read free on the device that wrote it, so
   * the refetch is the cheap way to be correct on the other one.
   */
  test('re-reads for our own write too — the second device has no echo', async () => {
    renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )
    await waitFor(() => expect(storedMessages()).toHaveLength(1))
    const before = requested().length

    // Written elsewhere by us: only the server knows about it.
    routes.messages = [...routes.messages, row('mine', { authorUserId: ME, createdAt: at(3) })]
    await emit({
      kind: 'conversation.message',
      conversationId: CONVERSATION_ID,
      authorUserId: ME,
      messageId: 'mine',
    })

    expect(requested().slice(before)).toContain(
      `/api/conversations/${CONVERSATION_ID}/messages`,
    )
    await waitFor(() => expect(storedMessages()).toHaveLength(2))
    // …and the echo case stays a no-op on screen: one row, not two.
    expect(storedMessages().filter((m) => m.id === 'mine')).toHaveLength(1)
  })

  test('ignores events for a different conversation', async () => {
    renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )
    await waitFor(() => expect(storedMessages()).toHaveLength(1))
    const before = requested().length

    await emit({
      kind: 'conversation.message',
      conversationId: 's_other',
      authorUserId: ANNA,
      messageId: 'x',
    })

    expect(requested()).toHaveLength(before)
  })

  test('converges on window focus alone, with no event at all (spec CC-10, RT-4)', async () => {
    renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )
    await waitFor(() => expect(storedMessages()).toHaveLength(1))

    // Anna wrote while the tab was in the background and the event was dropped.
    routes.messages = [...routes.messages, row('m9', { authorUserId: ANNA, createdAt: at(5) })]

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(storedMessages().map((m) => m.id)).toContain('m9'))
  })

  test('announces an arrival, but is silent about the history it opened with', async () => {
    routes.messages = [row('m1', { authorUserId: ANNA, createdAt: at(2) })]

    const { result } = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )
    await waitFor(() => expect(storedMessages()).toHaveLength(1))
    // Opening a thread must not read a colleague's name out: that is history, not
    // an arrival.
    expect(result.current.lastArrival).toBeNull()

    routes.messages = [...routes.messages, row('m2', { authorUserId: ANNA, createdAt: at(3) })]
    await emit({
      kind: 'conversation.message',
      conversationId: CONVERSATION_ID,
      authorUserId: ANNA,
      messageId: 'm2',
    })

    await waitFor(() => expect(result.current.lastArrival?.messageId).toBe('m2'))
    expect(result.current.lastArrival?.authorName).toBe('Anna Berger')
  })

  test('exposes who the agent is working for, and clears it when the turn ends', async () => {
    const { result } = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )
    await waitFor(() => expect(result.current.shared).toBe(true))

    await emit({
      kind: 'conversation.turn',
      conversationId: CONVERSATION_ID,
      phase: 'started',
      actorUserId: ANNA,
    })
    expect(result.current.turnInFlight).toEqual({ actorUserId: ANNA })

    await emit({
      kind: 'conversation.turn',
      conversationId: CONVERSATION_ID,
      phase: 'ended',
      actorUserId: ANNA,
    })
    await waitFor(() => expect(result.current.turnInFlight).toBeNull())
  })

  test('picks up the server-authoritative path when a thread that was private is re-opened', async () => {
    // The documented cost of NF-8's strictness: a private thread listens for
    // nothing, so it learns it has been shared on the next open rather than
    // instantly. What must NOT happen is that it stays on the local-first path
    // afterwards.
    routes.shared = false
    const first = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(first.result.current.shared).toBe(false)
    expect(hub.subscribeToEvents).not.toHaveBeenCalled()
    first.unmount()

    routes.shared = true
    const second = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await waitFor(() => expect(second.result.current.shared).toBe(true))
    await waitFor(() => expect(storedMessages()).toHaveLength(1))
    expect(hub.subscribeToEvents).toHaveBeenCalled()
  })

  test('a shared thread that becomes shared-then-changed re-reads the access fact on the event', async () => {
    const { result } = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )
    await waitFor(() => expect(result.current.shared).toBe(true))
    const before = requested().length

    await emit({
      kind: 'resource.access.changed',
      resourceType: 'conversation',
      resourceId: CONVERSATION_ID,
      change: 'visibility',
    })

    // Sharing changes which PATH applies, so the access fact is re-read — not just
    // the message list.
    await waitFor(() =>
      expect(requested().slice(before)).toContain(`/api/conversations/${CONVERSATION_ID}`)
    )
  })

  test('access revoked between the access read and the history read is still flagged', async () => {
    // The race the initial load used to drop: the access read says "shared", the
    // history read that follows it is denied. Nothing in the first read can know
    // that, so the denial has to escalate to a second access read — otherwise the
    // reader keeps a live-looking composer over a thread they can no longer read.
    let accessReads = 0
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === `/api/conversations/${CONVERSATION_ID}`) {
        accessReads += 1
        if (accessReads === 1) {
          return Response.json({
            id: CONVERSATION_ID,
            title: 'Brandschutz',
            shared: true,
            myRole: 'collaborator',
            visibility: 'project',
            myReadState: null,
          })
        }
        return new Response(null, { status: 403 })
      }
      if (url === `/api/conversations/${CONVERSATION_ID}/messages`) {
        return new Response(null, { status: 403 })
      }
      if (url === `/api/sharing/conversation/${CONVERSATION_ID}`) return Response.json(ROSTER)
      throw new Error(`unexpected request: ${url}`)
    })

    const { result } = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await waitFor(() => expect(result.current.accessLost).toBe(true))
    expect(result.current.shared).toBe(false)
    // Exactly one revalidation: the second read is never escalated again, so a
    // server that keeps denying cannot turn this into a request loop.
    expect(accessReads).toBe(2)
  })
})

describe('useSharedThread — read state', () => {
  test('exposes the unread anchor the reader arrived with (spec CC-19)', async () => {
    routes.lastReadMessageId = 'm1'
    routes.messages = [row('m1', { createdAt: at(2) }), row('m2', { authorUserId: ANNA, createdAt: at(3) })]

    const { result } = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await waitFor(() => expect(result.current.unreadAfterMessageId).toBe('m1'))
  })

  test('marks the thread read once, debounced, with the newest message id', async () => {
    vi.useFakeTimers()
    try {
      routes.messages = [row('m1', { createdAt: at(2) }), row('m2', { authorUserId: ANNA, createdAt: at(3) })]

      renderHook(() =>
        useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      // Nothing yet: a read receipt per message would be one POST per arrival.
      expect(requested()).not.toContain(`/api/conversations/${CONVERSATION_ID}/read`)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000)
      })

      const reads = fetchMock.mock.calls.filter(
        (call) => String(call[0]) === `/api/conversations/${CONVERSATION_ID}/read`
      )
      expect(reads).toHaveLength(1)
      expect(JSON.parse(String((reads[0][1] as RequestInit).body))).toEqual({
        lastReadMessageId: 'm2',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  test('does not mark read while the thread is not on screen', async () => {
    vi.useFakeTimers()
    try {
      renderHook(() =>
        useSharedThread({
          conversationId: CONVERSATION_ID,
          enabled: true,
          currentUserId: ME,
          active: false,
        })
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000)
      })

      expect(requested()).not.toContain(`/api/conversations/${CONVERSATION_ID}/read`)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * The seam publishes sharedness for the composer's agent socket.
 *
 * `useWebSocketChat` has to know whether opening a socket on mount could collide
 * with another participant's, and this access read is the only place that fact is
 * learned (ADR-0033 §1). It lives in a sibling component, so the answer is handed
 * over through the registry rather than re-fetched.
 */
describe('useSharedThread — sharedness is published for the agent-socket gate', () => {
  beforeEach(() => {
    resetThreadSharing()
  })

  test('a shared thread is published as shared', async () => {
    routes.shared = true

    renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await waitFor(() => expect(getThreadSharing(CONVERSATION_ID)).toBe('shared'))
  })

  test('a private thread is published as private, so its socket still opens on mount', async () => {
    routes.shared = false

    renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await waitFor(() => expect(getThreadSharing(CONVERSATION_ID)).toBe('private'))
  })

  test('collaboration disabled publishes nothing — the gate must not need this hook at all', async () => {
    renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: false, currentUserId: ME })
    )

    await act(async () => {
      await Promise.resolve()
    })

    // `unknown`, and the gate treats a gated org as connect-on-mount on its own.
    expect(getThreadSharing(CONVERSATION_ID)).toBe('unknown')
  })

  test('a failed access read publishes nothing rather than guessing "private"', async () => {
    // Guessing private here would re-open the two-participant socket collision.
    // Staying `unknown` only defers the connect to composer focus.
    fetchMock.mockImplementation(async () => {
      throw new Error('offline')
    })

    renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(getThreadSharing(CONVERSATION_ID)).toBe('unknown')
  })
})

describe('useSharedThread — composing presence', () => {
  /** Mount a shared thread and wait for its first load to settle. */
  const mountShared = async () => {
    const hook = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )
    await waitFor(() => expect(hook.result.current.shared).toBe(true))
    await waitFor(() => expect(hook.result.current.participants.length).toBeGreaterThan(0))
    return hook
  }

  const typing = (userId: string, isTyping: boolean, ttlMs = 6_000): CollaborationEvent => ({
    kind: 'conversation.typing',
    conversationId: CONVERSATION_ID,
    userId,
    typing: isTyping,
    ttlMs,
  })

  test('names a colleague who is composing, resolved from the roster', async () => {
    const { result } = await mountShared()

    await emit(typing(ANNA, true))

    await waitFor(() => expect(result.current.typists).toHaveLength(1))
    expect(result.current.typists[0].userId).toBe(ANNA)
    expect(result.current.typists[0].name).toBeTruthy()
  })

  test('a withdrawal clears the claim immediately', async () => {
    const { result } = await mountShared()

    await emit(typing(ANNA, true))
    await waitFor(() => expect(result.current.typists).toHaveLength(1))

    await emit(typing(ANNA, false))
    await waitFor(() => expect(result.current.typists).toHaveLength(0))
  })

  test('a claim whose withdrawal never arrives expires on its own', async () => {
    // The failure this prevents is a colleague left permanently "about to
    // answer" because their tab was closed mid-word. There is no fetch behind
    // presence, so the expiry is the ONLY thing that heals it.
    const { result } = await mountShared()

    await emit(typing(ANNA, true, 20))
    await waitFor(() => expect(result.current.typists).toHaveLength(1))

    await waitFor(() => expect(result.current.typists).toHaveLength(0), { timeout: 3_000 })
  })

  test('never reports the reader as typing', async () => {
    // The publisher already drops the actor's own echo; this is the second line
    // of defence, because "you are typing" is the one failure everybody notices
    // and nobody reports.
    const { result } = await mountShared()

    await emit(typing(ME, true))

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.typists).toHaveLength(0)
  })

  test('ignores presence for a different conversation', async () => {
    const { result } = await mountShared()

    await emit({
      kind: 'conversation.typing',
      conversationId: 'some_other_conversation',
      userId: ANNA,
      typing: true,
      ttlMs: 6_000,
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.typists).toHaveLength(0)
  })

  test('presence costs a private thread no requests', async () => {
    routes.shared = false
    const { result } = renderHook(() =>
      useSharedThread({ conversationId: CONVERSATION_ID, enabled: true, currentUserId: ME })
    )
    await waitFor(() => expect(result.current.shared).toBe(false))

    await emit(typing(ANNA, true))

    // No roster to resolve against and no subscription that could have carried
    // it — the private path stays exactly as cheap as it was (spec NF-8).
    expect(result.current.typists).toHaveLength(0)
    expect(requested()).not.toContain(`/api/sharing/conversation/${CONVERSATION_ID}`)
  })
})
