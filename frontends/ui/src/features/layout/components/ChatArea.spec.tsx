import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ChatArea } from './ChatArea'
import type { ChatStoreWithHydration } from '@/features/chat/store'
import type { ChatMessage, ThinkingStep } from '@/features/chat/types'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { UseSpectatedTurnOptions } from '@/features/collaboration/hooks/use-spectated-turn'
import type { SpectatedTurnState } from '@/features/collaboration/lib/spectator-frames'

/**
 * The store slice and the messages ChatArea reads, as these tests fixture them.
 * Both are the SHARED deep-partial boundary (`@/test-utils/store-fixtures`), so
 * each test still supplies only the fields its assertion needs while every field
 * name and value type is checked against the real store and `ChatMessage` —
 * fixture drift is a compile error rather than a mystery at runtime.
 */
type ChatStoreFixture = DeepPartial<ChatStoreWithHydration>
type MessageFixture = DeepPartial<ChatMessage>

// Mock the chat store
const mockRespondToPrompt = vi.fn()
const mockDismissErrorCard = vi.fn()
const mockSetComposerPrefill = vi.fn()
const mockGetThinkingStepsForMessage = vi.fn((_messageId: string): ThinkingStep[] => [])
const mockChatThinking = vi.fn((_props: unknown) => <div data-testid="chat-thinking">Thinking...</div>)

/** A real `ThinkingStep`; the stubbed `ChatThinking` only reads how many there are. */
const thinkingStep = (overrides: Partial<ThinkingStep> = {}): ThinkingStep => ({
  id: 'step-1',
  userMessageId: 'user-1',
  category: 'tools',
  functionName: 'web_search_tool',
  displayName: 'Step 1',
  content: '',
  timestamp: new Date('2026-07-29T08:00:00Z'),
  isComplete: true,
  ...overrides,
})

// The welcome state greets the user by first name via useAuth; mocked here so
// tests don't need the AppConfig/AuthKit provider stack.
let mockUserName: string | null = 'Max Mustermann'

vi.mock('@/adapters/auth', () => ({
  useAuth: vi.fn(() => ({
    isAuthenticated: true,
    user: mockUserName ? { id: 'user-1', name: mockUserName } : null,
  })),
}))

/**
 * The project the welcome state is in, and the models it finds there — the two
 * inputs that decide whether the empty canvas offers to ask the BUILDING
 * anything. Mutable so a test can be in a project with a readable model, in one
 * whose model is still extracting, or nowhere at all.
 */
let mockProjectId: string | null = null
let mockBimModels: { status: string }[] | null = null

vi.mock('@/features/bim/hooks/use-bim-model', () => ({
  useProjectBimModels: (projectId: string | null) => ({
    // Mirrors the real hook: no project, no request, no data.
    data: projectId ? mockBimModels : null,
    isLoading: false,
    error: null,
    reload: () => {},
  }),
}))

vi.mock('@/features/chat', () => ({
  useChatStore: vi.fn((selector?: StoreSelector<ChatStoreWithHydration>) => {
    const state: ChatStoreFixture = {
      currentConversation: { messages: [] },
      projectId: mockProjectId,
      isLoading: false,
      isStreaming: false,
      hasHydrated: true,
      thinkingSteps: [],
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
      setComposerPrefill: mockSetComposerPrefill,
      getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
    }
    return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
  }),
  AgentPrompt: ({ content }: { content: string }) => (
    <div data-testid="agent-prompt">{content}</div>
  ),
  AgentResponse: ({ content }: { content: string }) => (
    <div data-testid="agent-response">{content}</div>
  ),
  ErrorBanner: ({ message }: { message: string }) => <div data-testid="error-card">{message}</div>,
  // The stub surfaces the multi-author props so ChatArea's own derivation
  // (who wrote what, and which messages group) is assertable here, while the
  // bubble's rendering stays covered by UserMessage.spec.
  UserMessage: ({
    content,
    author,
    grouped,
  }: {
    content: string
    author?: { name?: string | null; isYou?: boolean }
    grouped?: boolean
  }) => (
    <div
      data-testid="user-message"
      data-author={author ? (author.isYou ? 'you' : (author.name ?? 'unknown')) : undefined}
      data-grouped={grouped ? 'true' : undefined}
    >
      {content}
    </div>
  ),
  ChatThinking: (props: unknown) => mockChatThinking(props),
  // Only the bottom-of-thread typing cue (`TypingIndicator`, defined in
  // ChatArea.tsx itself) reaches these — a real timer is not needed, a fixed
  // "not elapsed yet" is enough to render.
  useElapsedSeconds: () => 0,
  formatElapsed: (seconds: number) => `${seconds}s`,
}))

// The ADR-0033 seam is mocked so this spec can drive the states it produces
// (shared / not shared, a turn in flight, an unread anchor) without a server. Its
// own behaviour — what it fetches and when — is covered in
// features/collaboration/hooks/use-shared-thread.spec.ts. The default is the INERT
// result, which is what every pre-collaboration test in this file relies on.
/**
 * The two calls ChatArea makes back INTO the shared thread.
 *
 * `clearTurnInFlight` really does drop the turn from the fixture rather than only
 * recording that it was called: everything the observer is watching is gated on
 * `turnInFlight`, so the CONSEQUENCE of an unwanted clear — a thread that goes
 * blank — is the defect, and a spy that changes nothing cannot show it.
 */
const mockClearTurnInFlight = vi.fn(() => {
  mockSharedThread = { ...mockSharedThread, turnInFlight: null }
})
const mockNoteTurnActivity = vi.fn()

const INERT_SHARED_THREAD = {
  shared: false,
  myRole: null as 'viewer' | 'collaborator' | 'owner' | null,
  loading: false,
  connected: false,
  turnInFlight: null as { actorUserId: string | null } | null,
  typists: [] as Array<{ userId: string; name: string; profilePictureUrl?: string | null }>,
  participants: [] as Array<{ userId: string; name: string }>,
  unreadAfterMessageId: null as string | null,
  lastArrival: null as { messageId: string; authorUserId: string | null; authorName: string | null } | null,
  authorOf: (_userId?: string | null) => null as { userId: string; name: string } | null,
  engagement: 'ask' as 'ask' | 'mention',
  engagementSuggestion: null as 'ask' | 'mention' | null,
  setEngagement: async (_mode: 'ask' | 'mention') => true,
  refresh: () => {},
  clearTurnInFlight: mockClearTurnInFlight,
  noteTurnActivity: mockNoteTurnActivity,
}
let mockSharedThread = { ...INERT_SHARED_THREAD }

