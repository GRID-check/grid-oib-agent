import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { InputArea } from './InputArea'

// Mock the chat hooks
const mockSendMessage = vi.fn()
const mockRespondToInteraction = vi.fn()

let mockIsDeepResearchStreaming = false
let mockDeepResearchStatus: string | null = null
let mockDeepResearchOwnerConversationId: string | null = null
let mockConversationMessages: unknown[] | undefined = []
// Active session id (null models the "new session draft" state with no id yet).
let mockCurrentSessionId: string | null = 'session-1'
// One-shot prefill queued from a deep link / chip.
let mockComposerPrefill: string | null = null
// Real-ish per-session draft store, so component tests exercise genuine
// save/restore/clear behaviour rather than asserting on spy calls alone.
let mockDrafts: Record<string, string> = {}
// Shallow-thinking stream state + cancel action for the composer stop button.
let mockIsStreaming = false
const mockStopStreaming = vi.fn()

const mockSaveDataSourcesToConversation = vi.fn()

vi.mock('@/features/chat', () => ({
  useWebSocketChat: vi.fn(() => ({
    sendMessage: mockSendMessage,
    isStreaming: false,
    isLoading: false,
    respondToInteraction: mockRespondToInteraction,
    pendingInteraction: null,
  })),
  useChatStore: vi.fn((selector) => {
    const state = {
      currentConversation: mockCurrentSessionId
        ? { id: mockCurrentSessionId, messages: mockConversationMessages }
        : null,
      saveDataSourcesToConversation: mockSaveDataSourcesToConversation,
      isStreaming: mockIsStreaming,
      stopStreaming: mockStopStreaming,
      ensureSession: vi.fn(() => {
        if (!mockCurrentSessionId) mockCurrentSessionId = 'session-new'
        return mockCurrentSessionId
      }),
      setRespondToInteractionFn: vi.fn(),
      deepResearchStatus: mockDeepResearchStatus,
      isDeepResearchStreaming: mockIsDeepResearchStreaming,
      deepResearchOwnerConversationId: mockDeepResearchOwnerConversationId,
      composerPrefill: mockComposerPrefill,
      consumeComposerPrefill: vi.fn(() => {
        const value = mockComposerPrefill
        mockComposerPrefill = null
        return value
      }),
      composerDrafts: mockDrafts,
      getComposerDraft: (id: string) => mockDrafts[id] ?? '',
      setComposerDraft: (id: string, text: string) => {
        if (text === '') {
          delete mockDrafts[id]
          return
        }
        mockDrafts[id] = text
      },
      clearComposerDraft: (id: string) => {
        delete mockDrafts[id]
      },
    }
    return selector(state)
  }),
  useIsCurrentSessionBusy: vi.fn(() => false),
}))

// Mock the layout store
const mockOpenRightPanel = vi.fn()
const mockSetDataSourcePanelTab = vi.fn()

const mockCloseRightPanel = vi.fn()
const mockSetDataSourcesPanelTab = vi.fn()
const mockSetDeepResearchIntent = vi.fn()
const mockApplySourcePreset = vi.fn()
let mockDeepResearchIntent = false
let mockActiveSourcePreset: string | null = null
let mockAvailableDataSources: Array<{ id: string; name?: string }> = [
  { id: 'source-1' },
  { id: 'source-2' },
]

const mockToggleDataSource = vi.fn()
const mockSetEnabledDataSources = vi.fn()
const mockFetchDataSources = vi.fn()

const mockLayoutState = () => ({
  openRightPanel: mockOpenRightPanel,
  closeRightPanel: mockCloseRightPanel,
  setDataSourcesPanelTab: mockSetDataSourcesPanelTab,
  setDataSourcePanelTab: mockSetDataSourcePanelTab,
  enabledDataSourceIds: ['source-1', 'source-2'],
  knowledgeLayerAvailable: true,
  availableDataSources: mockAvailableDataSources,
  rightPanel: null as string | null,
  deepResearchIntent: mockDeepResearchIntent,
  setDeepResearchIntent: mockSetDeepResearchIntent,
  activeSourcePreset: mockActiveSourcePreset,
  applySourcePreset: mockApplySourcePreset,
  // Sources popover (C4) — connection toggles lifted from the old panel.
  toggleDataSource: mockToggleDataSource,
  setEnabledDataSources: mockSetEnabledDataSources,
  fetchDataSources: mockFetchDataSources,
  dataSourcesLoading: false,
  dataSourcesError: null as string | null,
})

