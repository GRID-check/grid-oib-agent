import { renderHook, act, waitFor } from '@testing-library/react'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { useDeepResearch } from './use-deep-research'
import { en } from '@/i18n/dictionaries/en'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { ChatStoreWithHydration } from '../store'
import type { LayoutStore } from '@/features/layout/types'

// ============================================================
// Mock store state and actions
// ============================================================

const mockUpdateDeepResearchStatus = vi.fn()
const mockCompleteDeepResearch = vi.fn()
const mockAddDeepResearchCitation = vi.fn()
const mockSetReportContent = vi.fn()
const mockAddThinkingStep = vi.fn(() => 'step-1')
const mockAppendToThinkingStep = vi.fn()
const mockCompleteThinkingStep = vi.fn()
const mockSetCurrentStatus = vi.fn()
const mockSetStreaming = vi.fn()
const mockSetDeepResearchTodos = vi.fn()
const mockStopDeepResearchTodos = vi.fn()
const mockStopAllDeepResearchSpinners = vi.fn()
const mockSetDeepResearchLastEventId = vi.fn()
const mockAddDeepResearchLLMStep = vi.fn(() => 'llm-step-1')
const mockAppendToDeepResearchLLMStep = vi.fn()
const mockCompleteDeepResearchLLMStep = vi.fn()
const mockAddDeepResearchAgent = vi.fn(() => 'agent-1')
const mockAddDeepResearchAgentWithId = vi.fn(() => 'agent-1')
const mockCompleteDeepResearchAgent = vi.fn()
const mockAddDeepResearchToolCall = vi.fn(() => 'tool-call-1')
const mockCompleteDeepResearchToolCall = vi.fn()
const mockAddDeepResearchFile = vi.fn()
const mockAddAgentResponse = vi.fn()
const mockAddErrorCard = vi.fn()
const mockPatchConversationMessage = vi.fn()
const mockPersistDeepResearchToSession = vi.fn()
const mockAddDeepResearchBanner = vi.fn()
const mockRecordDeepResearchFiling = vi.fn()
const mockRecordDeepResearchFilingFailure = vi.fn()
const mockSetStreamLoaded = vi.fn()
const mockSetDeepResearchStalled = vi.fn()
const mockSetDeepResearchConnectionLost = vi.fn()
const mockSetReconnectDeepResearchFn = vi.fn()

// Typed against the real store rather than a hand-copied shape, so the status
// fixtures below are checked against `DeepResearchJobStatus` instead of `string`.
let mockStoreState: DeepPartial<ChatStoreWithHydration> = {
  deepResearchJobId: null,
  deepResearchLastEventId: null,
  isDeepResearchStreaming: false,
  deepResearchStatus: null,
  reportContent: '',
  deepResearchAgents: [],
  deepResearchLLMSteps: [],
  deepResearchToolCalls: [],
  deepResearchCitations: [],
  deepResearchOwnerConversationId: 'test-conv-123',
  currentConversation: { id: 'test-conv-123' },
  activeDeepResearchMessageId: null,
  currentUserMessageId: 'user-msg-1',
}

vi.mock('../store', () => ({
  useChatStore: Object.assign(
    vi.fn((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: DeepPartial<ChatStoreWithHydration> = {
        ...mockStoreState,
        updateDeepResearchStatus: mockUpdateDeepResearchStatus,
        completeDeepResearch: mockCompleteDeepResearch,
        addDeepResearchCitation: mockAddDeepResearchCitation,
        setReportContent: mockSetReportContent,
        addThinkingStep: mockAddThinkingStep,
        appendToThinkingStep: mockAppendToThinkingStep,
        completeThinkingStep: mockCompleteThinkingStep,
        setCurrentStatus: mockSetCurrentStatus,
        setStreaming: mockSetStreaming,
        setDeepResearchTodos: mockSetDeepResearchTodos,
        stopDeepResearchTodos: mockStopDeepResearchTodos,
        stopAllDeepResearchSpinners: mockStopAllDeepResearchSpinners,
        setDeepResearchLastEventId: mockSetDeepResearchLastEventId,
        addDeepResearchLLMStep: mockAddDeepResearchLLMStep,
        appendToDeepResearchLLMStep: mockAppendToDeepResearchLLMStep,
        completeDeepResearchLLMStep: mockCompleteDeepResearchLLMStep,
        addDeepResearchAgent: mockAddDeepResearchAgent,
        addDeepResearchAgentWithId: mockAddDeepResearchAgentWithId,
        completeDeepResearchAgent: mockCompleteDeepResearchAgent,
        addDeepResearchToolCall: mockAddDeepResearchToolCall,
        completeDeepResearchToolCall: mockCompleteDeepResearchToolCall,
        addDeepResearchFile: mockAddDeepResearchFile,
        addAgentResponse: mockAddAgentResponse,
        patchConversationMessage: mockPatchConversationMessage,
        persistDeepResearchToSession: mockPersistDeepResearchToSession,
        addDeepResearchBanner: mockAddDeepResearchBanner,
        recordDeepResearchFiling: mockRecordDeepResearchFiling,
        recordDeepResearchFilingFailure: mockRecordDeepResearchFilingFailure,
        setStreamLoaded: mockSetStreamLoaded,
        setDeepResearchStalled: mockSetDeepResearchStalled,
        setDeepResearchConnectionLost: mockSetDeepResearchConnectionLost,
        setReconnectDeepResearchFn: mockSetReconnectDeepResearchFn,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    }),
    {
      getState: vi.fn(() => ({
        ...mockStoreState,
        addErrorCard: mockAddErrorCard,
        addDeepResearchBanner: mockAddDeepResearchBanner,
        stopAllDeepResearchSpinners: mockStopAllDeepResearchSpinners,
        patchConversationMessage: mockPatchConversationMessage,
        completeDeepResearch: mockCompleteDeepResearch,
        setStreaming: mockSetStreaming,
        setStreamLoaded: mockSetStreamLoaded,
      })),
      setState: vi.fn((updater: (state: typeof mockStoreState) => Partial<typeof mockStoreState>) => {
        if (typeof updater === 'function') {
          const updates = updater(mockStoreState)
          Object.assign(mockStoreState, updates)
        }
      }),
    }
  ),
}))

// Mock layout store
const mockOpenRightPanel = vi.fn()
const mockSetResearchPanelTab = vi.fn()

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: vi.fn((selector?: StoreSelector<LayoutStore>) => {
    const state: DeepPartial<LayoutStore> = {
      openRightPanel: mockOpenRightPanel,
      setResearchPanelTab: mockSetResearchPanelTab,
    }
    return selector ? selector(asStoreState<LayoutStore>(state)) : state
  }),
}))

// Mock auth hook
vi.mock('@/adapters/auth', () => ({
  useAuth: vi.fn(() => ({
    idToken: 'mock-id-token',
  })),
}))