vi.mock('@/features/collaboration/hooks/use-shared-thread', () => ({
  useSharedThread: () => mockSharedThread,
}))

// ADR-0039's frame relay, mocked so this spec can hand ChatArea a turn in any
// state — streaming, done, failed — with no server and no EventSource. What the
// hook does with the socket is covered in
// features/collaboration/hooks/use-spectated-turn.spec.ts; what nothing covered
// until now is how ChatArea wires the RESULT back to the turn banner, which is
// the last describe in this file.
let mockSpectated: { turn: SpectatedTurnState | null; live: boolean } = { turn: null, live: false }
/** The most recent options. `onFrame` is a wire, so it is asserted by calling it. */
let mockSpectatedOptions: UseSpectatedTurnOptions | null = null

vi.mock('@/features/collaboration/hooks/use-spectated-turn', () => ({
  useSpectatedTurn: (options: UseSpectatedTurnOptions) => {
    mockSpectatedOptions = options
    return mockSpectated
  },
}))

/** A turn as the reducer would have folded it; only the terminal flags matter here. */
const spectatedTurn = (overrides: Partial<SpectatedTurnState> = {}): SpectatedTurnState => ({
  parentId: 'turn-1',
  answer: '',
  steps: [],
  waitingOn: null,
  done: false,
  failed: false,
  ...overrides,
})

// The derived hand-off state behind the hand-back offer. Mocked at the hook
// boundary: the offer must never compute a wait locally (ADR-0034), so what it
// reads is the server's answer and nothing else.
// Full rows, not `{ id }` stubs: the banner RENDERS these (name, avatar, who
// asked, since when), so a thin fixture makes the mount untestable — which is
// how the banner stayed unmounted with the suite green.
let mockAwaitingPending: Array<{
  id: string
  person: { userId: string; name: string }
  requestedBy: { userId: string; name: string } | null
  createdAt: string
  note?: string | null
}> = []

const pendingRequest = (
  overrides: Partial<(typeof mockAwaitingPending)[number]> = {},
): (typeof mockAwaitingPending)[number] => ({
  id: 'r-1',
  person: { userId: 'user_anna', name: 'Anna Berger' },
  requestedBy: { userId: 'user-1', name: 'Max Mustermann' },
  createdAt: '2026-07-29T09:00:00.000Z',
  note: null,
  ...overrides,
})

vi.mock('@/features/collaboration/hooks/use-sharing', () => ({
  useAwaitingState: vi.fn((_conversationId: string | null, enabled: boolean) => ({
    awaiting: enabled ? { pending: mockAwaitingPending, awaitingMe: false } : null,
    refresh: vi.fn(),
    release: vi.fn(),
  })),
}))

import { useChatStore } from '@/features/chat'

// Time-of-day greeting shown on the authenticated empty state.
const GREETING_RE = /good (morning|afternoon|evening)/i