type MockLayoutState = ReturnType<typeof mockLayoutState>

vi.mock('../store', () => ({
  useLayoutStore: Object.assign(
    vi.fn((selector?: (s: MockLayoutState) => unknown) => {
      const state = mockLayoutState()
      return selector ? selector(state) : state
    }),
    { getState: () => mockLayoutState() }
  ),
}))

// Mock auth (sources popover reads idToken to gate auth-required sources)
vi.mock('@/adapters/auth', () => ({
  useAuth: () => ({ idToken: 'test-token', authRequired: true }),
}))

// Mock useAppConfig
vi.mock('@/shared/context', () => ({
  useAppConfig: () => ({
    authRequired: true,
    fileUpload: {
      acceptedTypes: '.pdf,.docx,.txt,.md',
      acceptedMimeTypes: ['application/pdf', 'text/plain', 'text/markdown'],
      maxTotalSizeMB: 100,
      maxFileSize: 100 * 1024 * 1024,
      maxTotalSize: 100 * 1024 * 1024,
      maxFileCount: 10,
    },
  }),
}))

// Mock the file upload hooks
const mockUploadFiles = vi.fn()

const mockDeleteFile = vi.fn()
const mockRetryFile = vi.fn()

vi.mock('@/features/documents', () => ({
  useFileUpload: vi.fn(() => ({
    uploadFiles: mockUploadFiles,
    sessionFiles: [],
    deleteFile: mockDeleteFile,
    retryFile: mockRetryFile,
    isUploading: false,
    error: null,
    clearError: vi.fn(),
  })),
  useFileDragDrop: vi.fn(() => ({
    isDragging: false,
    isUnsupportedDrag: false,
    dragHandlers: {
      onDragEnter: vi.fn(),
      onDragLeave: vi.fn(),
      onDragOver: vi.fn(),
      onDrop: vi.fn(),
    },
  })),
}))

// FileSourcesTab is imported by InputArea for the "manage files" dialog; it
// pulls a large dependency graph that is irrelevant to composer unit tests.
vi.mock('./FileSourcesTab', () => ({
  FileSourcesTab: () => null,
}))

import { useWebSocketChat, useIsCurrentSessionBusy } from '@/features/chat'
import { useFileUpload, useFileDragDrop } from '@/features/documents'