// Mock backend health check
const mockCheckBackendHealthCached = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
vi.mock('@/shared/hooks/use-backend-health', () => ({
  checkBackendHealthCached: () => mockCheckBackendHealthCached(),
  invalidateHealthCache: vi.fn(),
}))

// ============================================================
// Mock deep research client
// ============================================================

interface MockClient {
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  isConnected: ReturnType<typeof vi.fn>
  getLastEventId: ReturnType<typeof vi.fn>
  callbacks: Record<string, (...args: unknown[]) => void>
}

let mockClient: MockClient | null = null
const mockCreateDeepResearchClient = vi.fn((options: { callbacks: Record<string, (...args: unknown[]) => void> }) => {
  mockClient = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => false),
    getLastEventId: vi.fn(() => null),
    callbacks: options.callbacks,
  }
  return mockClient
})

const mockCancelJob = vi.fn()
const mockGetJobStatus = vi.fn<() => Promise<{ status: string }>>().mockResolvedValue({ status: 'running' })
const mockGetJobReport = vi
  .fn<
    (...args: unknown[]) => Promise<{
      has_report: boolean
      report?: string
      filed?: { documentId: string; filename: string; alreadyFiled: boolean }
      filingFailed?: boolean
      sources?: Array<Record<string, unknown>>
    }>
  >()
  .mockResolvedValue({ has_report: false })

vi.mock('@/adapters/api', () => ({
  createDeepResearchClient: (options: { callbacks: Record<string, (...args: unknown[]) => void> }) =>
    mockCreateDeepResearchClient(options),
  cancelJob: (...args: unknown[]) => mockCancelJob(...args),
  getJobStatus: () => mockGetJobStatus(),
  getJobReport: (...args: unknown[]) => mockGetJobReport(...args),
}))

import { useChatStore } from '../store'

// ============================================================
// Tests
// ============================================================

