import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { toast } from 'sonner'
import type { ComposerPrefill } from '@/features/chat/types'
import { InputArea } from './InputArea'

// Transient send failures surface as toasts; spy on them rather than render them.
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}))

// Mock the chat hooks
const mockSendMessage = vi.fn()
const mockRespondToInteraction = vi.fn()
// Intent to send (composer focus / submit) — what opens the agent socket in a
// shared thread. Part of the hook's surface, so every stubbed return needs it.
const mockNoteSendIntent = vi.fn()

let mockIsDeepResearchStreaming = false
let mockDeepResearchStatus: string | null = null
let mockDeepResearchOwnerConversationId: string | null = null
let mockConversationMessages: unknown[] | undefined = []
// Active session id (null models the "new session draft" state with no id yet).
let mockCurrentSessionId: string | null = 'session-1'
// One-shot prefill queued from a deep link / chip.
let mockComposerPrefill: ComposerPrefill | null = null
// Real-ish per-session draft store, so component tests exercise genuine
// save/restore/clear behaviour rather than asserting on spy calls alone.
let mockDrafts: Record<string, string> = {}
// Shallow-thinking stream state + cancel action for the composer stop button.
let mockIsStreaming = false
const mockStopStreaming = vi.fn()
// Real new-session action (startNewSessionDraft) wired to the post-research
// "Start new session" button.
const mockStartNewSessionDraft = vi.fn()

const mockSaveDataSourcesToConversation = vi.fn()