describe('ChatArea', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockUserName = 'Max Mustermann'
    mockSharedThread = { ...INERT_SHARED_THREAD }
    mockProjectId = null
    mockBimModels = null
  })

  describe('the empty canvas offers nothing to read, only something to do', () => {
    // The greeting used to be followed by static example questions. They are
    // gone: static examples cannot know the project. Their replacement —
    // categorized, backend-driven starters from the project's own documents,
    // checks and memory — is planned separately; until it lands, the canvas
    // stays quiet rather than showing placeholders.
    //
    // This block is the ratchet. Suggestion chips are the kind of thing that
    // grows back one well-argued pull request at a time, so the absence is
    // asserted in the exact conditions that used to produce the most of them.
    // A reintroduction must prefill only (never auto-send).

    test('grows no suggestion chips, not even where a readable model exists', () => {
      mockProjectId = 'proj-1'
      // The strongest case: this project's model is ready, which is precisely
      // when the canvas used to lead with two building questions.
      mockBimModels = [{ status: 'ready' }]
      render(<ChatArea isAuthenticated />)

      expect(screen.queryAllByRole('button', { name: /\?$/ })).toHaveLength(0)
      expect(screen.queryByRole('group', { name: /example|beispiel/i })).not.toBeInTheDocument()
      expect(mockSetComposerPrefill).not.toHaveBeenCalled()
    })

    test('leaves the greeting alone under it', () => {
      render(<ChatArea isAuthenticated />)

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(GREETING_RE)
      expect(screen.queryByText(/answers cite their sources/i)).not.toBeInTheDocument()
    })
  })

  test('renders welcome state when not authenticated', () => {
    render(<ChatArea isAuthenticated={false} />)

    expect(
      screen.getByText(/piloti opens after your organization is verified/i)
    ).toBeInTheDocument()
    expect(screen.getByText(/sign in to unlock project-scoped/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in with.*sso/i })).toBeInTheDocument()
  })

  test('renders the time-of-day greeting with the first name when authenticated with no messages', () => {
    render(<ChatArea isAuthenticated={true} />)

    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading).toHaveTextContent(GREETING_RE)
    expect(heading).toHaveTextContent('Max')
    // Only the FIRST name is used in the greeting.
    expect(heading).not.toHaveTextContent('Mustermann')
  })

  test('renders the plain greeting when no user name is available', () => {
    mockUserName = null

    render(<ChatArea isAuthenticated={true} />)

    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading).toHaveTextContent(GREETING_RE)
    expect(heading).not.toHaveTextContent(',')
  })

  test('calls onSignIn when sign in button clicked', async () => {
    const user = userEvent.setup()
    const onSignIn = vi.fn()

    render(<ChatArea isAuthenticated={false} onSignIn={onSignIn} />)

    await user.click(screen.getByRole('button', { name: /sign in with.*sso/i }))

    expect(onSignIn).toHaveBeenCalled()
  })

  test('renders user messages', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: {
          messages: [{ id: 'msg-1', role: 'user', content: 'Hello world', messageType: 'user' }],
        },
        isLoading: false,
        hasHydrated: true,
        isStreaming: false,
        thinkingSteps: [],
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('user-message')).toHaveTextContent('Hello world')
  })

  test('does not render legacy status messages', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: {
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: 'Processing...',
              messageType: 'status',
              statusType: 'thinking',
            },
          ],
        },
        isLoading: false,
        hasHydrated: true,
        isStreaming: false,
        thinkingSteps: [],
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    // The dead SSE status transport was removed - status messages are no longer rendered
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('renders agent prompts', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: {
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: 'Please provide more details',
              messageType: 'prompt',
              promptType: 'text-input',
            },
          ],
        },
        isLoading: false,
        hasHydrated: true,
        isStreaming: false,
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('agent-prompt')).toBeInTheDocument()
  })

  test('renders agent responses', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: {
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: 'Here is your answer',
              messageType: 'agent_response',
            },
          ],
        },
        isLoading: false,
        hasHydrated: true,
        isStreaming: false,
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('agent-response')).toHaveTextContent('Here is your answer')
  })

  test('renders file messages', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: {
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: '',
              messageType: 'file',
              fileData: {
                fileName: 'document.pdf',
                fileSize: 1024,
                fileStatus: 'success',
              },
            },
          ],
        },
        isLoading: false,
        hasHydrated: true,
        isStreaming: false,
        thinkingSteps: [],
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    // File messages render inline with the file name
    expect(screen.getByText(/document\.pdf/)).toBeInTheDocument()
  })

  test('renders error banners', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: {
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: '',
              messageType: 'error',
              errorData: {
                errorCode: 'agent.response_failed',
                errorMessage: 'Something went wrong',
              },
            },
          ],
        },
        isLoading: false,
        hasHydrated: true,
        isStreaming: false,
        thinkingSteps: [],
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('error-card')).toBeInTheDocument()
  })

  test('does not render assistant messages (full reports)', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: {
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: 'Full report content',
              messageType: 'assistant',
            },
          ],
        },
        isLoading: false,
        hasHydrated: true,
        isStreaming: false,
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    // Should show welcome state since assistant messages are filtered out
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(GREETING_RE)
  })

  test('renders chat messages area with aria-label', () => {
    render(<ChatArea isAuthenticated={true} />)

    // The Flex component renders with aria-label
    expect(screen.getByLabelText(/chat messages/i)).toBeInTheDocument()
  })

  test('handles null currentConversation', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: null,
        isLoading: false,
        hasHydrated: true,
        isStreaming: false,
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    // Should render welcome state
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(GREETING_RE)
  })

  // The in-feed file_upload_status banner surface was removed (contract C2), so
  // there is no longer a render branch to exercise here.

  test('keeps earlier interrupted thinking state after a later completed turn', () => {
    mockGetThinkingStepsForMessage.mockImplementation((messageId: string) => {
      if (messageId === 'user-1') return [thinkingStep({ id: 'step-1', userMessageId: 'user-1' })]
      if (messageId === 'user-2')
        return [thinkingStep({ id: 'step-2', userMessageId: 'user-2', displayName: 'Step 2' })]
      return []
    })

    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: {
          messages: [
            { id: 'user-1', role: 'user', content: 'First question', messageType: 'user' },
            { id: 'user-2', role: 'user', content: 'Second question', messageType: 'user' },
            { id: 'answer-2', role: 'assistant', content: 'Second answer', messageType: 'agent_response' },
          ],
        },
        isLoading: false,
        hasHydrated: true,
        isStreaming: false,
        thinkingSteps: [],
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    expect(mockChatThinking).toHaveBeenCalledTimes(2)

    const firstCallProps = mockChatThinking.mock.calls[0][0] as {
      isInterrupted?: boolean
      isThinking?: boolean
    }
    const secondCallProps = mockChatThinking.mock.calls[1][0] as {
      isInterrupted?: boolean
      isThinking?: boolean
    }

    // First turn has no response before next user message -> interrupted.
    expect(firstCallProps.isInterrupted).toBe(true)
    expect(firstCallProps.isThinking).toBe(false)

    // Second turn has a response -> done (not interrupted).
    expect(secondCallProps.isInterrupted).toBe(false)
    expect(secondCallProps.isThinking).toBe(false)
  })

  test('anchors a newly sent user message to the top of the viewport on send', () => {
    // Spy on scrollIntoView — the "anchor this question to the top" action, as
    // distinct from the stick-to-bottom controller's container.scrollTo.
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView

    const makeState = (currentUserMessageId: string | null): ChatStoreFixture => ({
      currentConversation: {
        id: 'c1',
        messages: [{ id: 'user-1', role: 'user', content: 'My question', messageType: 'user' }],
      },
      isLoading: false,
      isStreaming: true,
      currentUserMessageId,
      currentStatus: null,
      hasHydrated: true,
      isRecoveryPending: false,
      thinkingSteps: [],
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
      getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      retryLastUserMessage: vi.fn(),
    })

    // Mount with no active turn: nothing to anchor yet.
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
      selector ? selector(asStoreState<ChatStoreWithHydration>(makeState(null))) : makeState(null)
    )
    // ChatArea is memoized; with the store mocked there's no live subscription,
    // so a distinct prop (a fresh onSignIn) stands in to trigger the re-render
    // the real store subscription would cause when currentUserMessageId changes.
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    expect(scrollIntoView).not.toHaveBeenCalled()

    // A new user message becomes the active turn (send): it must be anchored to
    // the TOP (block: 'start'), letting the answer stream downward — NOT chased
    // to the bottom.
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
      selector ? selector(asStoreState<ChatStoreWithHydration>(makeState('user-1'))) : makeState('user-1')
    )
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)

    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }))

    Element.prototype.scrollIntoView = originalScrollIntoView
  })

  test('does not re-anchor an already-active user message on unrelated re-renders', () => {
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView

    const state: ChatStoreFixture = {
      currentConversation: {
        id: 'c1',
        messages: [{ id: 'user-1', role: 'user', content: 'My question', messageType: 'user' }],
      },
      isLoading: false,
      isStreaming: true,
      currentUserMessageId: 'user-1',
      currentStatus: null,
      hasHydrated: true,
      isRecoveryPending: false,
      thinkingSteps: [],
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
      getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      retryLastUserMessage: vi.fn(),
    }

    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
      selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    )
    // Mounting with the turn already active (e.g. session restore) must NOT
    // anchor — the bottom-jump effect owns initial positioning there. A fresh
    // onSignIn forces the re-render (ChatArea is memoized) so we prove a plain
    // re-render with an unchanged currentUserMessageId does not re-anchor.
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)

    expect(scrollIntoView).not.toHaveBeenCalled()

    Element.prototype.scrollIntoView = originalScrollIntoView
  })

  test('keeps earlier interrupted thinking state while a new message is actively streaming', () => {
    mockGetThinkingStepsForMessage.mockImplementation((messageId: string) => {
      if (messageId === 'user-1') return [thinkingStep({ id: 'step-1', userMessageId: 'user-1' })]
      if (messageId === 'user-2')
        return [thinkingStep({ id: 'step-2', userMessageId: 'user-2', displayName: 'Step 2' })]
      return []
    })

    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: {
          messages: [
            { id: 'user-1', role: 'user', content: 'First question', messageType: 'user' },
            { id: 'user-2', role: 'user', content: 'Second question', messageType: 'user' },
          ],
        },
        isLoading: true,
        isStreaming: true,
        hasHydrated: true,
        currentUserMessageId: 'user-2',
        thinkingSteps: [],
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    expect(mockChatThinking).toHaveBeenCalledTimes(2)

    const firstCallProps = mockChatThinking.mock.calls[0][0] as {
      isInterrupted?: boolean
      isThinking?: boolean
    }
    const secondCallProps = mockChatThinking.mock.calls[1][0] as {
      isInterrupted?: boolean
      isThinking?: boolean
    }

    // First turn was interrupted — must keep warning icon even while second turn streams.
    expect(firstCallProps.isInterrupted).toBe(true)
    expect(firstCallProps.isThinking).toBe(false)

    // Second turn is actively streaming — shows spinner, not interrupted.
    expect(secondCallProps.isThinking).toBe(true)
    expect(secondCallProps.isInterrupted).toBe(false)
  })
})

