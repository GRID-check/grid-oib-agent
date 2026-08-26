import { renderHook, act } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useLoadJobData } from './use-load-job-data'
import { useChatStore } from '../store'
import type { ChatMessage, Conversation } from '../types'

const mockGetJobStatus = vi.fn()
const mockGetJobReport = vi.fn()
const mockGetJobState = vi.fn()
const mockCreateDeepResearchClient = vi.fn()
const mockSetReportContent = vi.fn()
const mockAddDeepResearchToolCall = vi.fn()
const mockCompleteDeepResearchToolCall = vi.fn()
const mockClearDeepResearch = vi.fn()
const mockSetCurrentStatus = vi.fn()
const mockSetLoadedJobId = vi.fn()
const mockSetStreamLoaded = vi.fn()
const mockStopAllDeepResearchSpinners = vi.fn()
const mockAddErrorCard = vi.fn()
const mockCompleteDeepResearch = vi.fn()
const mockSetStreaming = vi.fn()
const mockPatchConversationMessage = vi.fn()
const mockAddDeepResearchBanner = vi.fn()
const mockRecordDeepResearchFiling = vi.fn()
const mockRecordDeepResearchFilingFailure = vi.fn()
const mockAttachToDeepResearchJob = vi.fn()
const mockOpenRightPanel = vi.fn()
const mockSetResearchPanelTab = vi.fn()

type MockConversation = Pick<Conversation, 'id' | 'messages'>

const createDefaultMessages = (): ChatMessage[] => [
  {
    id: 'tracking-msg',
    role: 'assistant',
    content: '',
    timestamp: new Date(),
    messageType: 'agent_response',
    deepResearchJobId: 'job-404',
    deepResearchJobStatus: 'running',
    isDeepResearchActive: true,
  },
  {
    id: 'starting-banner',
    role: 'assistant',
    content: '',
    timestamp: new Date(),
    messageType: 'deep_research_banner',
    deepResearchBannerData: { bannerType: 'starting', jobId: 'job-404' },
  },
]

let mockStoreState: {
  currentConversation: MockConversation | null
  conversations: MockConversation[]
  deepResearchJobId: string | null
  deepResearchStreamLoaded: boolean
  reportContent: string
  isDeepResearchStreaming: boolean
  projectId: string | null
} = {
  currentConversation: {
    id: 'conv-1',
    messages: createDefaultMessages(),
  },
  conversations: [],
  deepResearchJobId: null as string | null,
  deepResearchStreamLoaded: false,
  reportContent: '',
  isDeepResearchStreaming: false,
  projectId: 'proj-1',
}

type MockChatSelectorState = {
  setReportContent: typeof mockSetReportContent
  addDeepResearchToolCall: typeof mockAddDeepResearchToolCall
  completeDeepResearchToolCall: typeof mockCompleteDeepResearchToolCall
  clearDeepResearch: typeof mockClearDeepResearch
  setCurrentStatus: typeof mockSetCurrentStatus
  setLoadedJobId: typeof mockSetLoadedJobId
  setStreamLoaded: typeof mockSetStreamLoaded
  stopAllDeepResearchSpinners: typeof mockStopAllDeepResearchSpinners
  addErrorCard: typeof mockAddErrorCard
  completeDeepResearch: typeof mockCompleteDeepResearch
  setStreaming: typeof mockSetStreaming
  patchConversationMessage: typeof mockPatchConversationMessage
  addDeepResearchBanner: typeof mockAddDeepResearchBanner
  recordDeepResearchFiling: typeof mockRecordDeepResearchFiling
  recordDeepResearchFilingFailure: typeof mockRecordDeepResearchFilingFailure
  attachToDeepResearchJob: typeof mockAttachToDeepResearchJob
}

type MockLayoutSelectorState = {
  openRightPanel: typeof mockOpenRightPanel
  setResearchPanelTab: typeof mockSetResearchPanelTab
}

