/**
 * Tests for useIsCurrentSessionBusy hook
 *
 * Tests cover three categories:
 * 1. Ephemeral state (normal operation — isStreaming, SSE, deepResearchStatus)
 * 2. Persisted state (page refresh recovery — message history, pendingInteraction)
 * 3. Combined state (ephemeral + persisted together)
 */

import { renderHook } from '@testing-library/react'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { useIsCurrentSessionBusy } from './use-current-session-busy'
import { useChatStore } from '../store'
import type { ChatState, Conversation, PendingInteraction } from '../types'

/**
 * The slice of the chat store this hook actually selects from. Deriving it
 * from `ChatState` means a rename or a type change in the store surfaces here
 * as a compile error rather than as a test that silently stops exercising the
 * real shape.
 */
type BusySlice = Pick<
  ChatState,
  | 'isStreaming'
  | 'isDeepResearchStreaming'
  | 'deepResearchStatus'
  | 'currentConversation'
  | 'pendingInteraction'
>

/** A zustand selector as the hook calls it, narrowed to the slice above. */
type BusySelector = (state: BusySlice) => unknown

const makeConversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'conv-1',
  userId: 'user-1',
  title: 'Test session',
  messages: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
})

/**
 * The hook only asks whether a pending interaction exists, but the fixture is
 * a complete one so it cannot drift out of shape unnoticed.
 */
const makePendingInteraction = (
  overrides: Partial<PendingInteraction> = {},
): PendingInteraction => ({
  id: 'interaction-1',
  parentId: 'msg-1',
  inputType: 'binary_choice',
  text: 'Approve this plan?',
  ...overrides,
})

// Mock the chat store
vi.mock('../store', () => ({
  useChatStore: vi.fn(),
}))

// Mock the session-activity utility (pure functions tested separately)
vi.mock('../lib/session-activity', () => ({
  hasActiveDeepResearchJob: vi.fn(() => false),
}))

import { hasActiveDeepResearchJob } from '../lib/session-activity'
const mockHasActiveJob = hasActiveDeepResearchJob as unknown as ReturnType<typeof vi.fn>

/**
 * Default idle state — all flags off, no persisted activity.
 */
const idleState: BusySlice = {
  isStreaming: false,
  isDeepResearchStreaming: false,
  deepResearchStatus: null,
  currentConversation: makeConversation(),
  pendingInteraction: null,
}

describe('useIsCurrentSessionBusy', () => {
  const mockUseChatStore = useChatStore as unknown as ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockHasActiveJob.mockReturnValue(false)
  })

  // ─── Ephemeral State Tests ─────────────────────────────────────

  it('returns false when no operations are active', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector(idleState)
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(false)
  })

  it('returns true when WebSocket is streaming (shallow thinking)', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({ ...idleState, isStreaming: true })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(true)
  })

  it('returns true when deep research SSE is streaming', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({ ...idleState, isDeepResearchStreaming: true, deepResearchStatus: 'running' })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(true)
  })

  it('returns true when deep research status is "submitted"', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({ ...idleState, deepResearchStatus: 'submitted' })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(true)
  })

  it('returns true when deep research status is "running"', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({ ...idleState, deepResearchStatus: 'running' })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(true)
  })

  it('returns false when deep research status is "success" (terminal state)', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({ ...idleState, deepResearchStatus: 'success' })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(false)
  })

  it('returns false when deep research status is "failure" (terminal state)', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({ ...idleState, deepResearchStatus: 'failure' })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(false)
  })

  it('returns false when deep research status is "interrupted" (terminal state)', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({ ...idleState, deepResearchStatus: 'interrupted' })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(false)
  })

  it('returns true when both shallow and deep research are active', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({
        ...idleState,
        isStreaming: true,
        isDeepResearchStreaming: true,
        deepResearchStatus: 'running',
      })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(true)
  })

  // ─── Persisted State Tests (Page Refresh Recovery) ─────────────

  it('returns true when message history has active deep research job (refresh scenario)', () => {
    // Simulate page refresh: ephemeral state is reset, but persisted messages indicate active job
    mockHasActiveJob.mockReturnValue(true)

    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector(idleState) // All ephemeral state is idle
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(true)
  })

  it('returns true when pending HITL interaction exists (refresh scenario)', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({
        ...idleState,
        pendingInteraction: makePendingInteraction(),
      })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(true)
  })

  it('returns false when currentConversation is null', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({ ...idleState, currentConversation: null })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(false)
  })

  // ─── Combined State Tests ──────────────────────────────────────

  it('returns true when both ephemeral streaming and persisted HITL are active', () => {
    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({
        ...idleState,
        isStreaming: true,
        pendingInteraction: makePendingInteraction(),
      })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(true)
  })

  it('returns true when ephemeral is idle but both persisted flags are active', () => {
    mockHasActiveJob.mockReturnValue(true)

    mockUseChatStore.mockImplementation((selector: BusySelector) =>
      selector({
        ...idleState,
        pendingInteraction: makePendingInteraction(),
      })
    )

    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(true)
  })
})