/**
 * The bottom-of-thread "still working" cue after a HITL prompt is answered.
 *
 * A clarifying question, a Folgewege choice, or a plan decision all render as
 * a `prompt` message. `respondToPrompt` flips it to answered the instant the
 * reply is sent — before anything has streamed back — so without a cue here
 * the answered bubble just sits there looking finished while Piloti is, in
 * fact, still working on the next thing.
 */
describe('ChatArea — a working cue after an answered HITL prompt', () => {
  const stateWithLastMessage = (message: MessageFixture, isStreaming: boolean): ChatStoreFixture => ({
    currentConversation: {
      id: 'c1',
      messages: [
        { id: 'user-1', role: 'user', content: 'Frage', messageType: 'user' },
        message,
      ],
    },
    isLoading: isStreaming,
    isStreaming,
    currentUserMessageId: 'user-1',
    currentStatus: null,
    hasHydrated: true,
    thinkingSteps: [],
    respondToPrompt: mockRespondToPrompt,
    dismissErrorCard: mockDismissErrorCard,
    getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
  })

  const mount = (state: ChatStoreFixture) => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
      selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    )
    render(<ChatArea isAuthenticated={true} />)
  }

  test('shows the working cue once an answered prompt is the last message and streaming resumed', () => {
    mount(
      stateWithLastMessage(
        {
          id: 'prompt-1',
          role: 'assistant',
          content: 'Welche Bauklasse?',
          messageType: 'prompt',
          promptType: 'choice',
          isPromptResponded: true,
          promptResponse: 'Bauklasse 4',
        },
        true
      )
    )

    // English fallback without an i18n provider (see the AgentPrompt specs).
    expect(screen.getByRole('status', { name: 'Piloti is responding …' })).toBeInTheDocument()
  })

  test('shows nothing while the prompt is still unanswered — that state is the prompt bubble itself', () => {
    mount(
      stateWithLastMessage(
        {
          id: 'prompt-1',
          role: 'assistant',
          content: 'Welche Bauklasse?',
          messageType: 'prompt',
          promptType: 'choice',
          isPromptResponded: false,
        },
        true
      )
    )

    // The stubbed AgentPrompt renders; the bottom "typing" cue must not also
    // appear for a question that has not been answered yet.
    expect(screen.getByTestId('agent-prompt')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Piloti is responding …' })).not.toBeInTheDocument()
  })

  test('shows nothing once the session has stopped streaming, even if the prompt is answered', () => {
    mount(
      stateWithLastMessage(
        {
          id: 'prompt-1',
          role: 'assistant',
          content: 'Welche Bauklasse?',
          messageType: 'prompt',
          promptType: 'choice',
          isPromptResponded: true,
          promptResponse: 'Bauklasse 4',
        },
        false
      )
    )

    expect(screen.queryByRole('status', { name: 'Piloti is responding …' })).not.toBeInTheDocument()
  })

  test('an answer that has already arrived replaces the cue instead of stacking with it', () => {
    mount({
      currentConversation: {
        id: 'c1',
        messages: [
          { id: 'user-1', role: 'user', content: 'Frage', messageType: 'user' },
          {
            id: 'prompt-1',
            role: 'assistant',
            content: 'Welche Bauklasse?',
            messageType: 'prompt',
            promptType: 'choice',
            isPromptResponded: true,
            promptResponse: 'Bauklasse 4',
          },
          {
            id: 'answer-1',
            role: 'assistant',
            content: 'Für Bauklasse 4 gilt …',
            messageType: 'agent_response',
          },
        ],
      },
      isLoading: true,
      isStreaming: true,
      currentUserMessageId: 'user-1',
      currentStatus: null,
      hasHydrated: true,
      thinkingSteps: [],
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
      getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
    })

    expect(screen.getByTestId('agent-response')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Piloti is responding …' })).not.toBeInTheDocument()
  })
})

/**
 * The multi-person thread (spec CC-5, CC-13, CC-19).
 *
 * These cover what ChatArea itself decides: who each message is attributed to,
 * which messages GROUP under one header, where the unread separator lands, and
 * whether the observer is told that the agent is busy on someone else's turn.
 */
