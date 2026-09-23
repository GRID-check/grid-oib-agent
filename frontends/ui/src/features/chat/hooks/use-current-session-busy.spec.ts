/**
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ChatState, Conversation, PendingInteraction } from '../types'
import { emptyRunLedger, setRunStatus } from '@/lib/runs/run-ledger'

/**
 * The slice of the chat store this hook actually selects from. Deriving it
 * from `ChatState` means a rename or a type change in the store surfaces here
 * as a compile error rather than as a test that silently stops exercising the
 * real shape.
 */
type BusySlice = Pick<ChatState, 'isStreaming' | 'currentConversation' | 'pendingInteraction'>

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

const makePendingInteraction = (
  overrides: Partial<PendingInteraction> = {}
): PendingInteraction => ({
  id: 'interaction-1',
  parentId: 'msg-1',
  inputType: 'binary_choice',
  text: 'Approve this plan?',
  ...overrides,
})

vi.mock('../store', () => ({
  useChatStore: vi.fn(),
}))

const idleState: BusySlice = {
  isStreaming: false,
  currentConversation: makeConversation(),
  pendingInteraction: null,
}

import { useChatStore } from '../store'
import { useIsCurrentSessionBusy } from './use-current-session-busy'

const mockUseChatStore = useChatStore as unknown as ReturnType<typeof vi.fn>

const withState = (state: BusySlice): void => {
  mockUseChatStore.mockImplementation((selector: BusySelector) => selector(state))
}

describe('useIsCurrentSessionBusy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is idle when nothing is happening', () => {
    withState(idleState)
    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(false)
  })

  it('is busy while the socket streams a turn', () => {
    withState({ ...idleState, isStreaming: true })
    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(true)
  })

  it('is busy while a HITL prompt waits for an answer', () => {
    withState({ ...idleState, pendingInteraction: makePendingInteraction() })
    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(true)
  })

  it('is NOT busy because a run is going in the thread', () => {
    // The run is a message with its own stop control (ADR-0062); the person
    // keeps chatting beside it, and a lost terminal event must not lock the
    // session.
    withState({
      ...idleState,
      currentConversation: makeConversation({
        messages: [
          {
            id: 'run-1',
            role: 'assistant',
            content: '',
            timestamp: new Date('2026-01-01T00:00:00Z'),
            messageType: 'agent_response',
            runLedger: setRunStatus(emptyRunLedger('run-1'), 'laeuft'),
          },
        ],
      }),
    })
    const { result } = renderHook(() => useIsCurrentSessionBusy())
    expect(result.current).toBe(false)
  })
})