vi.mock('@/adapters/api', () => ({
  getJobStatus: (...args: unknown[]) => mockGetJobStatus(...args),
  getJobReport: (...args: unknown[]) => mockGetJobReport(...args),
  getJobState: (...args: unknown[]) => mockGetJobState(...args),
  createDeepResearchClient: (...args: unknown[]) => mockCreateDeepResearchClient(...args),
}))

vi.mock('../store', () => ({
  useChatStore: Object.assign(
    vi.fn((selector?: (s: MockChatSelectorState) => unknown) => {
      const state: MockChatSelectorState = {
        setReportContent: mockSetReportContent,
        addDeepResearchToolCall: mockAddDeepResearchToolCall,
        completeDeepResearchToolCall: mockCompleteDeepResearchToolCall,
        clearDeepResearch: mockClearDeepResearch,
        setCurrentStatus: mockSetCurrentStatus,
        setLoadedJobId: mockSetLoadedJobId,
        setStreamLoaded: mockSetStreamLoaded,
        stopAllDeepResearchSpinners: mockStopAllDeepResearchSpinners,
        addErrorCard: mockAddErrorCard,
        completeDeepResearch: mockCompleteDeepResearch,
        setStreaming: mockSetStreaming,
        patchConversationMessage: mockPatchConversationMessage,
        addDeepResearchBanner: mockAddDeepResearchBanner,
        recordDeepResearchFiling: mockRecordDeepResearchFiling,
        recordDeepResearchFilingFailure: mockRecordDeepResearchFilingFailure,
        attachToDeepResearchJob: mockAttachToDeepResearchJob,
      }
      return selector ? selector(state) : state
    }),
    {
      getState: vi.fn(() => mockStoreState),
      setState: vi.fn(),
    }
  ),
}))

vi.mock('@/adapters/auth', () => ({
  useAuth: vi.fn(() => ({
    idToken: 'token-123',
  })),
}))

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: vi.fn((selector?: (s: MockLayoutSelectorState) => unknown) => {
    const state: MockLayoutSelectorState = {
      openRightPanel: mockOpenRightPanel,
      setResearchPanelTab: mockSetResearchPanelTab,
    }
    return selector ? selector(state) : state
  }),
}))