/**
 * Where the follow-up chips live, structurally
 * (`docs/architecture/post-answer-stages.md` §6, §8).
 *
 * Two claims are being pinned, and the second is the one that was worth
 * verifying rather than assuming:
 *
 *   1. The chips are BELOW the answer and OUTSIDE it — the product owner's
 *      ruling, and the whole point of moving them off the card.
 *   2. The rail is the LAST element in the message's column. §8 spends its
 *      entire "reserve no space" argument on that claim, so it is asserted
 *      against the real DOM order rather than read off the JSX: if anything
 *      ever gets appended after the rail, a late-arriving set of chips starts
 *      pushing it, and the argument silently stops holding.
 */
describe('ChatArea — the follow-ups rail sits below the answer', () => {
  const answerWithChips = (extra: MessageFixture[] = []): ChatStoreFixture => ({
    currentConversation: {
      id: 'c1',
      messages: [
        { id: 'user-1', role: 'user', content: 'Was ist das Fluchtniveau?', messageType: 'user' },
        {
          id: 'answer-1',
          role: 'assistant',
          content: 'Das Fluchtniveau ist …',
          messageType: 'agent_response',
          stages: { followUps: { items: [{ question: 'Und bei Hanglage?' }] } },
        },
        ...extra,
      ],
    },
    isLoading: false,
    hasHydrated: true,
    isStreaming: false,
    thinkingSteps: [],
    respondToPrompt: mockRespondToPrompt,
    dismissErrorCard: mockDismissErrorCard,
    setComposerPrefill: mockSetComposerPrefill,
    getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
  })

  const renderWith = (state: ChatStoreFixture) => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
      selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state,
    )
    return render(<ChatArea isAuthenticated={true} />)
  }

  test('renders the rail outside the answer, as its sibling', () => {
    renderWith(answerWithChips())

    const rail = screen.getByTestId('follow-ups-rail')
    const answer = screen.getByTestId('agent-response')
    expect(rail).toBeInTheDocument()
    // Outside: the rail is not a descendant of the answer surface. Inside it,
    // the chips would be the footer chrome this change exists to stop them
    // being.
    expect(answer.contains(rail)).toBe(false)
    // Below: same column, after the answer in document order.
    expect(answer.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('is the LAST element in its message column, so growing it moves nothing', () => {
    renderWith(answerWithChips())

    const rail = screen.getByTestId('follow-ups-rail')
    // The message's own column — the element ChatArea gives each message.
    const column = document.getElementById('message-answer-1')
    expect(column).not.toBeNull()
    expect(column!.contains(rail)).toBe(true)
    // Nothing after it. `lastElementChild` rather than a count, because what
    // matters is the POSITION: a sibling appended below the rail is what would
    // make §8's "reserve nothing" argument false.
    expect(column!.lastElementChild!.contains(rail)).toBe(true)
  })

  test('renders no rail for an answer no stage addressed', () => {
    const state = answerWithChips()
    state.currentConversation!.messages![1]!.stages = undefined
    renderWith(state)

    expect(screen.queryByTestId('follow-ups-rail')).not.toBeInTheDocument()
  })
})

describe('ChatArea — shared thread', () => {
  const ME = 'user-1'
  const ANNA = 'user_anna'

  const setThread = (messages: MessageFixture[]) => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: { id: 's_conv_1', messages },
        isLoading: false,
        isStreaming: false,
        hasHydrated: true,
        thinkingSteps: [],
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        setComposerPrefill: mockSetComposerPrefill,
        getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })
  }

  const userMessage = (
    id: string,
    authorUserId: string | null,
    content = id,
  ): MessageFixture => ({
    id,
    role: 'user',
    messageType: 'user',
    content,
    authorUserId,
  })

  beforeEach(() => {
    mockSharedThread = {
      ...INERT_SHARED_THREAD,
      shared: true,
      participants: [
        { userId: ME, name: 'Max Mustermann' },
        { userId: ANNA, name: 'Anna Berger' },
      ],
      authorOf: (userId?: string | null) =>
        userId === ANNA
          ? { userId: ANNA, name: 'Anna Berger' }
          : userId === ME
            ? { userId: ME, name: 'Max Mustermann' }
            : null,
    }
  })

  test('attributes each human message, and marks the reader\'s own as theirs', () => {
    setThread([userMessage('m1', ME, 'my question'), userMessage('m2', ANNA, "Anna's answer")])

    render(<ChatArea isAuthenticated canCollaborate />)

    const bubbles = screen.getAllByTestId('user-message')
    expect(bubbles[0]).toHaveAttribute('data-author', 'you')
    expect(bubbles[1]).toHaveAttribute('data-author', 'Anna Berger')
  })

  test('groups consecutive messages from the same author, and only those', () => {
    setThread([
      userMessage('m1', ANNA, 'first'),
      userMessage('m2', ANNA, 'second'),
      userMessage('m3', ME, 'mine'),
    ])

    render(<ChatArea isAuthenticated canCollaborate />)

    const bubbles = screen.getAllByTestId('user-message')
    expect(bubbles[0]).not.toHaveAttribute('data-grouped')
    expect(bubbles[1]).toHaveAttribute('data-grouped', 'true')
    // A different author breaks the run.
    expect(bubbles[2]).not.toHaveAttribute('data-grouped')
  })

  test('the agent answering breaks a run, so the next message gets its own header', () => {
    setThread([
      userMessage('m1', ANNA, 'question'),
      { id: 'a1', role: 'assistant', messageType: 'agent_response', content: 'answer' },
      userMessage('m2', ANNA, 'follow-up'),
    ])

    render(<ChatArea isAuthenticated canCollaborate />)

    const bubbles = screen.getAllByTestId('user-message')
    expect(bubbles[1]).not.toHaveAttribute('data-grouped')
  })

  test('draws the unread separator where the reader left off (spec CC-19)', () => {
    mockSharedThread = { ...mockSharedThread, unreadAfterMessageId: 'm1' }
    setThread([userMessage('m1', ME), userMessage('m2', ANNA)])

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.getByTestId('unread-divider')).toBeInTheDocument()
    expect(screen.getByRole('separator', { name: /new/i })).toBeInTheDocument()
  })

  test('does not draw the separator when everything after the mark is the reader\'s own', () => {
    // "New" above your own message would be telling you that you have not read
    // yourself.
    mockSharedThread = { ...mockSharedThread, unreadAfterMessageId: 'm1' }
    setThread([userMessage('m1', ME), userMessage('m2', ME)])

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.queryByTestId('unread-divider')).not.toBeInTheDocument()
  })

  test("tells an observer whose question the agent is answering (spec CC-13)", () => {
    mockSharedThread = { ...mockSharedThread, turnInFlight: { actorUserId: ANNA } }
    setThread([userMessage('m1', ANNA, 'question')])

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.getByTestId('turn-in-flight')).toHaveTextContent(/Anna Berger/)
  })

  test('words the banner differently when the turn is the reader\'s own', () => {
    mockSharedThread = { ...mockSharedThread, turnInFlight: { actorUserId: ME } }
    setThread([userMessage('m1', ME, 'question')])

    render(<ChatArea isAuthenticated canCollaborate />)

    const banner = screen.getByTestId('turn-in-flight')
    expect(banner).toBeInTheDocument()
    expect(banner).not.toHaveTextContent(/Max Mustermann/)
  })

  test("announces a colleague's arrival politely", () => {
    mockSharedThread = {
      ...mockSharedThread,
      lastArrival: { messageId: 'm2', authorUserId: ANNA, authorName: 'Anna Berger' },
    }
    setThread([userMessage('m1', ME), userMessage('m2', ANNA)])

    const { container } = render(<ChatArea isAuthenticated canCollaborate />)

    const live = container.querySelector('[aria-live="polite"]')
    expect(live).toHaveTextContent(/Anna Berger/)
  })

  test('renders nothing extra for a thread the server says is not shared (spec NF-8)', () => {
    // The flag can be on while THIS conversation is private: the local-first
    // rendering must be exactly as before — no attribution, no separator, no banner.
    mockSharedThread = { ...INERT_SHARED_THREAD, unreadAfterMessageId: 'm1' }
    setThread([userMessage('m1', ME), userMessage('m2', ANNA)])

    render(<ChatArea isAuthenticated canCollaborate />)

    for (const bubble of screen.getAllByTestId('user-message')) {
      expect(bubble).not.toHaveAttribute('data-author')
      expect(bubble).not.toHaveAttribute('data-grouped')
    }
    expect(screen.queryByTestId('unread-divider')).not.toBeInTheDocument()
    expect(screen.queryByTestId('turn-in-flight')).not.toBeInTheDocument()
  })
})