describe('InputArea', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsDeepResearchStreaming = false
    mockDeepResearchStatus = null
    mockDeepResearchOwnerConversationId = null
    mockConversationMessages = []
    mockCurrentSessionId = 'session-1'
    mockComposerPrefill = null
    mockDrafts = {}
    mockDeepResearchIntent = false
    mockActiveSourcePreset = null
    mockIsStreaming = false
    mockAvailableDataSources = [{ id: 'source-1' }, { id: 'source-2' }]
    // Reset mocks to defaults - clearAllMocks doesn't reset mockReturnValue
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(false)
    vi.mocked(useWebSocketChat).mockReturnValue({
      sendMessage: mockSendMessage,
      isStreaming: false,
      isLoading: false,
      respondToInteraction: mockRespondToInteraction,
      pendingInteraction: null,
    } as unknown as ReturnType<typeof useWebSocketChat>)
  })

  test('does not render the Auto mode selector button', () => {
    render(<InputArea isAuthenticated={true} />)

    expect(screen.queryByText('Auto')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /query type/i })).not.toBeInTheDocument()
  })

  test('renders text area with default placeholder', () => {
    render(<InputArea isAuthenticated={true} />)

    expect(
      screen.getByPlaceholderText(
        'Describe what you are working on — Piloti shows you, step by step, what is relevant …'
      )
    ).toBeInTheDocument()
  })

  test('renders with custom placeholder', () => {
    render(<InputArea isAuthenticated={true} placeholder="Type your question" />)

    expect(screen.getByPlaceholderText('Type your question')).toBeInTheDocument()
  })

  test('shows sign in placeholder when not authenticated', () => {
    render(<InputArea isAuthenticated={false} />)

    expect(screen.getByPlaceholderText('Sign in to start researching')).toBeInTheDocument()
  })

  test('disables input when not authenticated', () => {
    render(<InputArea isAuthenticated={false} />)

    expect(screen.getByRole('textbox')).toBeDisabled()
  })

  test('disables send button when message is empty', () => {
    render(<InputArea isAuthenticated={true} />)

    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled()
  })

  test('all composer controls are keyboard reachable via tab', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated={true} />)

    const input = screen.getByRole('textbox')
    await user.tab()
    expect(input).toHaveFocus()

    // Order per the click-dummy composer: scope · Datengrundlage · Deep
    // Research, then attach + send (the files counter appears only once files
    // are attached, so it is absent here).
    await user.type(input, 'Hello')
    await user.tab()
    expect(screen.getByRole('button', { name: /search scope/i })).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: /data basis/i })).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: /deep research preference/i })).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: /attach files/i })).toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: /send message/i })).toHaveFocus()
  })

  test('enables send button when message is typed', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated={true} />)

    const input = screen.getByRole('textbox')
    await user.type(input, 'Hello')

    expect(screen.getByRole('button', { name: /send message/i })).not.toBeDisabled()
  })

  test('calls sendMessage when send button is clicked', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated={true} connectionMode="sse" />)

    const input = screen.getByRole('textbox')
    await user.type(input, 'Hello world')
    await user.click(screen.getByRole('button', { name: /send message/i }))

    expect(mockSendMessage).toHaveBeenCalledWith('Hello world')
  })

  test('clears input after sending message', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated={true} connectionMode="sse" />)

    const input = screen.getByRole('textbox')
    await user.type(input, 'Hello world')
    await user.click(screen.getByRole('button', { name: /send message/i }))

    expect(input).toHaveValue('')
  })

  test('sends message on Enter key', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated={true} connectionMode="sse" />)

    const input = screen.getByRole('textbox')
    await user.type(input, 'Hello world{enter}')

    expect(mockSendMessage).toHaveBeenCalledWith('Hello world')
  })

  test('sends message on Cmd+Enter (Meta)', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated={true} connectionMode="sse" />)

    const input = screen.getByRole('textbox')
    await user.type(input, 'Hello world')
    await user.keyboard('{Meta>}{Enter}{/Meta}')

    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(mockSendMessage).toHaveBeenCalledWith('Hello world')
  })

  test('sends message on Ctrl+Enter', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated={true} connectionMode="sse" />)

    const input = screen.getByRole('textbox')
    await user.type(input, 'Hello world')
    await user.keyboard('{Control>}{Enter}{/Control}')

    expect(mockSendMessage).toHaveBeenCalledTimes(1)
    expect(mockSendMessage).toHaveBeenCalledWith('Hello world')
  })

  test('Shift+Enter inserts a newline and does not send', async () => {
    const user = userEvent.setup()
    render(<InputArea isAuthenticated={true} connectionMode="sse" />)

    const input = screen.getByRole('textbox')
    await user.type(input, 'line one')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    await user.type(input, 'line two')

    expect(mockSendMessage).not.toHaveBeenCalled()
    expect(input).toHaveValue('line one\nline two')
  })

  test('disables input when session is busy (streaming)', () => {
    // InputArea uses useIsCurrentSessionBusy() for disable logic.
    // When isBusy is true (e.g. streaming), input is disabled with "Please wait..." placeholder.
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(true)

    render(<InputArea isAuthenticated={true} connectionMode="sse" />)

    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByPlaceholderText('Please wait...')).toBeInTheDocument()
  })

  test('disables input when session is busy (loading)', () => {
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(true)

    render(<InputArea isAuthenticated={true} connectionMode="sse" />)

    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByPlaceholderText('Please wait...')).toBeInTheDocument()
  })

  test('disables input when deep research is in progress', () => {
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(true)
    mockIsDeepResearchStreaming = true
    mockDeepResearchStatus = 'submitted'
    mockDeepResearchOwnerConversationId = 'session-1'
    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    // Input disabled with "Please wait..." placeholder (isBusy is true)
    expect(screen.getByPlaceholderText('Please wait...')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeDisabled()
    // Send button shows "Research in progress" tooltip via isResearchSessionInProgress
    expect(
      screen.getByRole('button', { name: /research in progress - please wait/i })
    ).toBeInTheDocument()
  })

  test('renders attach files button', () => {
    render(<InputArea isAuthenticated={true} />)

    expect(screen.getByRole('button', { name: /attach files/i })).toBeInTheDocument()
  })

  // Note: Research panel button was moved to ResearchPanel component as a toggle tag

  test('shows response mode placeholder when pending interaction', () => {
    vi.mocked(useWebSocketChat).mockReturnValue({
      sendMessage: mockSendMessage,
      isStreaming: false,
      isLoading: false,
      respondToInteraction: mockRespondToInteraction,
      pendingInteraction: { id: 'prompt-1', type: 'input', content: 'Please provide more details' },
    } as unknown as ReturnType<typeof useWebSocketChat>)

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    // In response mode, placeholder changes to indicate responding to agent
    expect(screen.getByPlaceholderText('Type your response to the agent...')).toBeInTheDocument()
  })

  test('calls respondToInteraction in response mode', async () => {
    const user = userEvent.setup()
    vi.mocked(useWebSocketChat).mockReturnValue({
      sendMessage: mockSendMessage,
      isStreaming: false,
      isLoading: false,
      respondToInteraction: mockRespondToInteraction,
      pendingInteraction: { id: 'prompt-1', type: 'input', content: 'Please provide more details' },
    } as unknown as ReturnType<typeof useWebSocketChat>)

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    const input = screen.getByRole('textbox')
    await user.type(input, 'My response')
    await user.click(screen.getByRole('button', { name: /send response/i }))

    expect(mockRespondToInteraction).toHaveBeenCalledWith('My response')
    expect(mockSendMessage).not.toHaveBeenCalled()
  })

  test('shows file count badge and inline chips when files are attached', () => {
    vi.mocked(useFileUpload).mockReturnValue({
      uploadFiles: mockUploadFiles,
      deleteFile: mockDeleteFile,
      retryFile: mockRetryFile,
      sessionFiles: [
        { id: 'file-1', fileName: 'doc.pdf', status: 'success', collectionName: 'session-1' },
        { id: 'file-2', fileName: 'doc2.pdf', status: 'uploading', collectionName: 'session-1' },
      ],
      isUploading: false,
      error: null,
      clearError: vi.fn(),
    } as unknown as ReturnType<typeof useFileUpload>)

    render(<InputArea isAuthenticated={true} />)

    // Manage-files dialog trigger carries the count...
    expect(screen.getByRole('button', { name: /manage attached files/i })).toHaveTextContent('2')
    // ...and each file also shows as an inline removable chip.
    expect(screen.getByText('doc.pdf')).toBeInTheDocument()
    expect(screen.getByText('doc2.pdf')).toBeInTheDocument()
  })

  test('removing an inline file chip calls deleteFile', async () => {
    const user = userEvent.setup()
    vi.mocked(useFileUpload).mockReturnValue({
      uploadFiles: mockUploadFiles,
      deleteFile: mockDeleteFile,
      retryFile: mockRetryFile,
      sessionFiles: [
        { id: 'file-1', fileName: 'doc.pdf', status: 'success', collectionName: 'session-1' },
      ],
      isUploading: false,
      error: null,
      clearError: vi.fn(),
    } as unknown as ReturnType<typeof useFileUpload>)

    render(<InputArea isAuthenticated={true} />)

    await user.click(screen.getByRole('button', { name: /remove file: doc\.pdf/i }))
    expect(mockDeleteFile).toHaveBeenCalledWith('file-1')
  })

  test('shows upload error when present', () => {
    vi.mocked(useFileUpload).mockReturnValue({
      uploadFiles: mockUploadFiles,
      sessionFiles: [],
      isUploading: false,
      error: 'File too large',
      clearError: vi.fn(),
    } as unknown as ReturnType<typeof useFileUpload>)

    render(<InputArea isAuthenticated={true} />)

    expect(screen.getByText('File too large')).toBeInTheDocument()
  })

  test('shows drag overlay when dragging files', () => {
    vi.mocked(useFileDragDrop).mockReturnValue({
      isDragging: true,
      isUnsupportedDrag: false,
      dragHandlers: {
        onDragEnter: vi.fn(),
        onDragLeave: vi.fn(),
        onDragOver: vi.fn(),
        onDrop: vi.fn(),
      },
    })

    render(<InputArea isAuthenticated={true} />)

    expect(screen.getByText('Drop files to upload')).toBeInTheDocument()
  })

  test('shows error drag overlay for unsupported files', () => {
    vi.mocked(useFileDragDrop).mockReturnValue({
      isDragging: true,
      isUnsupportedDrag: true,
      dragHandlers: {
        onDragEnter: vi.fn(),
        onDragLeave: vi.fn(),
        onDragOver: vi.fn(),
        onDrop: vi.fn(),
      },
    })

    render(<InputArea isAuthenticated={true} />)

    expect(screen.getByText('Unsupported file type')).toBeInTheDocument()
  })

  test('disables input when isBusy is true (session has active operations)', () => {
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(true)

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(screen.getByPlaceholderText('Please wait...')).toBeInTheDocument()
  })

  test('enables input when isBusy returns to false', () => {
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(false)

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    expect(screen.getByRole('textbox')).not.toBeDisabled()
  })

  test('shows research completed placeholder when deep research is done', () => {
    mockDeepResearchStatus = 'success'
    mockIsDeepResearchStreaming = false
    mockDeepResearchOwnerConversationId = 'session-1'

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    expect(
      screen.getByPlaceholderText('Research completed. Create a new session for further questions.')
    ).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeDisabled()
  })

  test('shows research completed tooltip on send button when research is done', () => {
    mockDeepResearchStatus = 'success'
    mockIsDeepResearchStreaming = false
    mockDeepResearchOwnerConversationId = 'session-1'

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    expect(
      screen.getByRole('button', { name: /research completed - create new session/i })
    ).toBeInTheDocument()
  })

  test('keeps the composer locked when a persisted message reports success', () => {
    mockConversationMessages = [
      {
        messageType: 'agent_response',
        deepResearchJobId: 'job-1',
        deepResearchJobStatus: 'success',
      },
    ]

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    expect(screen.getByRole('textbox')).toBeDisabled()
    expect(
      screen.getByRole('button', { name: /research completed - create new session/i })
    ).toBeInTheDocument()
  })

  test.each(['failure', 'interrupted'] as const)(
    'unlocks the composer after a %s run so the user can retry or follow up',
    (status) => {
      mockDeepResearchStatus = status
      mockIsDeepResearchStreaming = false
      mockDeepResearchOwnerConversationId = 'session-1'

      render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

      // Composer is enabled with contextual follow-up guidance...
      expect(screen.getByRole('textbox')).not.toBeDisabled()
      expect(
        screen.getByPlaceholderText('Research didn’t finish. Ask a follow-up or try again.')
      ).toBeInTheDocument()
      // ...and the normal send button is shown (no "create new session" lock popover).
      expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /research completed - create new session/i })
      ).not.toBeInTheDocument()
    }
  )

  test('unlocks the composer when a persisted message reports failure', () => {
    mockConversationMessages = [
      {
        messageType: 'agent_response',
        deepResearchJobId: 'job-1',
        deepResearchJobStatus: 'failure',
      },
    ]

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    expect(screen.getByRole('textbox')).not.toBeDisabled()
    expect(
      screen.getByPlaceholderText('Research didn’t finish. Ask a follow-up or try again.')
    ).toBeInTheDocument()
  })

  test('a later success still locks the composer even if an earlier run failed', () => {
    mockConversationMessages = [
      {
        messageType: 'agent_response',
        deepResearchJobId: 'job-1',
        deepResearchJobStatus: 'failure',
      },
      {
        messageType: 'agent_response',
        deepResearchJobId: 'job-2',
        deepResearchJobStatus: 'success',
      },
    ]

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    expect(screen.getByRole('textbox')).toBeDisabled()
  })

  test('shows research in progress send button when deep research is active and streaming', () => {
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(true)
    mockIsDeepResearchStreaming = true
    mockDeepResearchStatus = 'running'
    mockDeepResearchOwnerConversationId = 'session-1'

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    // Input disabled with "Please wait..." placeholder (isBusy is true)
    expect(screen.getByPlaceholderText('Please wait...')).toBeInTheDocument()
    // Send button shows research in progress tooltip
    expect(
      screen.getByRole('button', { name: /research in progress - please wait/i })
    ).toBeInTheDocument()
  })

  test('does not allow sending when session is busy', () => {
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(true)

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    // Input is disabled so typing won't work
    const input = screen.getByRole('textbox')
    expect(input).toBeDisabled()
  })

  test('input enabled during plan approval even when session is busy (HITL override)', async () => {
    // useIsCurrentSessionBusy returns true because pendingInteraction is set,
    // but the input should NOT be disabled so the user can type approve/reject.
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(true)
    vi.mocked(useWebSocketChat).mockReturnValue({
      sendMessage: mockSendMessage,
      isStreaming: false,
      isLoading: false,
      respondToInteraction: mockRespondToInteraction,
      pendingInteraction: { id: 'prompt-1', type: 'input', content: 'Approve plan?' },
    } as unknown as ReturnType<typeof useWebSocketChat>)

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    // Input should be enabled in response mode (plan approval) despite isBusy=true
    expect(screen.getByRole('textbox')).not.toBeDisabled()
    expect(screen.getByPlaceholderText('Type your response to the agent...')).toBeInTheDocument()
    // Send button should be the normal send button, not a research-in-progress popover
    expect(screen.getByRole('button', { name: /send response/i })).toBeInTheDocument()
  })

  test('does not assign positive tab indexes in response mode', () => {
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(true)
    vi.mocked(useWebSocketChat).mockReturnValue({
      sendMessage: mockSendMessage,
      isStreaming: false,
      isLoading: false,
      respondToInteraction: mockRespondToInteraction,
      pendingInteraction: {
        id: 'prompt-1',
        parentId: 'agent-1',
        inputType: 'approval',
        text: 'Approve plan?',
      },
    } as unknown as ReturnType<typeof useWebSocketChat>)

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    expect(screen.getByRole('textbox')).not.toHaveAttribute('tabindex')
    expect(screen.getByRole('button', { name: /send response/i })).not.toHaveAttribute('tabindex')
  })

  test('input enabled during HITL even when deep research is in progress', async () => {
    const user = userEvent.setup()
    // Deep research is running AND there's a pending HITL interaction
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(true)
    mockIsDeepResearchStreaming = true
    mockDeepResearchStatus = 'running'
    mockDeepResearchOwnerConversationId = 'session-1'
    vi.mocked(useWebSocketChat).mockReturnValue({
      sendMessage: mockSendMessage,
      isStreaming: false,
      isLoading: false,
      respondToInteraction: mockRespondToInteraction,
      pendingInteraction: { id: 'prompt-1', type: 'input', content: 'Approve report plan?' },
    } as unknown as ReturnType<typeof useWebSocketChat>)

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    // Input should be enabled for HITL response despite active deep research
    expect(screen.getByRole('textbox')).not.toBeDisabled()
    expect(screen.getByPlaceholderText('Type your response to the agent...')).toBeInTheDocument()
    // Send button should be normal (not research-in-progress popover)
    const sendButton = screen.getByRole('button', { name: /send response/i })
    expect(sendButton).toBeInTheDocument()

    // User can type and submit their response
    await user.type(screen.getByRole('textbox'), 'approve')
    await user.click(sendButton)
    expect(mockRespondToInteraction).toHaveBeenCalledWith('approve')
  })

  describe('per-session composer drafts', () => {
    test('restores the session draft into the composer on mount (survives remount)', () => {
      mockDrafts = { 'session-1': 'a half-typed question' }

      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      expect(screen.getByRole('textbox')).toHaveValue('a half-typed question')
    })

    test('persists typed text to the active session draft', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      await user.type(screen.getByRole('textbox'), 'work in progress')

      expect(mockDrafts['session-1']).toBe('work in progress')
    })

    test('shows each session its own draft when switching sessions', () => {
      mockDrafts = { 'session-1': 'draft one', 'session-2': 'draft two' }

      const { rerender } = render(
        <InputArea isAuthenticated={true} connectionMode="sse" placeholder="a" />
      )
      expect(screen.getByRole('textbox')).toHaveValue('draft one')

      // Switch the active session — the composer must load the other draft. The
      // real component re-renders via its store subscription; with the store
      // mocked, a changed prop stands in to trigger the same re-render.
      mockCurrentSessionId = 'session-2'
      rerender(<InputArea isAuthenticated={true} connectionMode="sse" placeholder="b" />)

      expect(screen.getByRole('textbox')).toHaveValue('draft two')
    })

    test('clears the session draft on a successful send', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      await user.type(screen.getByRole('textbox'), 'send me')
      expect(mockDrafts['session-1']).toBe('send me')

      await user.click(screen.getByRole('button', { name: /send message/i }))

      expect(mockSendMessage).toHaveBeenCalledWith('send me')
      expect('session-1' in mockDrafts).toBe(false)
      expect(screen.getByRole('textbox')).toHaveValue('')
    })

    test('retains the session draft (and text) when a send fails', async () => {
      const user = userEvent.setup()
      mockSendMessage.mockImplementationOnce(() => {
        throw new Error('network down')
      })
      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      await user.type(screen.getByRole('textbox'), 'do not lose me')
      await user.click(screen.getByRole('button', { name: /send message/i }))

      // Failed send keeps both the persisted draft and the restored input text.
      expect(mockDrafts['session-1']).toBe('do not lose me')
      expect(screen.getByRole('textbox')).toHaveValue('do not lose me')
    })

    test('a prefill fills an empty composer and becomes the session draft', () => {
      mockComposerPrefill = 'prefilled question'

      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      expect(screen.getByRole('textbox')).toHaveValue('prefilled question')
      expect(mockDrafts['session-1']).toBe('prefilled question')
    })

    test('a prefill does not clobber an existing non-empty draft', () => {
      mockDrafts = { 'session-1': 'my own in-progress text' }
      mockComposerPrefill = 'chip suggestion'

      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      // Existing draft wins; the prefill is dropped (consumed without applying).
      expect(screen.getByRole('textbox')).toHaveValue('my own in-progress text')
      expect(mockDrafts['session-1']).toBe('my own in-progress text')
      expect(mockComposerPrefill).toBeNull()
    })
  })

  describe('composer control row (WS-3)', () => {
    test('sources summary chip shows the enabled count and opens the sources popover', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      const chip = screen.getByRole('button', { name: /data basis/i })
      expect(chip).toHaveTextContent('2')

      await user.click(chip)

      // The chip now opens an in-composer popover (no right panel) hosting the
      // connection toggles + an enable/disable-all control.
      expect(screen.getByText('Disable / Enable All')).toBeInTheDocument()
      expect(mockOpenRightPanel).not.toHaveBeenCalled()
    })

    test('the sources popover enable/disable-all toggles every source and persists', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      await user.click(screen.getByRole('button', { name: /data basis/i }))
      // All sources enabled by default → the control disables all (empty set).
      await user.click(screen.getByText('Disable / Enable All'))

      expect(mockSetEnabledDataSources).toHaveBeenCalledWith([])
      expect(mockSaveDataSourcesToConversation).toHaveBeenCalledWith([])
    })

    test('shows a stop button while streaming and cancels via stopStreaming (C1)', async () => {
      const user = userEvent.setup()
      mockIsStreaming = true
      vi.mocked(useIsCurrentSessionBusy).mockReturnValue(true)

      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      // The normal send button is replaced by a stop control while streaming.
      expect(screen.queryByRole('button', { name: /send message/i })).not.toBeInTheDocument()
      const stop = screen.getByRole('button', { name: /stop response/i })
      await user.click(stop)
      expect(mockStopStreaming).toHaveBeenCalledTimes(1)
    })

    test('deep research pill toggles the stored intent (off → on)', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      const pill = screen.getByRole('button', { name: /deep research preference/i })
      expect(pill).toHaveAttribute('aria-pressed', 'false')

      await user.click(pill)

      expect(mockSetDeepResearchIntent).toHaveBeenCalledWith(true)
    })

    test('deep research pill shows the honest auto-escalation hint when on', () => {
      mockDeepResearchIntent = true

      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      expect(
        screen.getByRole('button', { name: /deep research preference/i })
      ).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByText(/escalates to deep research automatically/i)).toBeInTheDocument()
    })

    test('scope chip shows the project name and a disabled "All projects" option', async () => {
      const user = userEvent.setup()
      render(
        <InputArea isAuthenticated={true} connectionMode="sse" projectName="Wohnbau Favoriten" />
      )

      const scopeChip = screen.getByRole('button', { name: /search scope/i })
      expect(scopeChip).toHaveTextContent('Wohnbau Favoriten')

      await user.click(scopeChip)

      const allProjects = screen.getByRole('button', { name: /all projects/i })
      expect(allProjects).toBeDisabled()
    })

    test('shortcut preset chip applies the mapped source subset and persists it', async () => {
      const user = userEvent.setup()
      mockAvailableDataSources = [
        { id: 'web_search', name: 'Web Search' },
        { id: 'ris', name: 'RIS – Österreichisches Recht' },
      ]

      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      await user.click(screen.getByRole('button', { name: /building law & guidelines/i }))

      // Law preset maps onto the REAL sources: only `ris` matches.
      expect(mockApplySourcePreset).toHaveBeenCalledWith('law', ['ris'])
      expect(mockSaveDataSourcesToConversation).toHaveBeenCalledWith(['ris'])
    })

    test('clicking the active preset restores all sources and clears the preset', async () => {
      const user = userEvent.setup()
      mockActiveSourcePreset = 'law'
      mockAvailableDataSources = [
        { id: 'web_search', name: 'Web Search' },
        { id: 'ris', name: 'RIS – Österreichisches Recht' },
      ]

      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      const lawChip = screen.getByRole('button', { name: /building law & guidelines/i })
      expect(lawChip).toHaveAttribute('aria-pressed', 'true')

      await user.click(lawChip)

      expect(mockApplySourcePreset).toHaveBeenCalledWith(null, ['web_search', 'ris'])
      expect(mockSaveDataSourcesToConversation).toHaveBeenCalledWith(['web_search', 'ris'])
    })

    test('active preset renders a provenance chip inside the composer', () => {
      mockActiveSourcePreset = 'law'

      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      // The colored provenance chip (icon + label) inside the composer card,
      // in addition to the pressed shortcut chip below it.
      expect(screen.getAllByText('Building law & guidelines').length).toBeGreaterThanOrEqual(2)
    })

    test('shortcut chips are hidden once the thread has messages', () => {
      mockConversationMessages = [
        { id: 'msg-1', role: 'user', content: 'Hello', messageType: 'user' },
      ]

      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      expect(
        screen.queryByRole('button', { name: /building law & guidelines/i })
      ).not.toBeInTheDocument()
    })
  })
})