describe('useLoadJobData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStoreState = {
      currentConversation: {
        id: 'conv-1',
        messages: createDefaultMessages(),
      },
      conversations: [],
      deepResearchJobId: null,
      deepResearchStreamLoaded: false,
      reportContent: '',
      isDeepResearchStreaming: false,
      projectId: 'proj-1',
    }
  })

  test('loads report tab data through the report endpoint without replaying the full stream', async () => {
    mockGetJobStatus.mockResolvedValue({ job_id: 'job-123', status: 'success', error: null })
    mockGetJobReport.mockResolvedValue({
      job_id: 'job-123',
      has_report: true,
      report: 'Loaded report',
    })
    mockGetJobState.mockResolvedValue({ job_id: 'job-123', has_state: false, artifacts: null })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.loadResearchPanelTab('job-123', 'report')
    })

    expect(mockSetResearchPanelTab).toHaveBeenCalledWith('report')
    expect(mockOpenRightPanel).toHaveBeenCalledWith('research')
    // The projectId is not decoration: the proxy resolves the project from the
    // query string, and a report fetched without one is never filed.
    expect(mockGetJobReport).toHaveBeenCalledWith('job-123', 'token-123', { projectId: 'proj-1' })
    expect(mockSetReportContent).toHaveBeenCalledWith('Loaded report', 'final_report')
    expect(mockCreateDeepResearchClient).not.toHaveBeenCalled()
  })

  test('records the filed document when the report route reports one', async () => {
    mockGetJobStatus.mockResolvedValue({ job_id: 'job-123', status: 'success', error: null })
    mockGetJobReport.mockResolvedValue({
      job_id: 'job-123',
      has_report: true,
      report: 'Loaded report',
      filed: { documentId: 'doc-9', filename: 'fluchtweglangen-gk-4-2026-08-20.pdf', alreadyFiled: false },
    })
    mockGetJobState.mockResolvedValue({ job_id: 'job-123', has_state: false, artifacts: null })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.loadResearchPanelTab('job-123', 'report')
    })

    // `alreadyFiled` is deliberately dropped: it answers a question about the
    // REQUEST, and the banner shows the same link either way.
    expect(mockRecordDeepResearchFiling).toHaveBeenCalledWith('job-123', {
      documentId: 'doc-9',
      filename: 'fluchtweglangen-gk-4-2026-08-20.pdf',
    })
  })

  test('records nothing when the report route filed nothing', async () => {
    mockGetJobStatus.mockResolvedValue({ job_id: 'job-123', status: 'success', error: null })
    mockGetJobReport.mockResolvedValue({
      job_id: 'job-123',
      has_report: true,
      report: 'Loaded report',
    })
    mockGetJobState.mockResolvedValue({ job_id: 'job-123', has_state: false, artifacts: null })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.loadResearchPanelTab('job-123', 'report')
    })

    // Neither key: no filing was ever attempted for this report, so nothing was
    // promised and the absence must stay an absence all the way to the banner.
    expect(mockRecordDeepResearchFiling).not.toHaveBeenCalled()
    expect(mockRecordDeepResearchFilingFailure).not.toHaveBeenCalled()
  })

  test('records a promised filing the report route says did not land', async () => {
    mockGetJobStatus.mockResolvedValue({ job_id: 'job-123', status: 'success', error: null })
    mockGetJobReport.mockResolvedValue({
      job_id: 'job-123',
      has_report: true,
      report: 'Loaded report',
      filingFailed: true,
    })
    mockGetJobState.mockResolvedValue({ job_id: 'job-123', has_state: false, artifacts: null })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.loadResearchPanelTab('job-123', 'report')
    })

    // Reopening a report re-triggers the filing, so this path is both the
    // second chance for a run whose first attempt failed and the place a second
    // failure is finally said out loud.
    expect(mockRecordDeepResearchFilingFailure).toHaveBeenCalledWith('job-123')
    expect(mockRecordDeepResearchFiling).not.toHaveBeenCalled()
  })

  test('does not reload report tab data when the current job already has report content', async () => {
    mockStoreState.deepResearchJobId = 'job-123'
    mockStoreState.reportContent = 'Cached report'

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.loadResearchPanelTab('job-123', 'report')
    })

    expect(mockSetResearchPanelTab).toHaveBeenCalledWith('report')
    expect(mockOpenRightPanel).toHaveBeenCalledWith('research')
    expect(mockGetJobStatus).not.toHaveBeenCalled()
    expect(mockGetJobReport).not.toHaveBeenCalled()
    expect(mockCreateDeepResearchClient).not.toHaveBeenCalled()
  })

  test('follows a still-running job live instead of failing with "still running"', async () => {
    // A workflow run opened from its run history: the job is in flight, so the
    // panel must attach to its live stream rather than report a dead end.
    mockGetJobStatus.mockResolvedValue({ job_id: 'job-live', status: 'running', error: null })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.loadResearchPanelTab('job-live', 'report')
    })

    expect(mockAttachToDeepResearchJob).toHaveBeenCalledWith('job-live')
    // Progress lives on the Tasks tab — there is no report yet.
    expect(mockSetResearchPanelTab).toHaveBeenLastCalledWith('tasks')
    expect(mockOpenRightPanel).toHaveBeenCalledWith('research')
    expect(result.current.error).toBeNull()
    expect(mockAddErrorCard).not.toHaveBeenCalled()
    // No replay: the live stream delivers the backlog and then the new events.
    expect(mockCreateDeepResearchClient).not.toHaveBeenCalled()
  })

  test('follows a still-running job from a stream-backed tab too', async () => {
    mockGetJobStatus.mockResolvedValue({ job_id: 'job-live', status: 'submitted', error: null })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.loadResearchPanelTab('job-live', 'thinking')
    })

    expect(mockAttachToDeepResearchJob).toHaveBeenCalledWith('job-live')
    expect(mockCreateDeepResearchClient).not.toHaveBeenCalled()
  })

  test('does not re-attach a job that is already streaming live into the panel', async () => {
    mockStoreState.deepResearchJobId = 'job-live'
    mockStoreState.isDeepResearchStreaming = true

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.loadResearchPanelTab('job-live', 'report')
    })

    expect(mockGetJobStatus).not.toHaveBeenCalled()
    expect(mockAttachToDeepResearchJob).not.toHaveBeenCalled()
  })

  test('loads thinking tab data by replaying the full stream', async () => {
    mockGetJobStatus.mockResolvedValue({ job_id: 'job-123', status: 'success', error: null })
    mockCreateDeepResearchClient.mockImplementation(({ callbacks }) => ({
      connect: vi.fn(() => callbacks.onComplete?.()),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => false),
      getLastEventId: vi.fn(() => null),
    }))

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.loadResearchPanelTab('job-123', 'thinking')
    })

    expect(mockSetResearchPanelTab).toHaveBeenCalledWith('thinking')
    expect(mockOpenRightPanel).toHaveBeenCalledWith('research')
    expect(mockGetJobReport).not.toHaveBeenCalled()
    expect(mockCreateDeepResearchClient).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-123',
        authToken: 'token-123',
      })
    )
  })

  test('marks unavailable completed report expired without surfacing a console error', async () => {
    mockGetJobStatus.mockRejectedValue(new Error('Failed to get job status: 404'))
    mockStoreState.currentConversation = {
      id: 'conv-1',
      messages: [
        {
          id: 'tracking-msg',
          role: 'assistant',
          content: 'Completed report',
          timestamp: new Date(),
          messageType: 'agent_response',
          deepResearchJobId: 'job-404',
          deepResearchJobStatus: 'success',
          showViewReport: true,
        },
        {
          id: 'success-banner',
          role: 'assistant',
          content: '',
          timestamp: new Date(),
          messageType: 'deep_research_banner',
          deepResearchBannerData: { bannerType: 'success', jobId: 'job-404' },
        },
      ],
    }
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.importJobStream('job-404')
    })

    expect(mockPatchConversationMessage).toHaveBeenCalledWith(
      'conv-1',
      'tracking-msg',
      expect.objectContaining({
        deepResearchJobStatus: 'failure',
        isDeepResearchActive: false,
        showViewReport: false,
        deepResearchReportExpired: true,
      })
    )
    expect(mockAddDeepResearchBanner).toHaveBeenCalledWith('expired', 'job-404', 'conv-1')
    expect(mockAddDeepResearchBanner).not.toHaveBeenCalledWith(
      'failure',
      expect.anything(),
      expect.anything()
    )
    expect(mockAddErrorCard).not.toHaveBeenCalled()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  test('treats proxy failures as backend connectivity without expiring the report', async () => {
    mockGetJobStatus.mockRejectedValue(
      new Error('Failed to get job status: 500 - PROXY_ERROR: fetch failed')
    )
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.importJobStream('job-404')
    })

    expect(mockPatchConversationMessage).not.toHaveBeenCalled()
    expect(mockAddDeepResearchBanner).not.toHaveBeenCalled()
    expect(mockStopAllDeepResearchSpinners).not.toHaveBeenCalled()
    expect(mockCompleteDeepResearch).not.toHaveBeenCalled()
    expect(mockSetStreaming).not.toHaveBeenCalled()
    // End-user copy (localized via chat.deepResearchErrors.serviceUnreachable;
    // English fallback without an i18n provider) with the technical cause in
    // the details slot.
    expect(mockAddErrorCard).toHaveBeenCalledWith(
      'connection.failed',
      'The service is currently unreachable. Please try again later.',
      'Failed to get job status: 500 - PROXY_ERROR: fetch failed'
    )
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  test('does not clear live deep research state when loading a different job (importJobStream)', async () => {
    // A DIFFERENT job is actively streaming — deep-linking to an old run must
    // not wipe its live state or disconnect its SSE.
    mockStoreState.deepResearchJobId = 'job-live'
    mockStoreState.isDeepResearchStreaming = true
    mockGetJobStatus.mockResolvedValue({ job_id: 'job-old', status: 'success', error: null })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.importJobStream('job-old')
    })

    expect(mockClearDeepResearch).not.toHaveBeenCalled()
    expect(mockCreateDeepResearchClient).not.toHaveBeenCalled()
    expect(mockGetJobStatus).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
  })

  test('does not clear live deep research state when loading a different job (importStreamOnly)', async () => {
    mockStoreState.deepResearchJobId = 'job-live'
    mockStoreState.isDeepResearchStreaming = true
    mockGetJobStatus.mockResolvedValue({ job_id: 'job-old', status: 'success', error: null })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.importStreamOnly('job-old')
    })

    expect(mockClearDeepResearch).not.toHaveBeenCalled()
    expect(mockCreateDeepResearchClient).not.toHaveBeenCalled()
    expect(mockGetJobStatus).not.toHaveBeenCalled()
    expect(result.current.error).toBeNull()
  })

  test('aborts before clearing when another job starts streaming during the status check', async () => {
    // The live run starts while getJobStatus is in flight — the re-check after
    // the await must skip the destructive clear.
    mockGetJobStatus.mockImplementation(async () => {
      mockStoreState.deepResearchJobId = 'job-live'
      mockStoreState.isDeepResearchStreaming = true
      return { job_id: 'job-old', status: 'success', error: null }
    })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.importStreamOnly('job-old')
    })

    expect(mockClearDeepResearch).not.toHaveBeenCalled()
    expect(mockCreateDeepResearchClient).not.toHaveBeenCalled()
  })

  test('completes a failed job replay normally instead of surfacing an error card', async () => {
    // The target job is terminal 'failure'; the replayed stream re-delivers
    // that status. That is data, not a load error — the load must complete,
    // cache the stream, and add no error card.
    mockGetJobStatus.mockResolvedValue({
      job_id: 'job-failed',
      status: 'failure',
      error: 'worker crashed',
    })
    mockCreateDeepResearchClient.mockImplementation(({ callbacks }) => ({
      connect: vi.fn(() => {
        callbacks.onJobStatus?.('failure', 'worker crashed')
        // The real client fires onError right after a terminal failure status.
        callbacks.onError?.(new Error('worker crashed'))
      }),
      disconnect: vi.fn(),
      isConnected: vi.fn(() => false),
      getLastEventId: vi.fn(() => null),
    }))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      await result.current.importStreamOnly('job-failed')
    })

    expect(mockAddErrorCard).not.toHaveBeenCalled()
    expect(mockSetStreamLoaded).toHaveBeenCalledWith(true)
    expect(mockSetLoadedJobId).toHaveBeenCalledWith('job-failed')
    expect(result.current.error).toBeNull()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  test('does not commit full stream replay data after the user switches sessions', async () => {
    let streamCallbacks: {
      onOutputUpdate: (content: string, outputCategory?: string) => void
      onComplete: () => void
    } | null = null

    mockGetJobStatus.mockResolvedValue({ job_id: 'job-123', status: 'success', error: null })
    mockCreateDeepResearchClient.mockImplementation(({ callbacks }) => {
      streamCallbacks = callbacks
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => false),
        getLastEventId: vi.fn(() => null),
      }
    })

    mockStoreState.currentConversation = {
      id: 'conv-1',
      messages: [
        {
          id: 'tracking-msg',
          role: 'assistant',
          content: 'Completed report',
          timestamp: new Date(),
          messageType: 'agent_response',
          deepResearchJobId: 'job-123',
          deepResearchJobStatus: 'success',
          showViewReport: true,
        },
      ],
    }

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      const replay = result.current.importJobStream('job-123')
      await Promise.resolve()

      mockStoreState.currentConversation = {
        id: 'conv-2',
        messages: [],
      }
      expect(streamCallbacks).not.toBeNull()
      streamCallbacks!.onOutputUpdate('Report from the previous session', 'final_report')
      streamCallbacks!.onComplete()

      await replay
    })

    expect(useChatStore.setState).not.toHaveBeenCalled()
    expect(mockSetLoadedJobId).not.toHaveBeenCalled()
    expect(mockSetStreamLoaded).not.toHaveBeenCalled()
    expect(mockOpenRightPanel).not.toHaveBeenCalled()
  })

  test('does not promote uncategorized replay output into report content', async () => {
    let streamCallbacks: {
      onOutputUpdate: (content: string, outputCategory?: string) => void
      onJobStatus: (status: 'success' | 'failure' | 'interrupted', error?: string) => void
    } | null = null

    mockGetJobStatus.mockResolvedValue({ job_id: 'job-123', status: 'interrupted', error: null })
    mockCreateDeepResearchClient.mockImplementation(({ callbacks }) => {
      streamCallbacks = callbacks
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => false),
        getLastEventId: vi.fn(() => null),
      }
    })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      const replay = result.current.importJobStream('job-123')
      await Promise.resolve()

      expect(streamCallbacks).not.toBeNull()
      streamCallbacks!.onOutputUpdate('{"status":"interrupted","reason":"cancelled"}')
      streamCallbacks!.onJobStatus('interrupted', 'cancelled by user')

      await replay
    })

    const replayCommit = vi.mocked(useChatStore.setState).mock.calls[0]?.[0]
    expect(replayCommit).toEqual(expect.any(Function))

    const updates = (replayCommit as (state: { currentStatus: string }) => object)({
      currentStatus: 'researching',
    })
    expect(updates).not.toHaveProperty('reportContent')
    expect(updates).not.toHaveProperty('reportContentCategory')
    expect(mockSetReportContent).not.toHaveBeenCalled()
  })

  test('imports root-level todos from full stream replay', async () => {
    let streamCallbacks: {
      onTodoUpdate: (todos: Array<{ id: string; content: string; status: 'pending' }>, workflow?: string) => void
      onComplete: () => void
    } | null = null

    mockGetJobStatus.mockResolvedValue({ job_id: 'job-123', status: 'success', error: null })
    mockCreateDeepResearchClient.mockImplementation(({ callbacks }) => {
      streamCallbacks = callbacks
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => false),
        getLastEventId: vi.fn(() => null),
      }
    })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      const replay = result.current.importJobStream('job-123')
      await Promise.resolve()

      expect(streamCallbacks).not.toBeNull()
      streamCallbacks!.onTodoUpdate(
        [{ id: '1', content: 'Replay task', status: 'pending' }]
      )
      streamCallbacks!.onComplete()

      await replay
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

  test('does not import workflow-scoped sub-agent todos from full stream replay', async () => {
    let streamCallbacks: {
      onTodoUpdate: (todos: Array<{ id: string; content: string; status: 'pending' }>, workflow?: string) => void
      onComplete: () => void
    } | null = null

    mockGetJobStatus.mockResolvedValue({ job_id: 'job-123', status: 'success', error: null })
    mockCreateDeepResearchClient.mockImplementation(({ callbacks }) => {
      streamCallbacks = callbacks
      return {
        connect: vi.fn(),
        disconnect: vi.fn(),
        isConnected: vi.fn(() => false),
        getLastEventId: vi.fn(() => null),
      }
    })

    const { result } = renderHook(() => useLoadJobData())

    await act(async () => {
      const replay = result.current.importJobStream('job-123')
      await Promise.resolve()

      expect(streamCallbacks).not.toBeNull()
      streamCallbacks!.onTodoUpdate(
        [{ id: '1', content: 'Sub-agent task', status: 'pending' }],
        'researcher-agent'
      )
      streamCallbacks!.onComplete()

      await replay
    })

    const replayCommit = vi.mocked(useChatStore.setState).mock.calls[0]?.[0]
    expect(replayCommit).toEqual(expect.any(Function))

    const updates = (replayCommit as unknown as (state: { currentStatus: string }) => Record<string, unknown>)({
      currentStatus: 'researching',
    })
    expect(updates).not.toHaveProperty('deepResearchTodos')
  })
})