/**
 * The waiting banner, asserted where it actually has to appear.
 *
 * The banner was built, unit-tested and screenshotted while NOTHING in the product
 * rendered it — its only consumer was the dev preview page. So the feature's central
 * promise (the thread visibly waits for Anna, and any participant can release the
 * wait) was absent from the shipped UI while every unit test around it stayed green.
 * These tests assert REACHABILITY, which coverage of the component cannot.
 */
describe('ChatArea — the awaiting banner is reachable', () => {
  const ME = 'user-1'
  const ANNA = 'user_anna'

  const setThread = (messages: MessageFixture[]) => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: { id: 's_conv_1', messages },
        isLoading: false,
        isStreaming: false,
        hasHydrated: true,
        thinkingSteps: [],
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        setComposerPrefill: mockSetComposerPrefill,
        getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })
  }

  /** Max asked Anna and nobody has answered yet — the state the banner is for. */
  const waitingThread = (): MessageFixture[] => [
    {
      id: 'm1',
      role: 'user',
      messageType: 'user',
      content: 'm1',
      authorUserId: ME,
      addressees: { agent: false, users: [ANNA] },
    },
  ]

  beforeEach(() => {
    mockAwaitingPending = []
    mockSharedThread = {
      ...INERT_SHARED_THREAD,
      shared: true,
      participants: [
        { userId: ME, name: 'Max Mustermann' },
        { userId: ANNA, name: 'Anna Berger' },
      ],
      authorOf: (userId?: string | null) =>
        userId === ANNA
          ? { userId: ANNA, name: 'Anna Berger' }
          : userId === ME
            ? { userId: ME, name: 'Max Mustermann' }
            : null,
    }
  })

  test('a waiting shared thread renders the banner, naming who holds it', () => {
    mockAwaitingPending = [pendingRequest()]
    setThread(waitingThread())

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.getByTestId('awaiting-banner')).toHaveTextContent('Waiting for Anna Berger')
  })

  test('the release action — the way out of a wait — is present', () => {
    mockAwaitingPending = [pendingRequest()]
    setThread(waitingThread())

    render(<ChatArea isAuthenticated canCollaborate />)

    // MN-9.2. Without this on screen a thread is stuck whenever the person who
    // was asked goes on holiday, and ADR-0034's own mitigation for its worst
    // risk does not exist.
    expect(
      screen.getByRole('button', { name: 'Continue without Anna Berger' }),
    ).toBeInTheDocument()
  })

  test('no banner when nothing is outstanding', () => {
    setThread(waitingThread())

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.queryByTestId('awaiting-banner')).not.toBeInTheDocument()
  })

  test('a solo thread never shows it — collaboration furniture stays out (NF-8)', () => {
    mockAwaitingPending = [pendingRequest()]
    mockSharedThread = { ...INERT_SHARED_THREAD }
    setThread(waitingThread())

    render(<ChatArea isAuthenticated canCollaborate={false} />)

    expect(screen.queryByTestId('awaiting-banner')).not.toBeInTheDocument()
  })

  test('"ask Piloti instead" pre-fills rather than sending, like every other hand-off action', async () => {
    const user = userEvent.setup()
    mockAwaitingPending = [pendingRequest()]
    setThread(waitingThread())

    render(<ChatArea isAuthenticated canCollaborate />)
    await user.click(screen.getByRole('button', { name: 'Ask Piloti instead' }))

    // `@Piloti` is what releases the wait server-side, so the ruling does it —
    // no separate release call, and the message stays honestly authored. The
    // token travels as a STRUCTURED mention: as plain text it would send as a
    // remark to the chat and the wait would persist (spec MN-3).
    expect(mockSetComposerPrefill).toHaveBeenCalledWith('@Piloti ', [
      { targetId: 'agent:piloti', display: 'Piloti' },
    ])
  })
})