vi.mock('@/features/chat', () => ({
  useWebSocketChat: vi.fn(() => ({
    sendMessage: mockSendMessage,
    isStreaming: false,
    isLoading: false,
    respondToInteraction: mockRespondToInteraction,
    noteSendIntent: mockNoteSendIntent,
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
      startNewSessionDraft: mockStartNewSessionDraft,
      setRespondToInteractionFn: vi.fn(),
      setChatSendFn: vi.fn(),
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

// Mention candidates for the `@` picker. Mocked at the hook boundary so the
// composer tests never touch the network; the picker itself is unit-tested in
// features/collaboration/components/MentionPicker.spec.tsx.
const AGENT_CANDIDATE = {
  targetId: 'agent:piloti',
  person: { userId: 'agent:piloti', name: 'Piloti', email: null, profilePictureUrl: null },
  isAgent: true,
  isParticipant: true,
  needsInvite: false,
}
const ANNA_CANDIDATE = {
  targetId: 'u-anna',
  person: {
    userId: 'u-anna',
    name: 'Anna Weber',
    email: 'anna@example.com',
    profilePictureUrl: null,
  },
  isAgent: false,
  isParticipant: true,
  needsInvite: false,
}
const MARKUS_CANDIDATE = {
  targetId: 'u-markus',
  person: {
    userId: 'u-markus',
    name: 'Markus Hofer',
    email: 'markus@example.com',
    profilePictureUrl: null,
  },
  isAgent: false,
  isParticipant: true,
  needsInvite: false,
}

let mockMentionData: unknown = {
  candidates: [AGENT_CANDIDATE, ANNA_CANDIDATE, MARKUS_CANDIDATE],
  canInvite: true,
}
let mockMentionsLoading = false

// The thread-level hand-off state behind the composer's addressee line. Mocked at
// the hook boundary for the same reason: its own fetching/refresh behaviour is the
// hook's business, and the composer only ever reads the derived answer.
let mockAwaitingPending: Array<{ id: string }> = []

vi.mock('@/features/collaboration/hooks/use-sharing', () => ({
  // Honours `enabled` for the same reason `useAwaitingState` below does, and it
  // is not cosmetic: a mock that answered regardless of the gate is what let the
  // composer ship a picker that flashed open on `@` in a deployment with
  // collaboration off. The stub has to refuse where the endpoint would.
  useMentionCandidates: vi.fn((_conversationId: string | null, enabled: boolean) => ({
    data: enabled ? mockMentionData : null,
    loading: enabled ? mockMentionsLoading : false,
  })),
  useAwaitingState: vi.fn((_conversationId: string | null, enabled: boolean) => ({
    // A gated org never gets an answer — which is what keeps the composer
    // byte-identical to today with the flag off (spec NF-8).
    awaiting: enabled ? { pending: mockAwaitingPending, awaitingMe: false } : null,
    refresh: vi.fn(),
    release: vi.fn(),
  })),
}))

// FileSourcesTab is imported by InputArea for the "manage files" dialog; it
// pulls a large dependency graph that is irrelevant to composer unit tests.
vi.mock('./FileSourcesTab', () => ({
  FileSourcesTab: () => null,
}))

// FilePreviewDialog is the shared read-only preview opened from a file chip; the
// real component pulls the whole preview-pane graph (PDF viewer, fetches). Stub
// it to a lightweight marker that surfaces the previewed file's name, so the
// clickable-chip → preview behavior can be asserted in isolation.
vi.mock('@/features/documents/components/file-preview-dialog', () => ({
  FilePreviewDialog: ({ file }: { file: { filename: string } | null }) =>
    file ? <div data-testid="file-preview">{file.filename}</div> : null,
}))

import { useWebSocketChat, useIsCurrentSessionBusy } from '@/features/chat'
import { useFileUpload, useFileDragDrop } from '@/features/documents'
import { useMentionCandidates } from '@/features/collaboration/hooks/use-sharing'

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
    mockMentionData = {
      candidates: [AGENT_CANDIDATE, ANNA_CANDIDATE, MARKUS_CANDIDATE],
      canInvite: true,
    }
    mockMentionsLoading = false
    mockAwaitingPending = []
    // Reset mocks to defaults - clearAllMocks doesn't reset mockReturnValue
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(false)
    vi.mocked(useWebSocketChat).mockReturnValue({
      sendMessage: mockSendMessage,
      isStreaming: false,
      isLoading: false,
      respondToInteraction: mockRespondToInteraction,
      noteSendIntent: mockNoteSendIntent,
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
      screen.getByPlaceholderText('Ask Piloti about this project …')
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
      noteSendIntent: mockNoteSendIntent,
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
      noteSendIntent: mockNoteSendIntent,
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

  test('clicking a successful file chip opens the read-only preview dialog', async () => {
    const user = userEvent.setup()
    vi.mocked(useFileUpload).mockReturnValue({
      uploadFiles: mockUploadFiles,
      deleteFile: mockDeleteFile,
      retryFile: mockRetryFile,
      sessionFiles: [
        {
          id: 'file-1',
          fileName: 'doc.pdf',
          fileSize: 1234,
          status: 'success',
          collectionName: 'session-1',
        },
      ],
      isUploading: false,
      error: null,
      clearError: vi.fn(),
    } as unknown as ReturnType<typeof useFileUpload>)

    render(<InputArea isAuthenticated={true} />)

    // Closed initially — the preview only opens on an explicit chip click.
    expect(screen.queryByTestId('file-preview')).not.toBeInTheDocument()

    // The chip body is a button that opens the shared preview for that file.
    await user.click(screen.getByRole('button', { name: /open file: doc\.pdf/i }))

    expect(screen.getByTestId('file-preview')).toHaveTextContent('doc.pdf')
  })

  test('a still-uploading file chip is not clickable to open a preview', () => {
    vi.mocked(useFileUpload).mockReturnValue({
      uploadFiles: mockUploadFiles,
      deleteFile: mockDeleteFile,
      retryFile: mockRetryFile,
      sessionFiles: [
        { id: 'file-1', fileName: 'up.pdf', status: 'uploading', collectionName: 'session-1' },
      ],
      isUploading: false,
      error: null,
      clearError: vi.fn(),
    } as unknown as ReturnType<typeof useFileUpload>)

    render(<InputArea isAuthenticated={true} />)

    // No open affordance for an in-flight file, and the preview stays closed.
    expect(screen.queryByRole('button', { name: /open file: up\.pdf/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('file-preview')).not.toBeInTheDocument()
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

    const { container } = render(<InputArea isAuthenticated={true} />)

    expect(screen.getByText('Drop files to upload')).toBeInTheDocument()
    // Tailwind v4 preflight resets border-width to 0, so the dashed
    // drop-target ring needs an explicit border-width class alongside
    // border-color/border-style to render at all (regression coverage).
    const composer = container.querySelector('.border-brand.border-dashed')
    expect(composer).toHaveClass('border-2')
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

    const { container } = render(<InputArea isAuthenticated={true} />)

    expect(screen.getByText('Unsupported file type')).toBeInTheDocument()
    const composer = container.querySelector('.border-error.border-dashed')
    expect(composer).toHaveClass('border-2')
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

  test('shows the "Start new session" forward action on the send slot when research is done', () => {
    mockDeepResearchStatus = 'success'
    mockIsDeepResearchStreaming = false
    mockDeepResearchOwnerConversationId = 'session-1'

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    // The old no-op explanation popover is replaced by an actionable button.
    expect(screen.getByRole('button', { name: /start new session/i })).toBeInTheDocument()
  })

  test('the post-research "Start new session" button starts a fresh session draft', async () => {
    const user = userEvent.setup()
    mockDeepResearchStatus = 'success'
    mockIsDeepResearchStreaming = false
    mockDeepResearchOwnerConversationId = 'session-1'

    render(<InputArea isAuthenticated={true} connectionMode="websocket" />)

    await user.click(screen.getByRole('button', { name: /start new session/i }))

    // Wired to the real new-session action (the same startNewSessionDraft the
    // logo / new-session path uses), turning the dead-end into a forward action.
    expect(mockStartNewSessionDraft).toHaveBeenCalledTimes(1)
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
    expect(screen.getByRole('button', { name: /start new session/i })).toBeInTheDocument()
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
      // ...and the normal send button is shown (no "start new session" lock).
      expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: /start new session/i })
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
      noteSendIntent: mockNoteSendIntent,
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
      noteSendIntent: mockNoteSendIntent,
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
      noteSendIntent: mockNoteSendIntent,
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
      mockComposerPrefill = { text: 'prefilled question' }

      render(<InputArea isAuthenticated={true} connectionMode="sse" />)

      expect(screen.getByRole('textbox')).toHaveValue('prefilled question')
      expect(mockDrafts['session-1']).toBe('prefilled question')
    })

    test('a prefill does not clobber an existing non-empty draft', () => {
      mockDrafts = { 'session-1': 'my own in-progress text' }
      mockComposerPrefill = { text: 'chip suggestion' }

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

  /**
   * @-mentions in the composer (spec MN-3, MN-4, MN-7).
   *
   * The picker itself is covered in MentionPicker.spec.tsx; these tests are about
   * the composer's half of the contract: the trigger, the keyboard (Enter must
   * NEVER submit while the picker is open), what is inserted, what is finally sent,
   * and what the user is told before they send it.
   */
  describe('@-mentions', () => {
    const composer = () => screen.getByPlaceholderText('Ask Piloti about this project …')
    /** The candidates on screen. Read by target id: a highlighted name is split
        across elements, so a text query would be brittle. */
    const optionTargets = () =>
      screen.getAllByTestId('mention-option').map((row) => row.getAttribute('data-target-id'))

    test('typing @ at a word boundary opens the picker', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('Frage an @')

      expect(await screen.findByTestId('mention-picker')).toBeInTheDocument()
      expect(screen.getByText('Anna Weber')).toBeInTheDocument()
      expect(screen.getByText('Piloti')).toBeInTheDocument()
    })

    test('typing after the @ filters the candidates', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@hof')

      expect(await screen.findByTestId('mention-picker')).toBeInTheDocument()
      expect(optionTargets()).toEqual(['u-markus'])
    })

    test('does not open inside a word — an email address is not a mention', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('anna@example.com')

      expect(screen.queryByTestId('mention-picker')).not.toBeInTheDocument()
    })

    test('Enter inserts the selected candidate and does NOT send the message', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@anna')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Enter}')

      expect(composer()).toHaveValue('@Anna Weber ')
      expect(mockSendMessage).not.toHaveBeenCalled()
      expect(screen.queryByTestId('mention-picker')).not.toBeInTheDocument()
    })

    test('Tab inserts too', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@anna')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Tab}')

      expect(composer()).toHaveValue('@Anna Weber ')
    })

    test('the arrow keys choose which candidate is inserted', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@')
      await screen.findByTestId('mention-picker')
      // Piloti is pinned first; one step down lands on Anna.
      await user.keyboard('{ArrowDown}{Enter}')

      expect(composer()).toHaveValue('@Anna Weber ')
    })

    test('Escape closes the picker, and a fresh @ opens it again', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@an')
      await screen.findByTestId('mention-picker')

      await user.keyboard('{Escape}')
      expect(screen.queryByTestId('mention-picker')).not.toBeInTheDocument()

      await user.keyboard(' und @ma')
      expect(await screen.findByTestId('mention-picker')).toBeInTheDocument()
      expect(optionTargets()).toEqual(['u-markus'])
    })

    test('deleting the @ closes the picker', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@a')
      await screen.findByTestId('mention-picker')

      await user.keyboard('{Backspace}{Backspace}')
      expect(screen.queryByTestId('mention-picker')).not.toBeInTheDocument()
    })

    test('the textarea is a combobox pointing at the active option while open', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@an')
      await screen.findByTestId('mention-picker')

      const input = composer()
      expect(input).toHaveAttribute('role', 'combobox')
      expect(input).toHaveAttribute('aria-expanded', 'true')
      expect(input).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
      await waitFor(() =>
        expect(input).toHaveAttribute(
          'aria-activedescendant',
          screen.getAllByRole('option')[0].id,
        ),
      )

      // Closed again: no dangling aria-controls to a listbox that is gone.
      await user.keyboard('{Escape}')
      expect(composer()).not.toHaveAttribute('aria-controls')
      expect(composer()).not.toHaveAttribute('aria-expanded')
    })

    test('once a human is tagged the composer says the agent will stay quiet', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@anna')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Enter}')

      expect(screen.getByTestId('composer-mention-hint')).toHaveTextContent(
        'Piloti will stay quiet — Anna Weber is being asked.',
      )
    })

    test('tagging only the assistant does not claim it will stay quiet', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@pil')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Enter}')

      expect(composer()).toHaveValue('@Piloti ')
      expect(screen.queryByTestId('composer-mention-hint')).not.toBeInTheDocument()
    })

    test('sending passes the STRUCTURED mentions, not the text', async () => {
      const user = userEvent.setup()
      mockSendMessage.mockResolvedValue({ ok: true, addressees: { agent: false, users: ['u-anna'] } })
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@anna')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Enter}')
      await user.keyboard('passt das?')
      await user.click(screen.getByRole('button', { name: /send message/i }))

      expect(mockSendMessage).toHaveBeenCalledWith('@Anna Weber passt das?', {
        mentions: [{ targetId: 'u-anna', display: 'Anna Weber' }],
      })
      expect(composer()).toHaveValue('')
      // The hint goes with the sent message.
      expect(screen.queryByTestId('composer-mention-hint')).not.toBeInTheDocument()
    })

    test('deleting the inserted token deletes the mention (MN-3)', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@anna')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Enter}')
      expect(screen.getByTestId('composer-mention-hint')).toBeInTheDocument()

      // The token is edited away: the mention goes with it, and the message is
      // sent with no mentions at all (so the agent answers as usual).
      await user.clear(composer())
      await user.keyboard('doch nicht, danke')
      expect(screen.queryByTestId('composer-mention-hint')).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /send message/i }))
      expect(mockSendMessage).toHaveBeenCalledWith('doch nicht, danke')
    })

    test('a refused mention keeps the text and explains the refusal', async () => {
      const user = userEvent.setup()
      mockSendMessage.mockResolvedValue({
        ok: false,
        failure: { reason: 'mention-invite-requires-owner', message: 'refused' },
      })
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@anna')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Enter}')
      await user.click(screen.getByRole('button', { name: /send message/i }))

      // Nothing is lost: text AND the picked mention survive for another attempt.
      await waitFor(() => expect(composer()).toHaveValue('@Anna Weber'))
      expect(screen.getByTestId('composer-mention-hint')).toBeInTheDocument()
      expect(toast.error).toHaveBeenCalledWith(
        'You can only mention people who are already in this conversation. Ask an owner to invite Anna Weber.',
        expect.anything(),
      )
    })

    test('a rate-limited mention says so', async () => {
      const user = userEvent.setup()
      mockSendMessage.mockResolvedValue({
        ok: false,
        failure: { reason: 'mention-rate-limited', message: null },
      })
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@anna')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Enter}')
      await user.click(screen.getByRole('button', { name: /send message/i }))

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          'Too many mentions. Please wait a few minutes.',
          expect.anything(),
        ),
      )
    })

    test('without a candidate list the composer behaves exactly as before (NF-8)', async () => {
      const user = userEvent.setup()
      mockMentionData = null
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@anna')

      expect(screen.queryByTestId('mention-picker')).not.toBeInTheDocument()
      // No combobox semantics at all: it is the plain textarea it always was.
      expect(composer()).not.toHaveAttribute('role')

      await user.keyboard('{Enter}')
      expect(mockSendMessage).toHaveBeenCalledWith('@anna')
    })

    test('while the candidates load the picker shows its skeleton rows', async () => {
      const user = userEvent.setup()
      mockMentionData = null
      mockMentionsLoading = true
      render(<InputArea isAuthenticated={true} canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@')

      expect(await screen.findByTestId('mention-picker')).toBeInTheDocument()
      expect(screen.getByText('Loading people…')).toBeInTheDocument()
    })

    /**
     * With collaboration off the composer must be byte-identical to the one that
     * shipped before the feature existed (spec NF-8) — and "identical" includes
     * the moment between keystroke and answer. The bug these two pin: the
     * candidate fetch ran regardless of the gate, and the loading state alone
     * opened the picker, so a user on a deployment WITHOUT collaboration saw a
     * panel flash open on `@` and vanish when the route answered 403.
     */
    describe('with collaboration off', () => {
      test('typing @ opens nothing, even while a load could be in flight', async () => {
        const user = userEvent.setup()
        mockMentionData = null
        mockMentionsLoading = true
        render(<InputArea isAuthenticated={true} connectionMode="sse" />)

        await user.click(composer())
        await user.keyboard('Frage an @')

        expect(screen.queryByTestId('mention-picker')).not.toBeInTheDocument()
        // The textarea keeps its plain semantics: no combobox, nothing to navigate.
        expect(composer()).not.toHaveAttribute('role')
      })

      test('never asks the server who could be mentioned', async () => {
        const user = userEvent.setup()
        render(<InputArea isAuthenticated={true} connectionMode="sse" />)

        await user.click(composer())
        await user.keyboard('@ann')

        // The gate belongs on the request, not on the rendering of its result:
        // a disabled feature must not generate the round-trip at all.
        expect(vi.mocked(useMentionCandidates)).toHaveBeenCalled()
        for (const call of vi.mocked(useMentionCandidates).mock.calls) {
          expect(call[1]).toBe(false)
        }
      })
    })
  })

  /**
   * The composer's statement of who receives the message (ADR-0034 addendum).
   *
   * The behaviour was already right server-side and completely invisible, which is
   * the defect these tests pin: the line must be there in EVERY state (an absence
   * teaches nothing), and it must change as the state changes — that transition is
   * what teaches the two-state model.
   */
  describe('addressee indicator', () => {
    const composer = () => screen.getByPlaceholderText('Ask Piloti about this project …')
    const addressee = () => screen.getByTestId('composer-addressee')

    test('states that a plain message goes to Piloti, before anything happens', () => {
      render(<InputArea isAuthenticated canCollaborate connectionMode="sse" />)

      expect(addressee()).toHaveTextContent('Goes to Piloti')
      expect(addressee()).toHaveAttribute('data-mode', 'agent')
    })

    test('switches to the tagged person as the mention is inserted', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated canCollaborate connectionMode="sse" />)

      expect(addressee()).toHaveTextContent('Goes to Piloti')

      await user.click(composer())
      await user.keyboard('@anna')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Enter}')

      expect(addressee()).toHaveTextContent('Goes to Anna Weber')
      expect(addressee()).toHaveAttribute('data-mode', 'people')
      // …and back again when the token is edited away (MN-3).
      await user.clear(composer())
      expect(addressee()).toHaveTextContent('Goes to Piloti')
    })

    test('says the message goes to the CHAT while the thread awaits a person, and how to reach Piloti', () => {
      mockAwaitingPending = [{ id: 'r-1' }]
      render(<InputArea isAuthenticated canCollaborate connectionMode="sse" />)

      expect(addressee()).toHaveTextContent('Goes to the chat')
      expect(screen.getByTestId('composer-agent-hint')).toHaveTextContent(
        'Type @Piloti to ask Piloti',
      )
    })

    test('typing @Piloti while awaiting flips the line back to the agent', async () => {
      const user = userEvent.setup()
      mockAwaitingPending = [{ id: 'r-1' }]
      render(<InputArea isAuthenticated canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@pil')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Enter}')

      expect(addressee()).toHaveTextContent('Goes to Piloti')
      // The "type @Piloti" hint has done its job and steps aside.
      expect(screen.queryByTestId('composer-agent-hint')).not.toBeInTheDocument()
    })

    test('tagging a person AND Piloti names both and drops the "stays quiet" claim', async () => {
      const user = userEvent.setup()
      render(<InputArea isAuthenticated canCollaborate connectionMode="sse" />)

      await user.click(composer())
      await user.keyboard('@anna')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Enter}')
      await user.keyboard('@pil')
      await screen.findByTestId('mention-picker')
      await user.keyboard('{Enter}')

      expect(addressee()).toHaveTextContent('Goes to Anna Weber, Piloti')
      expect(screen.queryByTestId('composer-mention-hint')).not.toBeInTheDocument()
    })

    test('with collaboration off the composer is exactly today’s — no line, no hint (NF-8)', async () => {
      const user = userEvent.setup()
      // Even with a wait outstanding server-side, a gated org must see nothing.
      mockAwaitingPending = [{ id: 'r-1' }]
      render(<InputArea isAuthenticated connectionMode="sse" />)

      expect(screen.queryByTestId('composer-addressee')).not.toBeInTheDocument()
      expect(screen.queryByTestId('composer-agent-hint')).not.toBeInTheDocument()

      // And the composer still sends exactly as it always did.
      await user.click(composer())
      await user.keyboard('Frage')
      await user.click(screen.getByRole('button', { name: /send message/i }))
      expect(mockSendMessage).toHaveBeenCalledWith('Frage')
    })
  })

  /**
   * The send has to agree with what the addressee line just told the user
   * (ADR-0034 addendum). While the thread waits on a named person, a plain message
   * is a remark — so it goes through the server's ruling and reaches the agent as
   * CONTEXT, not as a question. The line says "Goes to the chat"; this is the wiring
   * that makes that true.
   */
  describe('the send agrees with the addressee line', () => {
    const composer = () => screen.getByPlaceholderText('Ask Piloti about this project …')

    const send = async (text: string) => {
      const user = userEvent.setup()
      await user.click(composer())
      await user.keyboard(text)
      await user.click(screen.getByRole('button', { name: /send message/i }))
    }

    test('a plain message while a person is awaited asks the server to rule', async () => {
      mockAwaitingPending = [{ id: 'r-1' }]
      render(<InputArea isAuthenticated canCollaborate connectionMode="sse" />)

      await send('Ja, eigener Abschnitt.')

      expect(mockSendMessage).toHaveBeenCalledWith('Ja, eigener Abschnitt.', {
        awaitingHuman: true,
      })
    })

    test('a plain message in the normal state stays the one-argument fast path', async () => {
      render(<InputArea isAuthenticated canCollaborate connectionMode="sse" />)

      await send('Wie breit muss der Fluchtweg sein?')

      expect(mockSendMessage).toHaveBeenCalledWith('Wie breit muss der Fluchtweg sein?')
    })

    test('a gated org never takes the ruled path, wait or no wait (NF-8)', async () => {
      mockAwaitingPending = [{ id: 'r-1' }]
      render(<InputArea isAuthenticated connectionMode="sse" />)

      const user = userEvent.setup()
      await user.click(screen.getByRole('textbox'))
      await user.keyboard('Frage')
      await user.click(screen.getByRole('button', { name: /send message/i }))

      expect(mockSendMessage).toHaveBeenCalledWith('Frage')
    })
  })
})