describe('useDeepResearch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockClient = null
    mockStoreState = {
      deepResearchJobId: null,
      deepResearchLastEventId: null,
      isDeepResearchStreaming: false,
      deepResearchStatus: null,
      reportContent: '',
      deepResearchAgents: [],
      deepResearchLLMSteps: [],
      deepResearchToolCalls: [],
      deepResearchCitations: [],
      deepResearchOwnerConversationId: 'test-conv-123',
      currentConversation: { id: 'test-conv-123' },
      activeDeepResearchMessageId: null,
      currentUserMessageId: 'user-msg-1',
    }
    useChatStore.getState = vi.fn(() => ({
      ...mockStoreState,
      addErrorCard: mockAddErrorCard,
      persistDeepResearchToSession: mockPersistDeepResearchToSession,
      addDeepResearchBanner: mockAddDeepResearchBanner,
      stopAllDeepResearchSpinners: mockStopAllDeepResearchSpinners,
    })) as unknown as typeof useChatStore.getState
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('initial state', () => {
    test('returns correct initial values when no job is active', () => {
      const { result } = renderHook(() => useDeepResearch())

      expect(result.current.isStreaming).toBe(false)
      expect(result.current.jobId).toBeNull()
      expect(result.current.status).toBeNull()
      expect(result.current.isTimedOut).toBe(false)
      expect(typeof result.current.disconnect).toBe('function')
      expect(typeof result.current.reconnect).toBe('function')
      expect(typeof result.current.cancelCurrentJob).toBe('function')
    })

    test('returns streaming state from store', () => {
      mockStoreState.isDeepResearchStreaming = true
      mockStoreState.deepResearchJobId = 'job-123'
      mockStoreState.deepResearchStatus = 'running'

      const { result } = renderHook(() => useDeepResearch())

      expect(result.current.isStreaming).toBe(true)
      expect(result.current.jobId).toBe('job-123')
      expect(result.current.status).toBe('running')
    })
  })

  describe('auto-connect behavior', () => {
    test('connects when job ID and streaming flag are set', async () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true

      renderHook(() => useDeepResearch())

      await act(async () => { await advanceAndFlush(60) })

      expect(mockCreateDeepResearchClient).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-456',
          authToken: 'mock-id-token',
        })
      )
      expect(mockClient?.connect).toHaveBeenCalled()
    })

    test('opens research panel when connecting', async () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true

      renderHook(() => useDeepResearch())

      await act(async () => { await advanceAndFlush(60) })

      expect(mockSetResearchPanelTab).toHaveBeenCalledWith('tasks')
      expect(mockOpenRightPanel).toHaveBeenCalledWith('research')
    })

    test('always connects from the beginning (no lastEventId)', async () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.deepResearchLastEventId = 'event-789'
      mockStoreState.isDeepResearchStreaming = true

      renderHook(() => useDeepResearch())

      await act(async () => { await advanceAndFlush(60) })

      expect(mockCreateDeepResearchClient).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 'job-456',
        })
      )
      expect(mockCreateDeepResearchClient).not.toHaveBeenCalledWith(
        expect.objectContaining({
          lastEventId: expect.anything(),
        })
      )
    })

    test('does not connect when job ID is null', () => {
      mockStoreState.deepResearchJobId = null
      mockStoreState.isDeepResearchStreaming = true

      renderHook(() => useDeepResearch())

      expect(mockCreateDeepResearchClient).not.toHaveBeenCalled()
    })

    test('does not connect when streaming is false', () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = false

      renderHook(() => useDeepResearch())

      expect(mockCreateDeepResearchClient).not.toHaveBeenCalled()
    })
  })

  describe('disconnect behavior', () => {
    test('disconnect calls client disconnect', async () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true
      mockStoreState.deepResearchStatus = 'submitted'

      const { result } = renderHook(() => useDeepResearch())

      // Advance past the 50ms deferred connect so the client is created
      await act(async () => { await advanceAndFlush(60) })

      act(() => {
        result.current.disconnect()
      })

      expect(mockClient?.disconnect).toHaveBeenCalled()
    })

    test('disconnects on unmount', async () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true
      mockStoreState.deepResearchStatus = 'submitted'

      const { unmount } = renderHook(() => useDeepResearch())

      // Advance past the 50ms deferred connect so the client is created
      await act(async () => { await advanceAndFlush(60) })

      unmount()

      expect(mockClient?.disconnect).toHaveBeenCalled()
    })
  })

  describe('reconnect behavior', () => {
    test('reconnect creates new connection with last event ID', async () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true
      mockStoreState.deepResearchStatus = 'submitted'

      const { result } = renderHook(() => useDeepResearch())

      // Advance past the 50ms deferred connect so the client is created
      await act(async () => { await advanceAndFlush(60) })

      // Simulate getting a last event ID
      mockClient!.getLastEventId.mockReturnValue('event-123')

      // Disconnect first
      act(() => {
        result.current.disconnect()
      })

      // Mock client as disconnected
      mockClient!.isConnected.mockReturnValue(false)

      // Clear mocks to track reconnect call
      mockCreateDeepResearchClient.mockClear()

      act(() => {
        result.current.reconnect()
      })

      expect(mockCreateDeepResearchClient).toHaveBeenCalled()
    })
  })

  describe('cancelCurrentJob', () => {
    test('calls cancel API and schedules fallback timer', async () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true
      mockCancelJob.mockResolvedValue({ cancelled: true })

      const { result } = renderHook(() => useDeepResearch())

      await act(async () => {
        await result.current.cancelCurrentJob()
      })

      expect(mockCancelJob).toHaveBeenCalledWith('job-456', 'mock-id-token')

      // Fallback should NOT have fired yet (only 0ms elapsed)
      expect(mockCompleteDeepResearch).not.toHaveBeenCalled()
    })

    test('fallback cleans up locally if SSE does not deliver interrupted status', async () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true
      mockStoreState.deepResearchOwnerConversationId = 'test-conv-123'
      mockStoreState.activeDeepResearchMessageId = 'msg-1'
      mockCancelJob.mockResolvedValue({ cancelled: true })

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const { result } = renderHook(() => useDeepResearch())

      await act(async () => {
        await result.current.cancelCurrentJob()
      })

      // Advance past the 5s fallback timeout
      await act(async () => {
        vi.advanceTimersByTime(5000)
      })

      // Fallback should have run optimistic cleanup
      expect(mockStopAllDeepResearchSpinners).toHaveBeenCalled()
      expect(mockCompleteDeepResearch).toHaveBeenCalled()
      expect(mockSetStreaming).toHaveBeenCalledWith(false)
      expect(mockAddDeepResearchBanner).toHaveBeenCalledWith('cancelled', 'job-456', 'test-conv-123')
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cancel fallback'),
        expect.any(Number),
        expect.stringContaining('ms')
      )

      consoleWarnSpy.mockRestore()
    })

    test('fallback is a no-op if SSE already handled cleanup', async () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true
      mockCancelJob.mockResolvedValue({ cancelled: true })

      const { result } = renderHook(() => useDeepResearch())

      await act(async () => {
        await result.current.cancelCurrentJob()
      })

      // Simulate SSE delivering the status before fallback fires
      mockStoreState.isDeepResearchStreaming = false

      await act(async () => {
        vi.advanceTimersByTime(5000)
      })

      // Should NOT have called cleanup since streaming was already false
      expect(mockCompleteDeepResearch).not.toHaveBeenCalled()
      expect(mockAddDeepResearchBanner).not.toHaveBeenCalled()
    })

    test('does nothing when no job ID', async () => {
      mockStoreState.deepResearchJobId = null
      mockStoreState.isDeepResearchStreaming = false

      const { result } = renderHook(() => useDeepResearch())

      await act(async () => {
        await result.current.cancelCurrentJob()
      })

      expect(mockCancelJob).not.toHaveBeenCalled()
    })

    test('handles cancel errors gracefully', async () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true
      mockCancelJob.mockRejectedValue(new Error('Network error'))

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { result } = renderHook(() => useDeepResearch())

      await act(async () => {
        await result.current.cancelCurrentJob()
      })

      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to cancel job:', expect.any(Error))

      consoleErrorSpy.mockRestore()
    })
  })

  describe('timeout detection', () => {
    // Skip: This test times out in CI due to waitFor interaction with fake timers
    // TODO: Fix fake timer interaction with waitFor or use a different approach
    test.skip('sets timeout warning after no events for 60 seconds', async () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true

      const { result } = renderHook(() => useDeepResearch())

      expect(result.current.isTimedOut).toBe(false)

      // Advance timers past the timeout threshold (60s) plus check interval (10s)
      act(() => {
        vi.advanceTimersByTime(70000)
      })

      await waitFor(() => {
        expect(result.current.isTimedOut).toBe(true)
      })
    })

    test('clears timeout on unmount', () => {
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true

      const { unmount, result } = renderHook(() => useDeepResearch())

      unmount()

      // Advancing timers after unmount should not cause issues
      act(() => {
        vi.advanceTimersByTime(70000)
      })

      // Result should still be from before unmount
      expect(result.current.isTimedOut).toBe(false)
    })
  })

  /**
   * Advance fake timers and flush microtasks in one step.
   * vi.advanceTimersByTimeAsync processes microtasks between timer callbacks,
   * avoiding the hang that occurs with `setTimeout(r, 0)` under fake timers.
   */
  const advanceAndFlush = (ms: number) => vi.advanceTimersByTimeAsync(ms)

  /**
   * Helper: render hook, advance timers to connect in live (non-buffered) mode.
   *
   * Sets deepResearchStatus to 'submitted' so the hook's connect() computes
   * isReconnect=false → bufferReplay=false → buf.active=false.
   * This means SSE callbacks execute directly (live path) instead of buffering,
   * which is what the callback tests need.
   */
  const setupConnectedHook = async (overrides?: Partial<typeof mockStoreState>) => {
    if (overrides) Object.assign(mockStoreState, overrides)
    mockStoreState.deepResearchJobId = mockStoreState.deepResearchJobId || 'job-456'
    mockStoreState.isDeepResearchStreaming = true
    // 'submitted' makes isReconnect=false, disabling the replay buffer
    mockStoreState.deepResearchStatus = mockStoreState.deepResearchStatus || 'submitted'
    const hook = renderHook(() => useDeepResearch())
    // Advance past the 50ms StrictMode defer + flush microtasks
    await act(async () => { await advanceAndFlush(60) })
    vi.clearAllMocks()
    return hook
  }

  /**
   * Helper: render hook, advance timers to connect in replay-buffer mode.
   *
   * Sets deepResearchStatus to 'running' so the hook treats the connection
   * as a restored job and buffers historical events until stream.mode="live".
   */
  const setupBufferedHook = async (overrides?: Partial<typeof mockStoreState>) => {
    if (overrides) Object.assign(mockStoreState, overrides)
    mockStoreState.deepResearchJobId = mockStoreState.deepResearchJobId || 'job-456'
    mockStoreState.isDeepResearchStreaming = true
    mockStoreState.deepResearchStatus = mockStoreState.deepResearchStatus || 'running'
    const hook = renderHook(() => useDeepResearch())
    await act(async () => { await advanceAndFlush(60) })
    vi.clearAllMocks()
    return hook
  }

  describe('SSE callbacks', () => {
    test('onStreamStart sets status to researching', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onStreamStart?.('job-456')
      })

      expect(mockSetCurrentStatus).toHaveBeenCalledWith('researching')
    })

    test('does not flush a replay buffer after the active job changes', async () => {
      await setupBufferedHook({
        deepResearchJobId: 'job-old',
        deepResearchStatus: 'running',
      })

      act(() => {
        mockClient?.callbacks.onOutputUpdate?.('Old job report', 'final_report')
        mockClient?.callbacks.onCitationUpdate?.({ url: 'https://old.example', content: 'Old citation' }, true)
      })

      mockStoreState.deepResearchJobId = 'job-new'

      act(() => {
        mockClient?.callbacks.onStreamMode?.('live')
      })

      expect(useChatStore.setState).not.toHaveBeenCalled()
      expect(mockSetCurrentStatus).not.toHaveBeenCalledWith('researching')
    })

    test('onJobStatus success completes research and patches message', async () => {
      await setupConnectedHook({
        reportContent: 'Test report',
        activeDeepResearchMessageId: 'msg-123',
      })

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        reportContent: 'Test report',
        deepResearchLLMSteps: [],
        deepResearchToolCalls: [],
        deepResearchCitations: [],
        addErrorCard: mockAddErrorCard,
        deepResearchOwnerConversationId: 'test-conv-123',
        activeDeepResearchMessageId: 'msg-123',
      })) as unknown as typeof useChatStore.getState

      act(() => {
        mockClient?.callbacks.onJobStatus?.('success', undefined)
      })

      expect(mockSetCurrentStatus).toHaveBeenCalledWith('complete')
      expect(mockCompleteDeepResearch).toHaveBeenCalled()
      expect(mockAddDeepResearchBanner).toHaveBeenCalledWith(
        'success',
        'job-456',
        'test-conv-123',
        expect.objectContaining({
          totalTokens: expect.any(Number),
          toolCallCount: expect.any(Number),
        })
      )
      expect(mockPatchConversationMessage).toHaveBeenCalledWith(
        'test-conv-123',
        'msg-123',
        expect.objectContaining({
          deepResearchJobStatus: 'success',
          isDeepResearchActive: false,
        })
      )
    })

    test('files the finished report into the project and records the document', async () => {
      await setupConnectedHook({
        reportContent: 'Test report',
        activeDeepResearchMessageId: 'msg-123',
        projectId: 'proj-1',
      })

      mockGetJobReport.mockResolvedValue({
        has_report: true,
        report: 'Test report',
        filed: { documentId: 'doc-9', filename: 'fluchtweglangen-gk-4-2026-08-20.pdf', alreadyFiled: false },
      })

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        projectId: 'proj-1',
        deepResearchLLMSteps: [],
        deepResearchToolCalls: [],
        deepResearchCitations: [],
        addErrorCard: mockAddErrorCard,
        deepResearchOwnerConversationId: 'test-conv-123',
        activeDeepResearchMessageId: 'msg-123',
      })) as unknown as typeof useChatStore.getState

      await act(async () => {
        mockClient?.callbacks.onJobStatus?.('success', undefined)
        await Promise.resolve()
      })

      // The report GET is the ONLY place the BFF observes a run finishing and
      // files its report. The live stream never touches that route, so without
      // this call the „wird abgelegt" the starting banner promised would be
      // false for every run watched to completion in the tab that started it.
      expect(mockGetJobReport).toHaveBeenCalledWith('job-456', 'mock-id-token', {
        projectId: 'proj-1',
      })
      expect(mockRecordDeepResearchFiling).toHaveBeenCalledWith('job-456', {
        documentId: 'doc-9',
        filename: 'fluchtweglangen-gk-4-2026-08-20.pdf',
      })
    })

    test('numbers the sources the stream discovered from the finished report', async () => {
      await setupConnectedHook({
        reportContent: 'Test report [3]',
        activeDeepResearchMessageId: 'msg-123',
        projectId: 'proj-1',
      })

      // The live stream announced this source before verification numbered
      // it; the persisted output is the only place the `[3]` binding exists.
      const numbered = { file_name: 'oib-rl_2_ausgabe_mai_2023.pdf', page: 7, number: 3 }
      mockGetJobReport.mockResolvedValue({ has_report: true, report: 'Test report [3]', sources: [numbered] })

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        projectId: 'proj-1',
        deepResearchLLMSteps: [],
        deepResearchToolCalls: [],
        deepResearchCitations: [],
        addErrorCard: mockAddErrorCard,
        deepResearchOwnerConversationId: 'test-conv-123',
        activeDeepResearchMessageId: 'msg-123',
      })) as unknown as typeof useChatStore.getState

      await act(async () => {
        mockClient?.callbacks.onJobStatus?.('success', undefined)
        await Promise.resolve()
      })

      // Through the store's merge, as a cited source: an existing row for the
      // same document gains its number, a new one is added numbered.
      expect(mockAddDeepResearchCitation).toHaveBeenCalledWith(numbered, true)
    })

    test('does not ask to file a report outside a project', async () => {
      await setupConnectedHook({
        reportContent: 'Test report',
        activeDeepResearchMessageId: 'msg-123',
        projectId: null,
      })

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        projectId: null,
        deepResearchLLMSteps: [],
        deepResearchToolCalls: [],
        deepResearchCitations: [],
        addErrorCard: mockAddErrorCard,
        deepResearchOwnerConversationId: 'test-conv-123',
        activeDeepResearchMessageId: 'msg-123',
      })) as unknown as typeof useChatStore.getState

      await act(async () => {
        mockClient?.callbacks.onJobStatus?.('success', undefined)
        await Promise.resolve()
      })

      // The request still goes out — the report's numbered sources are wanted
      // in every context — but without a project to name, the proxy files
      // nothing and nothing about a file is recorded. The banner says nothing
      // about a file, which is the honest outcome, not a degraded one.
      expect(mockGetJobReport).toHaveBeenCalledWith('job-456', 'mock-id-token', { projectId: null })
      expect(mockRecordDeepResearchFiling).not.toHaveBeenCalled()
      expect(mockRecordDeepResearchFilingFailure).not.toHaveBeenCalled()
    })

    test('a refused filing never reaches the thread as an error', async () => {
      await setupConnectedHook({
        reportContent: 'Test report',
        activeDeepResearchMessageId: 'msg-123',
        projectId: 'proj-1',
      })

      mockGetJobReport.mockRejectedValue(new Error('403 project:documents:write'))

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        projectId: 'proj-1',
        deepResearchLLMSteps: [],
        deepResearchToolCalls: [],
        deepResearchCitations: [],
        addErrorCard: mockAddErrorCard,
        deepResearchOwnerConversationId: 'test-conv-123',
        activeDeepResearchMessageId: 'msg-123',
      })) as unknown as typeof useChatStore.getState

      await act(async () => {
        mockClient?.callbacks.onJobStatus?.('success', undefined)
        await Promise.resolve()
      })

      // The user's answer already arrived. A dead request is not a reason to
      // put an error card in their thread — and it is not a reason to retract
      // the filing promise either: a fetch that never returned says nothing
      // about whether the write landed. Only the SERVER saying it tried and
      // failed (`filingFailed`) is grounds for that, and this is not it.
      expect(mockAddErrorCard).not.toHaveBeenCalled()
      expect(mockRecordDeepResearchFiling).not.toHaveBeenCalled()
      expect(mockRecordDeepResearchFilingFailure).not.toHaveBeenCalled()
    })

    test('records a promised filing that the server says did not land', async () => {
      await setupConnectedHook({
        reportContent: 'Test report',
        activeDeepResearchMessageId: 'msg-123',
        projectId: 'proj-1',
      })

      mockGetJobReport.mockResolvedValue({
        has_report: true,
        report: 'Test report',
        filingFailed: true,
      })

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        projectId: 'proj-1',
        deepResearchLLMSteps: [],
        deepResearchToolCalls: [],
        deepResearchCitations: [],
        addErrorCard: mockAddErrorCard,
        deepResearchOwnerConversationId: 'test-conv-123',
        activeDeepResearchMessageId: 'msg-123',
      })) as unknown as typeof useChatStore.getState

      await act(async () => {
        mockClient?.callbacks.onJobStatus?.('success', undefined)
        await Promise.resolve()
      })

      // The starting banner promised „wird abgelegt" for this run, because
      // there was a project — the same condition under which the route even
      // attempts a filing. The promise is now known to be broken, and this is
      // the only transport on which that fact reaches the thread.
      expect(mockRecordDeepResearchFilingFailure).toHaveBeenCalledWith('job-456')
      expect(mockRecordDeepResearchFiling).not.toHaveBeenCalled()
      // A fact on the banner, never an error in the thread.
      expect(mockAddErrorCard).not.toHaveBeenCalled()
    })

    test('says nothing when the report route reports neither outcome', async () => {
      await setupConnectedHook({
        reportContent: 'Test report',
        activeDeepResearchMessageId: 'msg-123',
        projectId: 'proj-1',
      })

      mockGetJobReport.mockResolvedValue({ has_report: true, report: 'Test report' })

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        projectId: 'proj-1',
        deepResearchLLMSteps: [],
        deepResearchToolCalls: [],
        deepResearchCitations: [],
        addErrorCard: mockAddErrorCard,
        deepResearchOwnerConversationId: 'test-conv-123',
        activeDeepResearchMessageId: 'msg-123',
      })) as unknown as typeof useChatStore.getState

      await act(async () => {
        mockClient?.callbacks.onJobStatus?.('success', undefined)
        await Promise.resolve()
      })

      // Neither key means no promise was broken — the run may predate the
      // feature, or the route may have resolved no project despite this tab
      // having one. Silence is still the answer for that state.
      expect(mockRecordDeepResearchFiling).not.toHaveBeenCalled()
      expect(mockRecordDeepResearchFilingFailure).not.toHaveBeenCalled()
    })

    test('onJobStatus failure stops todos and shows error', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onJobStatus?.('failure', 'Something went wrong')
      })

      expect(mockSetCurrentStatus).toHaveBeenCalledWith('error')
      expect(mockStopAllDeepResearchSpinners).toHaveBeenCalled()
      expect(mockCompleteDeepResearch).toHaveBeenCalled()
      // No explicit message (the banner localizes the registry default);
      // the raw backend error travels in the details slot.
      expect(mockAddErrorCard).toHaveBeenCalledWith(
        'agent.deep_research_failed',
        undefined,
        'Something went wrong'
      )
    })

    test('onJobStatus interrupted by user shows cancelled banner', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onJobStatus?.('interrupted', 'cancelled by user')
      })

      expect(mockAddDeepResearchBanner).toHaveBeenCalledWith(
        'cancelled',
        'job-456',
        'test-conv-123'
      )
      expect(mockAddErrorCard).not.toHaveBeenCalled()
    })

    test('onJobStatus interrupted for non-user reason shows failure banner', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onJobStatus?.('interrupted', 'worker lost during reconnect')
      })

      expect(mockAddDeepResearchBanner).toHaveBeenCalledWith(
        'failure',
        'job-456',
        'test-conv-123'
      )
      expect(mockAddErrorCard).toHaveBeenCalledWith(
        'agent.deep_research_failed',
        undefined,
        'worker lost during reconnect'
      )
    })

    test('onJobStatus interrupted without error shows fallback failure', async () => {
      await setupConnectedHook()

      expect(() => {
        act(() => {
          mockClient?.callbacks.onJobStatus?.('interrupted', undefined)
        })
      }).not.toThrow()

      expect(mockAddDeepResearchBanner).toHaveBeenCalledWith(
        'failure',
        'job-456',
        'test-conv-123'
      )
      // Localized copy: the hook resolves the interrupted message through the
      // chat dictionary (English fallback when no i18n provider is mounted).
      expect(mockAddErrorCard).toHaveBeenCalledWith(
        'agent.deep_research_failed',
        en.chat.deepResearchErrors.interrupted
      )
    })

    test('onWorkflowStart adds thinking step and agent', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onWorkflowStart?.('test-workflow', 'test input', 'event-1', 'agent-123')
      })

      expect(mockAddThinkingStep).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'agents',
          functionName: 'test-workflow',
          displayName: 'test-workflow',
          isDeepResearch: true,
        })
      )
      expect(mockAddDeepResearchAgentWithId).toHaveBeenCalledWith('agent-123', {
        name: 'test-workflow',
        input: 'test input',
      })
    })

    test('onWorkflowEnd completes thinking step and agent', async () => {
      await setupConnectedHook()

      // Start workflow first
      act(() => {
        mockClient?.callbacks.onWorkflowStart?.('test-workflow', 'test input', 'event-1', 'agent-123')
      })

      act(() => {
        mockClient?.callbacks.onWorkflowEnd?.('test-workflow', 'test output', 'event-2', 'agent-123')
      })

      expect(mockCompleteThinkingStep).toHaveBeenCalled()
      expect(mockCompleteDeepResearchAgent).toHaveBeenCalledWith('agent-123', 'test output')
    })

    test('onLLMStart adds LLM step', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onLLMStart?.('gpt-4', 'test-workflow')
      })

      expect(mockAddThinkingStep).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'agents',
          functionName: 'llm:gpt-4',
          isDeepResearch: true,
        })
      )
      expect(mockAddDeepResearchLLMStep).toHaveBeenCalledWith({
        name: 'gpt-4',
        workflow: 'test-workflow',
        content: '',
      })
    })

    test('onLLMChunk appends to LLM step', async () => {
      await setupConnectedHook()

      // Start LLM first
      act(() => {
        mockClient?.callbacks.onLLMStart?.('gpt-4', 'test-workflow')
      })

      act(() => {
        mockClient?.callbacks.onLLMChunk?.('Hello ')
      })

      expect(mockAppendToThinkingStep).toHaveBeenCalledWith('step-1', 'Hello ')
      expect(mockAppendToDeepResearchLLMStep).toHaveBeenCalledWith('llm-step-1', 'Hello ')
    })

    test('onLLMEnd completes LLM step with thinking and usage', async () => {
      await setupConnectedHook()

      // Start LLM first
      act(() => {
        mockClient?.callbacks.onLLMStart?.('gpt-4', 'test-workflow')
      })

      act(() => {
        mockClient?.callbacks.onLLMEnd?.(
          'Final output',
          'Thinking about this...',
          { input_tokens: 100, output_tokens: 50 }
        )
      })

      expect(mockCompleteThinkingStep).toHaveBeenCalled()
      expect(mockCompleteDeepResearchLLMStep).toHaveBeenCalledWith(
        'llm-step-1',
        'Thinking about this...',
        { input_tokens: 100, output_tokens: 50 }
      )
    })

    test('onToolStart adds tool call', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onToolStart?.('web_search', { query: 'test' }, 'test-workflow', 'event-1', 'agent-123')
      })

      expect(mockSetCurrentStatus).toHaveBeenCalledWith('searching')
      expect(mockAddThinkingStep).toHaveBeenCalledWith(
        expect.objectContaining({
          category: 'tools',
          functionName: 'web_search',
          isDeepResearch: true,
        })
      )
      expect(mockAddDeepResearchToolCall).toHaveBeenCalledWith({
        name: 'web_search',
        input: { query: 'test' },
        workflow: 'test-workflow',
        agentId: 'agent-123',
      })
    })

    test('onToolEnd completes tool call', async () => {
      await setupConnectedHook()

      // Start tool first
      act(() => {
        mockClient?.callbacks.onToolStart?.('web_search', { query: 'test' }, 'test-workflow', 'event-1', 'agent-123')
      })

      act(() => {
        mockClient?.callbacks.onToolEnd?.('web_search', 'Search results...', 'event-2')
      })

      expect(mockCompleteThinkingStep).toHaveBeenCalled()
      expect(mockCompleteDeepResearchToolCall).toHaveBeenCalledWith('tool-call-1', 'Search results...')
      expect(mockSetCurrentStatus).toHaveBeenCalledWith('researching')
    })

    test('onTodoUpdate sets todos in store', async () => {
      await setupConnectedHook()

      const todos = [
        { id: '1', content: 'Task 1', status: 'pending' as const },
        { id: '2', content: 'Task 2', status: 'in_progress' as const },
      ]

      act(() => {
        mockClient?.callbacks.onTodoUpdate?.(todos)
      })

      expect(mockSetDeepResearchTodos).toHaveBeenCalledWith(todos)
    })

    test('onTodoUpdate ignores workflow-scoped sub-agent todos', async () => {
      await setupConnectedHook()

      const todos = [
        { id: '1', content: 'Review sources', status: 'in_progress' as const },
      ]

      act(() => {
        mockClient?.callbacks.onTodoUpdate?.(todos, 'deep_research_agent')
      })

      expect(mockSetDeepResearchTodos).not.toHaveBeenCalled()
    })

    test('replay buffer restores root-level todos after refresh', async () => {
      await setupBufferedHook()

      const todos = [
        { id: '1', content: 'Replay task', status: 'pending' as const },
      ]

      act(() => {
        mockClient?.callbacks.onTodoUpdate?.(todos)
        mockClient?.callbacks.onStreamMode?.('live')
      })

      const replayCommit = vi.mocked(useChatStore.setState).mock.calls[0]?.[0]
      expect(replayCommit).toEqual(expect.any(Function))

      const updates = (replayCommit as unknown as (state: { currentStatus: string }) => Record<string, unknown>)({
        currentStatus: 'researching',
      })
      expect(updates.deepResearchTodos).toEqual([
        { id: 'todo-0-replay-task', content: 'Replay task', status: 'pending' },
      ])
    })

    test('replay buffer ignores workflow-scoped sub-agent todos after refresh', async () => {
      await setupBufferedHook()

      const todos = [
        { id: '1', content: 'Sub-agent task', status: 'pending' as const },
      ]

      act(() => {
        mockClient?.callbacks.onTodoUpdate?.(todos, 'researcher-agent')
        mockClient?.callbacks.onStreamMode?.('live')
      })

      const replayCommit = vi.mocked(useChatStore.setState).mock.calls[0]?.[0]
      expect(replayCommit).toEqual(expect.any(Function))

      const updates = (replayCommit as unknown as (state: { currentStatus: string }) => Record<string, unknown>)({
        currentStatus: 'researching',
      })
      expect(updates).not.toHaveProperty('deepResearchTodos')
    })

    test('onCitationUpdate adds citation to store', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onCitationUpdate?.({ url: 'https://example.com', content: 'Citation content' }, true)
      })

      expect(mockAddDeepResearchCitation).toHaveBeenCalledWith(
        { url: 'https://example.com', content: 'Citation content' },
        true
      )
    })

    test('onFileUpdate adds file to store', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onFileUpdate?.('report.md', '# Report content')
      })

      expect(mockAddDeepResearchFile).toHaveBeenCalledWith({
        filename: 'report.md',
        content: '# Report content',
      })
    })

    test('onFileUpdate sets status to writing when report.md is received', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onFileUpdate?.('report.md', '# Final report')
      })

      expect(mockSetCurrentStatus).toHaveBeenCalledWith('writing')
    })

    test('onFileUpdate sets status to writing for path ending in report.md', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onFileUpdate?.('artifacts/report.md', '# Final report')
      })

      expect(mockSetCurrentStatus).toHaveBeenCalledWith('writing')
    })

    test('onFileUpdate does not set writing status for non-report files', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onFileUpdate?.('notes.md', '# Some notes')
      })

      expect(mockAddDeepResearchFile).toHaveBeenCalledWith({
        filename: 'notes.md',
        content: '# Some notes',
      })
      expect(mockSetCurrentStatus).not.toHaveBeenCalledWith('writing')
    })

    test('onOutputUpdate sets report content for final_report output', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onOutputUpdate?.('Report content here', 'final_report')
      })

      expect(mockSetReportContent).toHaveBeenCalledWith('Report content here', 'final_report')
      expect(mockSetCurrentStatus).toHaveBeenCalledWith('writing')
    })

    test('onOutputUpdate ignores uncategorized output so failed jobs do not fill the report tab with JSON', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onOutputUpdate?.('{"status":"failure","error":"worker failed"}')
      })

      expect(mockSetReportContent).not.toHaveBeenCalled()
      expect(mockSetCurrentStatus).not.toHaveBeenCalledWith('writing')
    })

    test('onOutputUpdate ignores research notes because the report tab only shows final reports', async () => {
      await setupConnectedHook()

      act(() => {
        mockClient?.callbacks.onOutputUpdate?.('Draft research notes', 'research_notes')
      })

      expect(mockSetReportContent).not.toHaveBeenCalled()
      expect(mockSetCurrentStatus).not.toHaveBeenCalledWith('writing')
    })

    test('onComplete does not throw in live mode', async () => {
      await setupConnectedHook()

      // In live mode (buf.active=false), onComplete is a no-op.
      // Just verify it doesn't throw.
      act(() => {
        mockClient?.callbacks.onComplete?.()
      })
    })

    test('onError surfaces a distinct connection-lost state instead of marking the job failed', async () => {
      // UX-11b: exhausted SSE retries mean the CONNECTION is gone, but the job may
      // still be running (and billing) server-side. The client must not pretend the
      // job failed — it flags connection-lost, keeps streaming state intact (so Stop
      // stays enabled), and disconnects the dead EventSource so Reconnect can rebuild.
      await setupConnectedHook({
        activeDeepResearchMessageId: 'msg-123',
        reportContent: 'Partial report',
      })

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        isDeepResearchStreaming: true,
        deepResearchOwnerConversationId: 'test-conv-123',
        activeDeepResearchMessageId: 'msg-123',
        reportContent: 'Partial report',
        addErrorCard: mockAddErrorCard,
        stopAllDeepResearchSpinners: mockStopAllDeepResearchSpinners,
        patchConversationMessage: mockPatchConversationMessage,
        addDeepResearchBanner: mockAddDeepResearchBanner,
        completeDeepResearch: mockCompleteDeepResearch,
        setStreaming: mockSetStreaming,
        setStreamLoaded: mockSetStreamLoaded,
        setDeepResearchConnectionLost: mockSetDeepResearchConnectionLost,
      })) as unknown as typeof useChatStore.getState

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const testError = new Error('SSE connection failed after 5 reconnection attempts')

      act(() => {
        mockClient?.callbacks.onError?.(testError)
      })

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Deep research SSE error:',
        'SSE connection failed after 5 reconnection attempts'
      )
      // Distinct recovery state, NOT a failure.
      expect(mockSetDeepResearchConnectionLost).toHaveBeenCalledWith(true)
      expect(mockClient?.disconnect).toHaveBeenCalled()

      // The job is NOT marked failed/interrupted, and streaming state is preserved.
      expect(mockAddErrorCard).not.toHaveBeenCalled()
      expect(mockPatchConversationMessage).not.toHaveBeenCalled()
      expect(mockAddDeepResearchBanner).not.toHaveBeenCalled()
      expect(mockStopAllDeepResearchSpinners).not.toHaveBeenCalled()
      expect(mockCompleteDeepResearch).not.toHaveBeenCalled()
      expect(mockSetStreaming).not.toHaveBeenCalled()

      consoleWarnSpy.mockRestore()
      consoleErrorSpy.mockRestore()
    })

    test('onError does not touch connection-lost state when research is already terminal', async () => {
      await setupConnectedHook()

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        isDeepResearchStreaming: false,
        deepResearchStatus: 'failure',
        addErrorCard: mockAddErrorCard,
        stopAllDeepResearchSpinners: mockStopAllDeepResearchSpinners,
        setDeepResearchConnectionLost: mockSetDeepResearchConnectionLost,
      })) as unknown as typeof useChatStore.getState

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      act(() => {
        mockClient?.callbacks.onError?.(new Error('Late error'))
      })

      expect(mockSetDeepResearchConnectionLost).not.toHaveBeenCalled()
      expect(mockAddErrorCard).not.toHaveBeenCalled()
      expect(mockCompleteDeepResearch).not.toHaveBeenCalled()

      consoleWarnSpy.mockRestore()
    })

    test('onDisconnect does not throw in live mode', async () => {
      await setupConnectedHook()

      // In live mode (buf.active=false), onDisconnect is a no-op.
      // Just verify it doesn't throw.
      act(() => {
        mockClient?.callbacks.onDisconnect?.()
      })
    })

    test('tracks concurrent same-name tool calls independently in live mode', async () => {
      await setupConnectedHook()

      mockAddDeepResearchToolCall
        .mockReturnValueOnce('tool-call-A')
        .mockReturnValueOnce('tool-call-B')

      // Two sub-agents both run web_search concurrently.
      act(() => {
        mockClient?.callbacks.onToolStart?.('web_search', { query: 'first' }, 'wf-1', 'event-1', 'agent-1')
        mockClient?.callbacks.onToolStart?.('web_search', { query: 'second' }, 'wf-2', 'event-2', 'agent-2')
      })

      // Ends pop the most recent start (LIFO) — mirroring the buffered path —
      // so the second call's output is never attributed to the first call.
      act(() => {
        mockClient?.callbacks.onToolEnd?.('web_search', 'result for second', 'event-3')
      })

      expect(mockCompleteDeepResearchToolCall).toHaveBeenCalledTimes(1)
      expect(mockCompleteDeepResearchToolCall).toHaveBeenCalledWith('tool-call-B', 'result for second')

      act(() => {
        mockClient?.callbacks.onToolEnd?.('web_search', 'result for first', 'event-4')
      })

      expect(mockCompleteDeepResearchToolCall).toHaveBeenCalledTimes(2)
      expect(mockCompleteDeepResearchToolCall).toHaveBeenLastCalledWith('tool-call-A', 'result for first')
    })
  })

  describe('attached runs (no owning conversation)', () => {
    /**
     * A run followed from a workflow's run history is bound to the panel with
     * no owning conversation. Its events must still be accepted, and its
     * thread artifacts (banner, error card) must NOT land in whatever
     * conversation happens to be open.
     */
    const setupAttachedHook = async () =>
      setupConnectedHook({
        deepResearchOwnerConversationId: null,
        activeDeepResearchMessageId: null,
        deepResearchStatus: 'running',
      })

    test('accepts stream events although no conversation owns the run', async () => {
      await setupAttachedHook()

      act(() => {
        mockClient?.callbacks.onStreamMode?.('live')
        mockClient?.callbacks.onStreamStart?.('job-456')
        mockClient?.callbacks.onToolStart?.('web_search', { query: 'OIB' }, undefined, 'e1', 'a1')
      })

      expect(mockSetCurrentStatus).toHaveBeenCalledWith('researching')
      expect(mockAddDeepResearchToolCall).toHaveBeenCalled()
    })

    test('a finished attached run posts no banner into the open thread', async () => {
      await setupAttachedHook()

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        deepResearchOwnerConversationId: null,
        activeDeepResearchMessageId: null,
        addErrorCard: mockAddErrorCard,
      })) as unknown as typeof useChatStore.getState

      act(() => {
        mockClient?.callbacks.onJobStatus?.('success', undefined)
      })

      expect(mockCompleteDeepResearch).toHaveBeenCalled()
      expect(mockAddDeepResearchBanner).not.toHaveBeenCalled()
      expect(mockPatchConversationMessage).not.toHaveBeenCalled()
    })

    test('a failed attached run posts no banner or error card into the open thread', async () => {
      await setupAttachedHook()

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        deepResearchOwnerConversationId: null,
        activeDeepResearchMessageId: null,
        addErrorCard: mockAddErrorCard,
      })) as unknown as typeof useChatStore.getState

      act(() => {
        mockClient?.callbacks.onJobStatus?.('failure', 'Something went wrong')
      })

      expect(mockSetCurrentStatus).toHaveBeenCalledWith('error')
      expect(mockAddDeepResearchBanner).not.toHaveBeenCalled()
      expect(mockAddErrorCard).not.toHaveBeenCalled()
    })
  })

  describe('replay buffer teardown', () => {
    const collectSetStateUpdates = (): Array<Record<string, unknown>> =>
      vi
        .mocked(useChatStore.setState)
        .mock.calls.map(([updater]) =>
          typeof updater === 'function'
            ? ((updater as unknown as (state: { currentStatus: string | null }) => Record<string, unknown>)({
                currentStatus: 'researching',
              }))
            : (updater as unknown as Record<string, unknown>)
        )

    test('a stale replay-buffer safety timer cannot flush after reconnect', async () => {
      const { result } = await setupBufferedHook()

      // Events buffered on the FIRST connection (never flushed).
      act(() => {
        mockClient?.callbacks.onCitationUpdate?.({ url: 'https://stale.example', content: 'Stale citation' }, true)
      })

      // Reconnect tears the first connection down and starts a new buffer.
      act(() => {
        result.current.reconnect()
      })

      // Advance past the 30s safety timeout: the OLD buffer's timer must have
      // been cleared/deactivated — its partial snapshot must never reach the store.
      await act(async () => { await advanceAndFlush(31000) })

      const staleFlushes = collectSetStateUpdates().filter(
        (updates) => 'deepResearchCitations' in updates
      )
      expect(staleFlushes).toHaveLength(0)
    })

    test('disconnect deactivates the replay buffer and clears its safety timer', async () => {
      const { result } = await setupBufferedHook()

      act(() => {
        mockClient?.callbacks.onCitationUpdate?.({ url: 'https://stale.example', content: 'Stale citation' }, true)
      })

      act(() => {
        result.current.disconnect()
      })

      await act(async () => { await advanceAndFlush(31000) })

      expect(useChatStore.setState).not.toHaveBeenCalled()
    })
  })

  describe('reconnect resume behavior', () => {
    test('reconnect resumes from the tracked last event id when the store holds full history', async () => {
      const { result } = await setupConnectedHook()

      mockClient!.getLastEventId.mockReturnValue('99')
      mockCreateDeepResearchClient.mockClear()

      act(() => {
        result.current.reconnect()
      })

      expect(mockCreateDeepResearchClient).toHaveBeenCalledTimes(1)
      const options = mockCreateDeepResearchClient.mock.calls[0][0] as { lastEventId?: string }
      expect(options.lastEventId).toBe('99')

      // Resumed events append live — no replay buffer swallowing them.
      act(() => {
        mockClient?.callbacks.onCitationUpdate?.({ url: 'https://example.com', content: 'Citation' }, true)
      })
      expect(mockAddDeepResearchCitation).toHaveBeenCalledWith(
        { url: 'https://example.com', content: 'Citation' },
        true
      )
    })

    test('reconnect falls back to a full buffered replay while the replay buffer is still active', async () => {
      const { result } = await setupBufferedHook()

      // Mid-replay the store does not yet hold the buffered history — resuming
      // from the last event id would drop the buffered head.
      mockClient!.getLastEventId.mockReturnValue('55')
      mockCreateDeepResearchClient.mockClear()

      act(() => {
        result.current.reconnect()
      })

      expect(mockCreateDeepResearchClient).toHaveBeenCalledTimes(1)
      const options = mockCreateDeepResearchClient.mock.calls[0][0] as { lastEventId?: string }
      expect(options.lastEventId).toBeUndefined()
    })
  })

  describe('reconnect detection (bufferReplay heuristic)', () => {
    test('treats a remount with existing deep-research events as a reconnect even before running status lands', async () => {
      // Status is still 'submitted' (the first running status has not landed),
      // but the store already holds events from before navigation. Replaying
      // in live mode would append duplicates — the hook must buffer instead.
      mockStoreState.deepResearchJobId = 'job-456'
      mockStoreState.isDeepResearchStreaming = true
      mockStoreState.deepResearchStatus = 'submitted'
      mockStoreState.deepResearchToolCalls = [{ id: 'existing-tool-call' }]

      renderHook(() => useDeepResearch())
      await act(async () => { await advanceAndFlush(60) })

      act(() => {
        mockClient?.callbacks.onCitationUpdate?.({ url: 'https://example.com', content: 'Replayed citation' }, true)
      })

      // Buffered: replayed events must NOT be appended to the store directly.
      expect(mockAddDeepResearchCitation).not.toHaveBeenCalled()

      // The flush on stream.mode "live" commits the replay wholesale instead.
      act(() => {
        mockClient?.callbacks.onStreamMode?.('live')
      })
      expect(useChatStore.setState).toHaveBeenCalled()
    })
  })

  describe('formatDuration and formatTokens (integration)', () => {
    test('shows formatted stats on job success', async () => {
      await setupConnectedHook({
        reportContent: 'Test report',
        activeDeepResearchMessageId: 'msg-123',
      })

      useChatStore.getState = vi.fn(() => ({
        ...mockStoreState,
        reportContent: 'Test report',
        deepResearchLLMSteps: [
          { usage: { input_tokens: 500, output_tokens: 200 } },
          { usage: { input_tokens: 300, output_tokens: 150 } },
        ],
        deepResearchToolCalls: [{ id: '1' }, { id: '2' }, { id: '3' }],
        deepResearchCitations: [
          { isCited: true },
          { isCited: true },
          { isCited: false },
        ],
        addErrorCard: mockAddErrorCard,
        deepResearchOwnerConversationId: 'test-conv-123',
        activeDeepResearchMessageId: 'msg-123',
      })) as unknown as typeof useChatStore.getState

      // Simulate stream start to set start time
      act(() => {
        mockClient?.callbacks.onStreamStart?.('job-456')
      })

      // Advance time by 2 minutes
      act(() => {
        vi.advanceTimersByTime(120000)
      })

      act(() => {
        mockClient?.callbacks.onJobStatus?.('success', undefined)
      })

      // Check that stats are included in the banner call
      // totalTokens = 500 + 200 + 300 + 150 = 1150
      // toolCallCount = 3
      expect(mockAddDeepResearchBanner).toHaveBeenCalledWith(
        'success',
        'job-456',
        'test-conv-123',
        {
          totalTokens: 1150,
          toolCallCount: 3,
        }
      )
      expect(mockPatchConversationMessage).toHaveBeenCalledWith(
        'test-conv-123',
        'msg-123',
        expect.objectContaining({
          deepResearchJobStatus: 'success',
        })
      )
    })
  })
})