/**
 * The hand-back offer (ADR-0034 addendum) — the last transition of the state
 * machine: asking Piloti → tag a human → waiting → they answer → **hand back?**
 *
 * The offer is derived from the THREAD, not from a live transition, which is what
 * these tests pin hardest: the asker usually arrives after the answer landed (hours
 * later, another device), so an offer that only existed in the browser that watched
 * the message arrive would be missing in exactly the case it is for.
 */
describe('ChatArea — the hand-back offer', () => {
  const ME = 'user-1'
  const ANNA = 'user_anna'
  const TOBIAS = 'user_tobias'

  const setThread = (messages: MessageFixture[]) => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: { id: 's_conv_1', messages },
        isLoading: false,
        isStreaming: false,
        hasHydrated: true,
        thinkingSteps: [],
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        setComposerPrefill: mockSetComposerPrefill,
        getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })
  }

  const userMessage = (
    id: string,
    authorUserId: string | null,
    extra: MessageFixture = {},
  ): MessageFixture => ({ id, role: 'user', messageType: 'user', content: id, authorUserId, ...extra })

  /** The hand-off itself: the server addressed people and NOT the agent (MN-1). */
  const asks = (users: string[]): MessageFixture => ({ addressees: { agent: false, users } })

  /** The reader asked Anna; Anna has answered; nothing is outstanding. */
  const resolvedThread = (): MessageFixture[] => [
    userMessage('m1', ME, asks([ANNA])),
    userMessage('m2', ANNA),
  ]

  beforeEach(() => {
    mockAwaitingPending = []
    mockSharedThread = {
      ...INERT_SHARED_THREAD,
      shared: true,
      participants: [
        { userId: ME, name: 'Max Mustermann' },
        { userId: ANNA, name: 'Anna Berger' },
      ],
      authorOf: (userId?: string | null) =>
        userId === ANNA
          ? { userId: ANNA, name: 'Anna Berger' }
          : userId === TOBIAS
            ? { userId: TOBIAS, name: 'Tobias Kern' }
            : userId === ME
              ? { userId: ME, name: 'Max Mustermann' }
              : null,
    }
  })

  test('offers to let Piloti carry on once the person who was asked has answered', () => {
    setThread(resolvedThread())

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.getByTestId('handback-offer')).toHaveTextContent(
      'Anna Berger replied — let Piloti carry on?',
    )
  })

  test('names everyone who answered when several were asked', () => {
    setThread([
      userMessage('m1', ME, asks([ANNA, TOBIAS])),
      userMessage('m2', ANNA),
      userMessage('m3', TOBIAS),
    ])

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.getByTestId('handback-offer')).toHaveTextContent(
      'Anna Berger, Tobias Kern replied — let Piloti carry on?',
    )
  })

  test('falls back to the structured mentions when the ruling was not stored', () => {
    setThread([
      userMessage('m1', ME, { mentions: [{ targetId: ANNA, display: 'Anna Berger' }] }),
      userMessage('m2', ANNA),
    ])

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.getByTestId('handback-offer')).toBeInTheDocument()
  })

  test('accepting PRE-FILLS the composer with @Piloti and never sends', async () => {
    const user = userEvent.setup()
    setThread(resolvedThread())

    render(<ChatArea isAuthenticated canCollaborate />)
    await user.click(screen.getByRole('button', { name: 'Let Piloti carry on' }))

    // Structured, for the same reason as the awaiting banner: a plain-text
    // `@Piloti` here would have been a remark to the chat, not a hand-back.
    expect(mockSetComposerPrefill).toHaveBeenCalledWith('@Piloti — please carry on from here.', [
      { targetId: 'agent:piloti', display: 'Piloti' },
    ])
    // And it steps aside — the composer now holds the offer.
    expect(screen.queryByTestId('handback-offer')).not.toBeInTheDocument()
  })

  test('dismissing it takes it away', async () => {
    const user = userEvent.setup()
    setThread(resolvedThread())

    render(<ChatArea isAuthenticated canCollaborate />)
    await user.click(screen.getByRole('button', { name: 'Not now' }))

    expect(screen.queryByTestId('handback-offer')).not.toBeInTheDocument()
    expect(mockSetComposerPrefill).not.toHaveBeenCalled()
  })

  test('stays away while the thread is still waiting on someone — and the BANNER is what owns that state', () => {
    mockAwaitingPending = [pendingRequest()]
    setThread(resolvedThread())

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.queryByTestId('handback-offer')).not.toBeInTheDocument()
    // This assertion is the point. The old version of this test named the banner
    // in its title and never checked it, so the banner could be — and was —
    // completely unmounted while the suite stayed green. The agent's silence had
    // no explanation on screen and the release action had no affordance.
    expect(screen.getByTestId('awaiting-banner')).toBeInTheDocument()
  })

  test('stays away once the agent has already answered — there is nothing to hand back', () => {
    setThread([
      ...resolvedThread(),
      { id: 'a1', role: 'assistant', messageType: 'agent_response', content: 'answer' },
    ])

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.queryByTestId('handback-offer')).not.toBeInTheDocument()
  })

  test('stays away when the reader had the last word', () => {
    setThread([...resolvedThread(), userMessage('m3', ME)])

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.queryByTestId('handback-offer')).not.toBeInTheDocument()
  })

  test('stays away for a remark by somebody who was never asked', () => {
    setThread([userMessage('m1', ME, asks([ANNA])), userMessage('m2', TOBIAS)])

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.queryByTestId('handback-offer')).not.toBeInTheDocument()
  })

  test('stays away when nobody was ever asked at all', () => {
    setThread([userMessage('m1', ME), userMessage('m2', ANNA)])

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.queryByTestId('handback-offer')).not.toBeInTheDocument()
  })

  test('renders nothing for a thread the server says is not shared (spec NF-8)', () => {
    mockSharedThread = { ...INERT_SHARED_THREAD }
    setThread(resolvedThread())

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.queryByTestId('handback-offer')).not.toBeInTheDocument()
  })
})

/**
 * The engagement notice, asserted where it has to appear.
 *
 * Same lesson as the awaiting banner: a component that explains the product's
 * routing is worth nothing if the product does not render it. In `mention` mode a
 * plain message goes to the chat rather than to Piloti, and a reader with no
 * explanation on screen concludes the assistant is broken.
 */