/**
 * The composer's half of the intent-driven agent socket.
 *
 * The decision of WHETHER a socket may be opened lives in `useWebSocketChat` (and
 * is tested there against the real WS client). What belongs here is the wiring: the
 * flag is handed to the hook, and focus is what declares intent.
 */
describe('InputArea — intent to send opens the agent socket', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCurrentSessionId = 'session-1'
    mockConversationMessages = []
    mockDrafts = {}
    mockComposerPrefill = null
    mockAwaitingPending = []
    mockIsStreaming = false
    mockAvailableDataSources = [{ id: 'source-1' }, { id: 'source-2' }]
    vi.mocked(useIsCurrentSessionBusy).mockReturnValue(false)
    vi.mocked(useWebSocketChat).mockReturnValue({
      sendMessage: mockSendMessage,
      isStreaming: false,
      isLoading: false,
      respondToInteraction: mockRespondToInteraction,
      noteSendIntent: mockNoteSendIntent,
      pendingInteraction: null,
    } as unknown as ReturnType<typeof useWebSocketChat>)
  })

  test('the collaboration flag reaches the socket layer, which is what defers the connect', () => {
    render(<InputArea isAuthenticated canCollaborate />)

    expect(vi.mocked(useWebSocketChat)).toHaveBeenCalledWith({
      autoConnect: true,
      canCollaborate: true,
    })
  })

  test('a gated org passes canCollaborate: false, so the socket opens on mount as today', () => {
    render(<InputArea isAuthenticated />)

    expect(vi.mocked(useWebSocketChat)).toHaveBeenCalledWith({
      autoConnect: true,
      canCollaborate: false,
    })
  })

  test('nothing is declared by merely rendering the composer', () => {
    render(<InputArea isAuthenticated canCollaborate />)

    expect(mockNoteSendIntent).not.toHaveBeenCalled()
  })

  test('focusing the composer declares it', async () => {
    render(<InputArea isAuthenticated canCollaborate />)

    const user = userEvent.setup()
    await user.click(screen.getByRole('textbox'))

    expect(mockNoteSendIntent).toHaveBeenCalled()
  })

  test('a send declares it too, for the paths that never fire a focus event', async () => {
    // A restored draft puts text in the composer without anyone focusing it, so the
    // send button is reachable with no focus event on the textarea.
    mockDrafts = { 'session-1': 'Wie breit muss der Fluchtweg sein?' }
    render(<InputArea isAuthenticated canCollaborate connectionMode="sse" />)

    await waitFor(() =>
      expect(screen.getByRole('textbox')).toHaveValue('Wie breit muss der Fluchtweg sein?')
    )
    expect(mockNoteSendIntent).not.toHaveBeenCalled()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /send message/i }))

    expect(mockNoteSendIntent).toHaveBeenCalled()
    expect(mockSendMessage).toHaveBeenCalled()
  })
})