describe('ChatArea — the engagement notice is reachable', () => {
  const setThread = (messages: MessageFixture[]) => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: { id: 's_conv_1', messages },
        isLoading: false,
        isStreaming: false,
        hasHydrated: true,
        thinkingSteps: [],
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        setComposerPrefill: mockSetComposerPrefill,
        getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })
  }

  const thread = (): MessageFixture[] => [
    { id: 'm1', role: 'user', messageType: 'user', content: 'm1', authorUserId: 'user-1' },
  ]

  beforeEach(() => {
    mockAwaitingPending = []
    mockSharedThread = { ...INERT_SHARED_THREAD, shared: true, engagement: 'mention' }
  })

  test('a mention-mode shared thread explains the rule', () => {
    setThread(thread())

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.getByTestId('engagement-notice')).toHaveTextContent(
      'Piloti answers when mentioned',
    )
  })

  test('an ask-mode thread with nothing to offer stays quiet about it', () => {
    mockSharedThread = { ...INERT_SHARED_THREAD, shared: true, engagement: 'ask' }
    setThread(thread())

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.queryByTestId('engagement-notice')).not.toBeInTheDocument()
  })

  test('a multi-person ask-mode thread is OFFERED mention, and still answers to Piloti', () => {
    // The correction that matters: `ask` stays the default however many people are
    // here. A second person writing produces a question for the humans, never a
    // change the thread made to itself.
    mockSharedThread = {
      ...INERT_SHARED_THREAD,
      shared: true,
      engagement: 'ask',
      engagementSuggestion: 'mention',
    }
    setThread(thread())

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.getByTestId('engagement-notice')).toHaveTextContent(
      'Should Piloti wait to be mentioned?',
    )
  })

  test('a solo thread never shows it — collaboration furniture stays out (NF-8)', () => {
    mockSharedThread = { ...INERT_SHARED_THREAD, engagement: 'mention' }
    setThread(thread())

    render(<ChatArea isAuthenticated canCollaborate={false} />)

    expect(screen.queryByTestId('engagement-notice')).not.toBeInTheDocument()
  })

  test('a viewer gets the explanation without the control', () => {
    mockSharedThread = {
      ...INERT_SHARED_THREAD,
      shared: true,
      engagement: 'mention',
      myRole: 'viewer',
    }
    setThread(thread())

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.getByTestId('engagement-notice')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Let Piloti answer everything' }),
    ).not.toBeInTheDocument()
  })
})

/**
 * The three wires from the spectated stream back to the turn banner (ADR-0039).
 *
 * `useSpectatedTurn` is thoroughly tested; every wire OUT of it was invisible here
 * — both effects could be disabled outright and all 47 tests in this file stayed
 * green. That is how the `done` clear below shipped once already: an unobserved
 * wire is one somebody will rewrite from first principles, and the first principle
 * ("the turn is over, so clear it") is the wrong one.
 */
describe('ChatArea — the spectated stream feeds the turn banner', () => {
  const ANNA = 'user_anna'

  const setThread = (messages: MessageFixture[]) => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: ChatStoreFixture = {
        currentConversation: { id: 's_conv_1', messages },
        isLoading: false,
        isStreaming: false,
        hasHydrated: true,
        thinkingSteps: [],
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        setComposerPrefill: mockSetComposerPrefill,
        getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })
  }

  // Anna asked and the agent is answering HER: the reader is an observer, which is
  // the only situation in which any of this is enabled.
  beforeEach(() => {
    mockAwaitingPending = []
    mockSpectated = { turn: null, live: false }
    mockSpectatedOptions = null
    mockSharedThread = {
      ...INERT_SHARED_THREAD,
      shared: true,
      turnInFlight: { actorUserId: ANNA },
      participants: [
        { userId: 'user-1', name: 'Max Mustermann' },
        { userId: ANNA, name: 'Anna Berger' },
      ],
      authorOf: (userId?: string | null) =>
        userId === ANNA ? { userId: ANNA, name: 'Anna Berger' } : null,
    }
    setThread([
      { id: 'm1', role: 'user', messageType: 'user', content: 'question', authorUserId: ANNA },
    ])
  })

  test('a failed turn clears the banner — nothing else ever will', () => {
    mockSpectated = { turn: spectatedTurn({ failed: true, done: true }), live: true }

    render(<ChatArea isAuthenticated canCollaborate />)

    // A turn that dies without persisting an assistant message never publishes
    // `ended` — that event is a side effect of the write that did not happen — so
    // this call is the only thing that unlocks every observer's composer before
    // the staleness clock runs out minutes later.
    expect(mockClearTurnInFlight).toHaveBeenCalled()
  })

  test('a DONE turn keeps it, so the finished answer survives until the message lands', () => {
    mockSpectated = {
      turn: spectatedTurn({ answer: 'Ja, ab drei Geschossen.', done: true }),
      live: true,
    }

    const { rerender } = render(<ChatArea isAuthenticated canCollaborate onSignIn={vi.fn()} />)

    // `done` is terminal for the STREAM, not for the turn: it strictly precedes
    // persistence. Clearing here unmounted the completed answer the observer was
    // reading and left them blank until the persisted message landed a round trip
    // later — and in the very case the clear was written for, a turn that never
    // persists at all, it threw a finished answer away and put nothing in its
    // place. The persisted message's own `ended` is what clears this.
    expect(mockClearTurnInFlight).not.toHaveBeenCalled()

    // The consequence, not merely the call: the fixture's clear genuinely drops
    // the turn, and ChatArea is memoized, so a re-render (a fresh onSignIn stands
    // in for the store subscription) is where a `done` clear becomes a blank
    // thread rather than an answer.
    rerender(<ChatArea isAuthenticated canCollaborate onSignIn={vi.fn()} />)
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Ja, ab drei Geschossen.')
  })

  test('every frame restarts the staleness clock', () => {
    render(<ChatArea isAuthenticated canCollaborate />)

    expect(mockNoteTurnActivity).not.toHaveBeenCalled()
    // The heartbeat has to be the FRAME. Derived from `answer.length` +
    // `steps.length` — what this used to be — it stands still for the whole of a
    // single long tool call, because the reducer merges repeated frames into the
    // step it already has: a six-minute search looked like silence and the banner
    // was torn down mid-turn.
    mockSpectatedOptions?.onFrame?.()

    expect(mockNoteTurnActivity).toHaveBeenCalledTimes(1)
  })
})
