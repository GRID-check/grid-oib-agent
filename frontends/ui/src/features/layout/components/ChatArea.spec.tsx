import { act, render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ChatArea } from './ChatArea'
import type { ChatStoreWithHydration } from '@/features/chat/store'
import type { ChatMessage } from '@/features/chat/types'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { UseSpectatedTurnOptions } from '@/features/collaboration/hooks/use-spectated-turn'
import { initialTurnView, type TurnView } from '@/features/chat/lib/turn-fold'
import { useAnswerRevealStore } from '@/features/chat/stores/answer-reveal-store'

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
const mockChatThinking = vi.fn((_props: unknown) => (
  <div data-testid="chat-thinking">Thinking...</div>
))

// The run block's data half is mocked so the dispatch test asserts WHERE a run
// message goes without opening a stream; the hook's own behaviour is covered
// in features/runs/hooks/use-run-ledger.spec.ts. The block itself is stubbed
// to its two testable facts (status, title) for the same reason.
const mockUseRunLedger = vi.fn((input: { message: ChatMessage }) => ({
  ledger: input.message.runLedger ?? null,
  live: false,
}))
vi.mock('@/features/runs/hooks/use-run-ledger', () => ({
  useRunLedger: (input: { message: ChatMessage }) => mockUseRunLedger(input),
}))
// The run block's document chips read the project inventory over HTTP; nothing
// here opens one, and an unmocked listing would reach for a server that is not
// there.
vi.mock('@/features/runs/hooks/use-project-inventory', () => ({
  useProjectInventory: () => ({ documents: null, loading: false }),
}))
vi.mock('@/features/runs/components/RunBlock', () => ({
  RunBlock: ({ ledger, title }: { ledger: { status: string }; title?: string | null }) => (
    <div data-testid="run-block" data-status={ledger.status}>
      {title}
    </div>
  ),
}))

/** A real stored step; the stubbed `ChatThinking` only reads how many there are. */
const thinkingStep = (overrides: Partial<StoredThinkingStep> = {}): StoredThinkingStep => ({
  id: 'step-1',
  userMessageId: 'user-1',
  kind: 'tool',
  tool: 'web_search',
  timestamp: '2026-07-29T08:00:00.000Z',
  isComplete: true,
  ...overrides,
})

// The anchor glide is motion's spring on the container's scrollTop: asserted at
// its boundary (which element, where to), since happy-dom has no layout.
const mockGlideScrollTo = vi.fn(
  (_container: HTMLElement, _top: number, _options: { reducedMotion: boolean }) => ({ stop: vi.fn() })
)
vi.mock('@/features/layout/lib/glide-scroll', () => ({
  glideScrollTo: (container: HTMLElement, top: number, options: { reducedMotion: boolean }) =>
    mockGlideScrollTo(container, top, options),
}))

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
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
      setComposerPrefill: mockSetComposerPrefill,
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
  lastArrival: null as {
    messageId: string
    authorUserId: string | null
    authorName: string | null
  } | null,
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
let mockSpectated: { turn: TurnView | null; live: boolean } = { turn: null, live: false }
/** The most recent options. `onFrame` is a wire, so it is asserted by calling it. */
let mockSpectatedOptions: UseSpectatedTurnOptions | null = null

vi.mock('@/features/collaboration/hooks/use-spectated-turn', () => ({
  useSpectatedTurn: (options: UseSpectatedTurnOptions) => {
    mockSpectatedOptions = options
    return mockSpectated
  },
}))

/** A turn as the fold would have left it; only the phase and the text matter here. */
const spectatedTurn = (overrides: Partial<TurnView> = {}): TurnView => ({
  ...initialTurnView('turn-1', 'conv-1'),
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
  overrides: Partial<(typeof mockAwaitingPending)[number]> = {}
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
    expect(screen.getByText(/sign in to unlock the project workspace/i)).toBeInTheDocument()
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
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: {
            messages: [{ id: 'msg-1', role: 'user', content: 'Hello world', messageType: 'user' }],
          },
          isLoading: false,
          hasHydrated: true,
          isStreaming: false,
          respondToPrompt: mockRespondToPrompt,
          dismissErrorCard: mockDismissErrorCard,
        }
        return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      }
    )

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('user-message')).toHaveTextContent('Hello world')
  })

  test('does not render legacy status messages', () => {
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: {
            messages: [
              {
                id: 'msg-1',
                role: 'assistant',
                content: 'Processing...',
                messageType: 'status',
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
      }
    )

    render(<ChatArea isAuthenticated={true} />)

    // The dead SSE status transport was removed - status messages are no longer rendered
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('renders agent prompts', () => {
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: {
            messages: [
              {
                id: 'msg-1',
                role: 'assistant',
                content: 'Please provide more details',
                messageType: 'prompt',
                promptInputType: 'text',
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
      }
    )

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('agent-prompt')).toBeInTheDocument()
  })

  test('renders agent responses', () => {
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
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
      }
    )

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('agent-response')).toHaveTextContent('Here is your answer')
  })

  /**
   * A message that carries a run ledger IS a run (ADR-0062): it goes to the
   * block, keyed to the active project, and its content is the report beneath
   * the block once there is one — a live run shows the block alone.
   */
  test('dispatches a message with a run ledger to the run block', () => {
    const runLedger = {
      runId: 'run-1',
      status: 'laeuft' as const,
      phases: [],
      steps: [],
      startedAt: '2026-09-16T08:00:00.000Z',
      updatedAt: '2026-09-16T08:00:00.000Z',
    }
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: {
            messages: [
              {
                id: 'msg-run',
                role: 'assistant',
                content: 'Der Bericht',
                messageType: 'agent_response',
                runLedger,
                runTitle: 'Normprüfung: Fluchtwege',
              },
            ],
          },
          projectId: mockProjectId,
          isLoading: false,
          hasHydrated: true,
          isStreaming: false,
          respondToPrompt: mockRespondToPrompt,
          dismissErrorCard: mockDismissErrorCard,
        }
        return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      }
    )

    render(<ChatArea isAuthenticated={true} />)

    const block = screen.getByTestId('run-block')
    expect(block).toHaveAttribute('data-status', 'laeuft')
    expect(block).toHaveTextContent('Normprüfung: Fluchtwege')
    expect(mockUseRunLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: mockProjectId,
        message: expect.objectContaining({ id: 'msg-run' }),
      })
    )
    // Still going: the report is not shown yet, only the block.
    expect(screen.queryByTestId('agent-response')).not.toBeInTheDocument()
  })

  test('renders file messages', () => {
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
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
          respondToPrompt: mockRespondToPrompt,
          dismissErrorCard: mockDismissErrorCard,
        }
        return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      }
    )

    render(<ChatArea isAuthenticated={true} />)

    // File messages render inline with the file name
    expect(screen.getByText(/document\.pdf/)).toBeInTheDocument()
  })

  test('renders error banners', () => {
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
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
          respondToPrompt: mockRespondToPrompt,
          dismissErrorCard: mockDismissErrorCard,
        }
        return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      }
    )

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('error-card')).toBeInTheDocument()
  })

  test('does not render assistant messages (full reports)', () => {
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
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
      }
    )

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
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: null,
          isLoading: false,
          hasHydrated: true,
          isStreaming: false,
          respondToPrompt: mockRespondToPrompt,
          dismissErrorCard: mockDismissErrorCard,
        }
        return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      }
    )

    render(<ChatArea isAuthenticated={true} />)

    // Should render welcome state
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(GREETING_RE)
  })

  // The in-feed file_upload_status banner surface was removed (contract C2), so
  // there is no longer a render branch to exercise here.

  test('keeps earlier interrupted thinking state after a later completed turn', () => {

    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: {
            messages: [
              {
                id: 'user-1',
                role: 'user',
                content: 'First question',
                messageType: 'user',
                thinkingSteps: [thinkingStep()],
              },
              {
                id: 'user-2',
                role: 'user',
                content: 'Second question',
                messageType: 'user',
                thinkingSteps: [thinkingStep({ id: 'step-2', userMessageId: 'user-2' })],
              },
              {
                id: 'answer-2',
                role: 'assistant',
                content: 'Second answer',
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
      }
    )

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

  test('glides a newly sent user message to the top of the viewport, scrolling only the thread', async () => {
    // Not scrollIntoView: on iOS it pans every scrollable ancestor too, and its
    // smooth scroll cannot be interrupted by the reader. The glide scrolls the
    // thread's own container, a frame after the send.
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    // happy-dom lays nothing out: the question is put 300px down, so there is
    // a distance to glide. A question already where it would land is not
    // scrolled at all (the next test).
    const originalRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const rect = originalRect.call(this)
      if (this.getAttribute('data-chat-anchor') !== 'true') return rect
      return { ...rect.toJSON(), top: 300, y: 300, bottom: 340, height: 40, toJSON: () => ({}) } as DOMRect
    }

    const makeState = (currentUserMessageId: string | null): ChatStoreFixture => ({
      currentConversation: {
        id: 'c1',
        messages: [{ id: 'user-1', role: 'user', content: 'My question', messageType: 'user' }],
      },
      isLoading: false,
      isStreaming: true,
      currentUserMessageId,
      hasHydrated: true,
      isRecoveryPending: false,
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
      retryLastUserMessage: vi.fn(),
    })

    try {
      // Mount with no active turn: nothing to anchor yet.
      vi.mocked(useChatStore).mockImplementation(
        (selector?: StoreSelector<ChatStoreWithHydration>) =>
          selector ? selector(asStoreState<ChatStoreWithHydration>(makeState(null))) : makeState(null)
      )
      // ChatArea is memoized; with the store mocked there's no live subscription,
      // so a distinct prop (a fresh onSignIn) stands in to trigger the re-render
      // the real store subscription would cause when currentUserMessageId changes.
      const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
      await new Promise((resolve) => requestAnimationFrame(resolve))
      expect(mockGlideScrollTo).not.toHaveBeenCalled()

      vi.mocked(useChatStore).mockImplementation(
        (selector?: StoreSelector<ChatStoreWithHydration>) =>
          selector
            ? selector(asStoreState<ChatStoreWithHydration>(makeState('user-1')))
            : makeState('user-1')
      )
      rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
      await new Promise((resolve) => requestAnimationFrame(resolve))

      expect(mockGlideScrollTo).toHaveBeenCalledTimes(1)
      const [container, , options] = mockGlideScrollTo.mock.calls[0]
      expect((container as HTMLElement).classList.contains('overflow-y-auto')).toBe(true)
      expect(options).toEqual({ reducedMotion: false })
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView
      Element.prototype.getBoundingClientRect = originalRect
    }
  })

  test('a sent question already where it would land is not scrolled', async () => {
    const makeState = (currentUserMessageId: string | null): ChatStoreFixture => ({
      currentConversation: {
        id: 'c1',
        messages: [{ id: 'user-1', role: 'user', content: 'My question', messageType: 'user' }],
      },
      isLoading: false,
      isStreaming: true,
      currentUserMessageId,
      hasHydrated: true,
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
    })
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
      selector ? selector(asStoreState<ChatStoreWithHydration>(makeState(null))) : makeState(null)
    )
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
      selector ? selector(asStoreState<ChatStoreWithHydration>(makeState('user-1'))) : makeState('user-1')
    )
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    await new Promise((resolve) => requestAnimationFrame(resolve))

    // Each write is a scroll the reader sees: none where there is no distance.
    expect(mockGlideScrollTo).not.toHaveBeenCalled()
  })

  test('the anchor spacer holds only the unfilled room, and is not dropped when the answer lands', async () => {
    // Geometry jsdom does not have: a 900px viewport, the anchored question at
    // 100px, the end of the list at 400px, so 600px of room is still unfilled.
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = vi.fn()
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900)
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const top = this.getAttribute('data-chat-anchor') === 'true' ? 100 : 400
      return {
        top,
        bottom: top,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }
    })

    try {
      const makeState = (
        currentUserMessageId: string | null,
        isStreaming: boolean
      ): ChatStoreFixture => ({
        currentConversation: {
          id: 'c1',
          messages: [{ id: 'user-1', role: 'user', content: 'My question', messageType: 'user' }],
        },
        isLoading: false,
        isStreaming,
        currentUserMessageId,
        hasHydrated: true,
        isRecoveryPending: false,
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
        retryLastUserMessage: vi.fn(),
      })
      const use = (state: ChatStoreFixture) =>
        vi
          .mocked(useChatStore)
          .mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
            selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
          )

      use(makeState(null, false))
      const { container, rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
      use(makeState('user-1', true))
      rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)

      const spacer = container.querySelector<HTMLElement>('[aria-hidden="true"][style*="min-height"]')
      expect(spacer?.style.minHeight).toBe('600px')

      // The answer lands. Dropping the spacer to 0 here is what used to clamp the
      // scroll position and move a short finished answer down by its unused room.
      use(makeState('user-1', false))
      rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
      await new Promise((resolve) => requestAnimationFrame(resolve))
      expect(spacer?.style.minHeight).toBe('600px')
    } finally {
      clientHeight.mockRestore()
      rect.mockRestore()
      Element.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  test('the anchor spacer shrinks as the list grows and refits when the viewport resizes', () => {
    // Geometry jsdom does not have: the anchored question at 100px, the end of
    // the list (the spacer's top) at 400px, a 900px viewport: 600px of room.
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = vi.fn()
    let viewportHeight = 900
    let listEnd = 400
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(() => viewportHeight)
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const top = this.getAttribute('data-chat-anchor') === 'true' ? 100 : listEnd
      return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) }
    })
    const observed: Element[] = []
    let notify: ResizeObserverCallback = () => {}
    const originalResizeObserver = globalThis.ResizeObserver
    class RecordingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notify = callback
      }
      observe(el: Element) {
        observed.push(el)
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver
    const makeState = (currentUserMessageId: string | null): ChatStoreFixture => ({
      currentConversation: {
        id: 'c1',
        messages: [{ id: 'user-1', role: 'user', content: 'My question', messageType: 'user' }],
      },
      isLoading: false,
      isStreaming: true,
      currentUserMessageId,
      hasHydrated: true,
      isRecoveryPending: false,
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
      retryLastUserMessage: vi.fn(),
    })
    const use = (state: ChatStoreFixture) =>
      vi
        .mocked(useChatStore)
        .mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
          selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
        )
    const fire = (target: Element) =>
      act(() =>
        notify(
          [{ target, contentRect: { height: listEnd } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver
        )
      )

    try {
      use(makeState(null))
      const { container, rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
      use(makeState('user-1'))
      rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
      const spacer = container.querySelector<HTMLElement>('[aria-hidden="true"][style*="min-height"]')
      expect(spacer?.style.minHeight).toBe('600px')

      // The answer grows by 300px: the spacer gives up exactly that much.
      const list = observed.find(
        (el) =>
          el.contains(screen.getByText('My question')) && !el.classList.contains('overflow-y-auto')
      )
      listEnd = 700
      fire(list as Element)
      expect(spacer?.style.minHeight).toBe('300px')

      // The window grows by 300px: the viewport is observed, and the spacer
      // takes the new room.
      const viewport = observed.find((el) => el.classList.contains('overflow-y-auto'))
      expect(viewport).toBeDefined()
      viewportHeight = 1200
      fire(viewport as Element)
      expect(spacer?.style.minHeight).toBe('600px')
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
      clientHeight.mockRestore()
      rect.mockRestore()
      Element.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  test('the resize observer watches the messages, not the spacer it refits', () => {
    // happy-dom's ResizeObserver is inert: record what the controller observes.
    // The observer's callback resizes the anchor spacer; a spacer inside the
    // observed box resized that box again at the same depth, and the browser
    // raised "ResizeObserver loop completed with undelivered notifications"
    // once per frame while a short anchored answer streamed.
    const observed: Element[] = []
    const originalResizeObserver = globalThis.ResizeObserver
    class RecordingResizeObserver {
      observe(el: Element) {
        observed.push(el)
      }
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = RecordingResizeObserver as unknown as typeof ResizeObserver
    const state: ChatStoreFixture = {
      currentConversation: {
        id: 'c1',
        messages: [{ id: 'user-1', role: 'user', content: 'My question', messageType: 'user' }],
      },
      isLoading: false,
      isStreaming: true,
      currentUserMessageId: null,
      hasHydrated: true,
      isRecoveryPending: false,
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
      retryLastUserMessage: vi.fn(),
    }
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) =>
        selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    )

    try {
      const { container } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
      const spacer = container.querySelector<HTMLElement>(
        '[aria-hidden="true"][style*="min-height"]'
      )
      expect(spacer).not.toBeNull()
      // The scroll viewport is observed as well (its height is the spacer's
      // other input). Its box is the visible height, which the spacer's
      // min-height does not change, so it cannot loop; only the list's can.
      const list = observed.filter(
        (el) =>
          el.contains(screen.getByText('My question')) && !el.classList.contains('overflow-y-auto')
      )
      expect(list.length).toBeGreaterThan(0)
      for (const el of list) expect(el.contains(spacer)).toBe(false)
    } finally {
      globalThis.ResizeObserver = originalResizeObserver
    }
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
      hasHydrated: true,
      isRecoveryPending: false,
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
      retryLastUserMessage: vi.fn(),
    }

    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) =>
        selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    )
    // Mounting with the turn already active (e.g. session restore) must NOT
    // anchor — the bottom-jump effect owns initial positioning there. A fresh
    // onSignIn forces the re-render (ChatArea is memoized) so we prove a plain
    // re-render with an unchanged currentUserMessageId does not re-anchor.
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)

    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(mockGlideScrollTo).not.toHaveBeenCalled()

    Element.prototype.scrollIntoView = originalScrollIntoView
  })

  test('keeps earlier interrupted thinking state while a new message is actively streaming', () => {

    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: {
            messages: [
              {
                id: 'user-1',
                role: 'user',
                content: 'First question',
                messageType: 'user',
                thinkingSteps: [thinkingStep()],
              },
              {
                id: 'user-2',
                role: 'user',
                content: 'Second question',
                messageType: 'user',
                thinkingSteps: [thinkingStep({ id: 'step-2', userMessageId: 'user-2' })],
              },
            ],
          },
          isLoading: true,
          isStreaming: true,
          hasHydrated: true,
          currentUserMessageId: 'user-2',
          respondToPrompt: mockRespondToPrompt,
          dismissErrorCard: mockDismissErrorCard,
        }
        return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      }
    )

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
 * The live turn's Herleitung (docs/design/streaming-chat-answer.md, "The end of
 * a turn"): one object from the send to the settle. It is there from the send,
 * open while the turn works, FOLDED when the answer's first words arrive, and
 * its header stays live until the answer has settled, so the settle itself
 * changes no height.
 */
describe('ChatArea — the live Herleitung', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSharedThread = { ...INERT_SHARED_THREAD }
    mockProjectId = null
    useAnswerRevealStore.setState({ revealingId: null })
  })

  const sentAt = new Date('2026-10-09T08:00:00.000Z')
  const question = (overrides: MessageFixture = {}): MessageFixture => ({
    id: 'user-1',
    role: 'user',
    content: 'Frage',
    messageType: 'user',
    timestamp: sentAt,
    thinkingSteps: [thinkingStep()],
    ...overrides,
  })
  const answer = (content: string, overrides: MessageFixture = {}): MessageFixture => ({
    id: 'answer-1',
    role: 'assistant',
    content,
    messageType: 'agent_response',
    ...overrides,
  })
  const use = (state: ChatStoreFixture) =>
    vi
      .mocked(useChatStore)
      .mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
        selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      )
  const turnState = (
    messages: MessageFixture[],
    isStreaming: boolean,
    extra: ChatStoreFixture = {}
  ): ChatStoreFixture => ({
    currentConversation: { id: 'c1', messages },
    isLoading: false,
    isStreaming,
    hasHydrated: true,
    currentUserMessageId: 'user-1',
    respondToPrompt: mockRespondToPrompt,
    dismissErrorCard: mockDismissErrorCard,
    retryLastUserMessage: vi.fn(),
    ...extra,
  })
  type HerleitungProps = {
    isThinking?: boolean
    autoOpen?: boolean
    answering?: boolean
    since?: Date
    isInterrupted?: boolean
    isStopped?: boolean
  }
  const herleitung = () => mockChatThinking.mock.calls.at(-1)![0] as HerleitungProps

  test('is there from the send, before any step — and no typing bubble stands in for it', () => {
    use(turnState([question({ thinkingSteps: [] })], true))
    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('chat-thinking')).toBeInTheDocument()
    // Nothing to open yet: the header alone is the working cue.
    expect(herleitung()).toMatchObject({ isThinking: true, autoOpen: false, answering: false })
    expect(screen.queryByRole('status', { name: 'Thinking …' })).not.toBeInTheDocument()
  })

  test('counts its timer from the question, not from its own mount', () => {
    use(turnState([question()], true))
    render(<ChatArea isAuthenticated={true} />)

    expect(herleitung().since).toBe(sentAt)
  })

  test('folds when the answer starts, and its header stays live until the answer settles', () => {
    use(turnState([question(), answer('')], true))
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    expect(herleitung()).toMatchObject({ isThinking: true, autoOpen: true, answering: false })

    // The first words: folded, still live.
    use(turnState([question(), answer('Die')], true))
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    expect(herleitung()).toMatchObject({ isThinking: true, autoOpen: false, answering: true })

    // The stream ends; the answer is still finishing its held-back words.
    useAnswerRevealStore.setState({ revealingId: 'answer-1' })
    use(turnState([question(), answer('Die Antwort.')], false))
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    expect(herleitung()).toMatchObject({ isThinking: true, autoOpen: false })

    // The settle changes the status and nothing that has a height.
    act(() => useAnswerRevealStore.getState().end('answer-1'))
    expect(herleitung()).toMatchObject({ isThinking: false, autoOpen: false })
  })

  test('a masthead (or a card) before the first word folds it too', () => {
    use(turnState([question(), answer('', { answerMeta: { v: 1, topic: 'Fluchtwege' } })], true))
    render(<ChatArea isAuthenticated={true} />)
    expect(herleitung()).toMatchObject({ isThinking: true, autoOpen: false, answering: true })
  })

  test('the answer is withheld while the Herleitung above it folds, then placed under the bar', async () => {
    // The answer message exists from its first drawable content on.
    use(turnState([question()], true))
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    use(turnState([question(), answer('Die')], true))
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)

    expect(screen.queryByTestId('agent-response')).not.toBeInTheDocument()
    expect(await screen.findByTestId('agent-response')).toBeInTheDocument()
  })

  test('a turn that took no step keeps its bar after the settle, so the answer is not pulled up', () => {
    use(turnState([question({ thinkingSteps: [] }), answer('Hallo')], true))
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    expect(screen.getByTestId('chat-thinking')).toBeInTheDocument()

    use(turnState([question({ thinkingSteps: [] }), answer('Hallo')], false))
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    expect(screen.getByTestId('chat-thinking')).toBeInTheDocument()
    expect(herleitung().isThinking).toBe(false)
  })

  test('says the settle once, in a polite status, with the answer\'s gist', () => {
    use(turnState([question(), answer('Die Antwort ist ja. Mehr dazu unten.')], true))
    const { rerender, container } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    const note = () =>
      Array.from(container.querySelectorAll('[role="status"][aria-atomic="true"]')).map(
        (el) => el.textContent
      )
    expect(note()).not.toContain('Answer ready: Die Antwort ist ja.')

    use(turnState([question(), answer('Die Antwort ist ja. Mehr dazu unten.')], false))
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    expect(note()).toContain('Answer ready: Die Antwort ist ja.')
  })

  test('a stopped turn says „Stopped", never done', () => {
    use(turnState([question(), answer('Die Antw', { stopped: true })], true))
    const { rerender, container } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    use(turnState([question(), answer('Die Antw', { stopped: true })], false))
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)

    expect(herleitung().isStopped).toBe(true)
    expect(container.textContent).toContain('Stopped')
  })

  // „Unterbrochen" means the answer was LOST. A turn whose ending this client
  // recorded is never that, whatever the ending was: the answer was handed to
  // a run, refused, stopped, or failed (which has its own error card).
  test.each([
    ['answered', 'finished'],
    ['refused', 'finished'],
    ['handed_off', 'finished'],
    ['cancelled', 'finished'],
    [undefined, 'failed'],
  ] as const)('is not interrupted for a turn that ended %s (%s)', (outcome, phase) => {
    use(
      turnState([question()], false, {
        turns: {
          'user-1': {
            ...initialTurnView('user-1', 'c1'),
            phase,
            ...(outcome ? { outcome } : {}),
          },
        },
      })
    )
    render(<ChatArea isAuthenticated={true} />)
    expect(herleitung().isInterrupted).toBe(false)
  })

  test('a run message counts as the response, and an error card explains a failure', () => {
    use(
      turnState(
        [
          question(),
          {
            id: 'err-1',
            role: 'assistant',
            content: '',
            messageType: 'error',
            errorData: { errorCode: 'agent.response_failed', errorMessage: 'Fehler' },
          },
        ],
        false
      )
    )
    render(<ChatArea isAuthenticated={true} />)
    expect(herleitung().isInterrupted).toBe(false)
  })

  test('a turn this client lost track of, with nothing after it, is interrupted', () => {
    use(turnState([question()], false))
    render(<ChatArea isAuthenticated={true} />)
    expect(herleitung().isInterrupted).toBe(true)
  })
})

/**
 * The „Als Aktenvermerk schreiben" chip belongs to the ANSWER. Decided in the
 * question's row, its rail mounted between the Herleitung and the answer at
 * the settle and pushed the answer down by its height.
 */
describe('ChatArea — the Aktenvermerk chip sits under its answer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSharedThread = { ...INERT_SHARED_THREAD }
    mockProjectId = 'project-1'
    useAnswerRevealStore.setState({ revealingId: null })
  })

  const longBody = 'Schritt. '.repeat(150)
  const state = (isStreaming: boolean): ChatStoreFixture => ({
    currentConversation: {
      id: 'c1',
      messages: [
        { id: 'user-1', role: 'user', content: 'Wie gehe ich vor?', messageType: 'user', thinkingSteps: [thinkingStep()] },
        {
          id: 'answer-1',
          role: 'assistant',
          content: longBody,
          messageType: 'agent_response',
          isStreaming,
          answerMeta: { v: 1, kind: 'walkthrough' },
        },
      ],
    },
    projectId: 'project-1',
    isLoading: false,
    isStreaming,
    hasHydrated: true,
    currentUserMessageId: 'user-1',
    respondToPrompt: mockRespondToPrompt,
    dismissErrorCard: mockDismissErrorCard,
  })
  const use = (s: ChatStoreFixture) =>
    vi
      .mocked(useChatStore)
      .mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
        selector ? selector(asStoreState<ChatStoreWithHydration>(s)) : s
      )

  test('renders in the answer row, after the answer, once it has settled', () => {
    use(state(false))
    render(<ChatArea isAuthenticated={true} />)

    const rail = screen.getByTestId('follow-ups-rail')
    expect(document.getElementById('message-answer-1')!.contains(rail)).toBe(true)
    expect(document.getElementById('message-user-1')!.contains(rail)).toBe(false)
    expect(
      screen.getByTestId('agent-response').compareDocumentPosition(rail) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  test('is not offered while the answer is still streaming or revealing', () => {
    use(state(true))
    const { unmount } = render(<ChatArea isAuthenticated={true} />)
    expect(screen.queryByTestId('follow-ups-rail')).not.toBeInTheDocument()
    unmount()

    useAnswerRevealStore.setState({ revealingId: 'answer-1' })
    use(state(false))
    render(<ChatArea isAuthenticated={true} />)
    expect(screen.queryByTestId('follow-ups-rail')).not.toBeInTheDocument()
  })
})

/**
 * The jump-to-latest button means "there is content below you have not seen".
 * Measured against the END OF THE CONTENT (the anchor spacer's top), not the
 * scroll height, which includes the anchored turn's reserved room.
 */
describe('ChatArea — the jump-to-latest button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSharedThread = { ...INERT_SHARED_THREAD }
    mockProjectId = null
    useAnswerRevealStore.setState({ revealingId: null })
  })

  // Geometry happy-dom does not have: a 900px viewport, the composer's 176px
  // fallback plus the 24px gap over its foot, so content up to 700px is seen.
  let contentEnd = 600
  const withGeometry = () => {
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const el = this as HTMLElement
      const isViewport = el.classList.contains('overflow-y-auto')
      const isSpacer = el.getAttribute('aria-hidden') === 'true' && el.style.minHeight !== ''
      const top = isViewport ? 0 : isSpacer ? contentEnd : 0
      const bottom = isViewport ? 900 : top
      return { top, bottom, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) }
    })
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900)
    return () => {
      rect.mockRestore()
      clientHeight.mockRestore()
    }
  }
  const settledThread: ChatStoreFixture = {
    currentConversation: {
      id: 'c1',
      messages: [
        { id: 'user-1', role: 'user', content: 'Frage', messageType: 'user' },
        { id: 'answer-1', role: 'assistant', content: 'Antwort', messageType: 'agent_response' },
      ],
    },
    isLoading: false,
    isStreaming: false,
    hasHydrated: true,
    currentUserMessageId: null,
    respondToPrompt: mockRespondToPrompt,
    dismissErrorCard: mockDismissErrorCard,
  }
  const readerScrolls = (viewport: Element) =>
    act(() => {
      viewport.dispatchEvent(new Event('wheel'))
      viewport.dispatchEvent(new Event('scroll'))
    })

  test('shows while content lies unseen below, and goes once it is in view', async () => {
    const restore = withGeometry()
    try {
      vi.mocked(useChatStore).mockImplementation(
        (selector?: StoreSelector<ChatStoreWithHydration>) =>
          selector ? selector(asStoreState<ChatStoreWithHydration>(settledThread)) : settledThread
      )
      render(<ChatArea isAuthenticated={true} />)
      const viewport = screen.getByRole('region', { name: 'Chat messages' })

      // The reader scrolls up: the content's end is 500px below what they see.
      contentEnd = 1200
      readerScrolls(viewport)
      expect(screen.getByRole('button', { name: 'Scroll to latest' })).toBeInTheDocument()

      // And back down to it.
      contentEnd = 690
      readerScrolls(viewport)
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Scroll to latest' })).not.toBeInTheDocument()
      )
    } finally {
      restore()
    }
  })

  test('a scroll the page caused never shows it, nor starts following', () => {
    const restore = withGeometry()
    try {
      vi.mocked(useChatStore).mockImplementation(
        (selector?: StoreSelector<ChatStoreWithHydration>) =>
          selector ? selector(asStoreState<ChatStoreWithHydration>(settledThread)) : settledThread
      )
      render(<ChatArea isAuthenticated={true} />)
      const viewport = screen.getByRole('region', { name: 'Chat messages' })

      // No reader input before it: a clamp, a glide. Following (engaged by the
      // thread opening) stays engaged, so there is nothing to offer.
      contentEnd = 1200
      act(() => {
        viewport.dispatchEvent(new Event('scroll'))
      })
      expect(screen.queryByRole('button', { name: 'Scroll to latest' })).not.toBeInTheDocument()
    } finally {
      restore()
    }
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
  const stateWithLastMessage = (
    message: MessageFixture,
    isStreaming: boolean
  ): ChatStoreFixture => ({
    currentConversation: {
      id: 'c1',
      messages: [{ id: 'user-1', role: 'user', content: 'Frage', messageType: 'user' }, message],
    },
    isLoading: isStreaming,
    isStreaming,
    currentUserMessageId: 'user-1',
    hasHydrated: true,
    respondToPrompt: mockRespondToPrompt,
    dismissErrorCard: mockDismissErrorCard,
  })

  const mount = (state: ChatStoreFixture) => {
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) =>
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
          promptInputType: 'choice',
          isPromptResponded: true,
          promptResponse: 'Bauklasse 4',
        },
        true
      )
    )

    // English fallback without an i18n provider (see the AgentPrompt specs).
    expect(screen.getByRole('status', { name: 'Thinking …' })).toBeInTheDocument()
  })

  test('shows nothing while the prompt is still unanswered — that state is the prompt bubble itself', () => {
    mount(
      stateWithLastMessage(
        {
          id: 'prompt-1',
          role: 'assistant',
          content: 'Welche Bauklasse?',
          messageType: 'prompt',
          promptInputType: 'choice',
          isPromptResponded: false,
        },
        true
      )
    )

    // The stubbed AgentPrompt renders; the bottom "typing" cue must not also
    // appear for a question that has not been answered yet.
    expect(screen.getByTestId('agent-prompt')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Thinking …' })).not.toBeInTheDocument()
  })

  test('shows nothing once the session has stopped streaming, even if the prompt is answered', () => {
    mount(
      stateWithLastMessage(
        {
          id: 'prompt-1',
          role: 'assistant',
          content: 'Welche Bauklasse?',
          messageType: 'prompt',
          promptInputType: 'choice',
          isPromptResponded: true,
          promptResponse: 'Bauklasse 4',
        },
        false
      )
    )

    expect(screen.queryByRole('status', { name: 'Thinking …' })).not.toBeInTheDocument()
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
            promptInputType: 'choice',
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
      hasHydrated: true,
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
    })

    expect(screen.getByTestId('agent-response')).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Thinking …' })).not.toBeInTheDocument()
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
    respondToPrompt: mockRespondToPrompt,
    dismissErrorCard: mockDismissErrorCard,
    setComposerPrefill: mockSetComposerPrefill,
  })

  const renderWith = (state: ChatStoreFixture) => {
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) =>
        selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
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
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: { id: 's_conv_1', messages },
          isLoading: false,
          isStreaming: false,
          hasHydrated: true,
          respondToPrompt: mockRespondToPrompt,
          dismissErrorCard: mockDismissErrorCard,
          setComposerPrefill: mockSetComposerPrefill,
        }
        return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      }
    )
  }

  const userMessage = (id: string, authorUserId: string | null, content = id): MessageFixture => ({
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

  test("attributes each human message, and marks the reader's own as theirs", () => {
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

  test("does not draw the separator when everything after the mark is the reader's own", () => {
    // "New" above your own message would be telling you that you have not read
    // yourself.
    mockSharedThread = { ...mockSharedThread, unreadAfterMessageId: 'm1' }
    setThread([userMessage('m1', ME), userMessage('m2', ME)])

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.queryByTestId('unread-divider')).not.toBeInTheDocument()
  })

  test('tells an observer whose question the agent is answering (spec CC-13)', () => {
    mockSharedThread = { ...mockSharedThread, turnInFlight: { actorUserId: ANNA } }
    setThread([userMessage('m1', ANNA, 'question')])

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.getByTestId('turn-in-flight')).toHaveTextContent(/Anna Berger/)
  })

  test("words the banner differently when the turn is the reader's own", () => {
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
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: { id: 's_conv_1', messages },
          isLoading: false,
          isStreaming: false,
          hasHydrated: true,
          respondToPrompt: mockRespondToPrompt,
          dismissErrorCard: mockDismissErrorCard,
          setComposerPrefill: mockSetComposerPrefill,
        }
        return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      }
    )
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
    expect(screen.getByRole('button', { name: 'Continue without Anna Berger' })).toBeInTheDocument()
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
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: { id: 's_conv_1', messages },
          isLoading: false,
          isStreaming: false,
          hasHydrated: true,
          respondToPrompt: mockRespondToPrompt,
          dismissErrorCard: mockDismissErrorCard,
          setComposerPrefill: mockSetComposerPrefill,
        }
        return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      }
    )
  }

  const userMessage = (
    id: string,
    authorUserId: string | null,
    extra: MessageFixture = {}
  ): MessageFixture => ({
    id,
    role: 'user',
    messageType: 'user',
    content: id,
    authorUserId,
    ...extra,
  })

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
      'Anna Berger replied — let Piloti carry on?'
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
      'Anna Berger, Tobias Kern replied — let Piloti carry on?'
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
    // And it steps aside — the composer now holds the offer. It leaves on the
    // exit easing rather than vanishing, so wait for it to have gone.
    await waitFor(() => expect(screen.queryByTestId('handback-offer')).not.toBeInTheDocument())
  })

  test('dismissing it takes it away', async () => {
    const user = userEvent.setup()
    setThread(resolvedThread())

    render(<ChatArea isAuthenticated canCollaborate />)
    await user.click(screen.getByRole('button', { name: 'Not now' }))

    await waitFor(() => expect(screen.queryByTestId('handback-offer')).not.toBeInTheDocument())
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
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: { id: 's_conv_1', messages },
          isLoading: false,
          isStreaming: false,
          hasHydrated: true,
          respondToPrompt: mockRespondToPrompt,
          dismissErrorCard: mockDismissErrorCard,
          setComposerPrefill: mockSetComposerPrefill,
        }
        return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      }
    )
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
      'Piloti answers when mentioned'
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
      'Should Piloti wait to be mentioned?'
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
      screen.queryByRole('button', { name: 'Let Piloti answer everything' })
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
    vi.mocked(useChatStore).mockImplementation(
      (selector?: StoreSelector<ChatStoreWithHydration>) => {
        const state: ChatStoreFixture = {
          currentConversation: { id: 's_conv_1', messages },
          isLoading: false,
          isStreaming: false,
          hasHydrated: true,
          respondToPrompt: mockRespondToPrompt,
          dismissErrorCard: mockDismissErrorCard,
          setComposerPrefill: mockSetComposerPrefill,
        }
        return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      }
    )
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
    mockSpectated = { turn: spectatedTurn({ phase: 'failed' }), live: true }

    render(<ChatArea isAuthenticated canCollaborate />)

    // A turn that dies without persisting an assistant message never publishes
    // `ended` — that event is a side effect of the write that did not happen — so
    // this call is the only thing that unlocks every observer's composer before
    // the staleness clock runs out minutes later.
    expect(mockClearTurnInFlight).toHaveBeenCalled()
  })

  test('a DONE turn keeps it, so the finished answer survives until the message lands', () => {
    mockSpectated = {
      turn: spectatedTurn({ text: 'Ja, ab drei Geschossen.', phase: 'finished' }),
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

describe('ChatArea — opening a thread, its endings and its dock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSharedThread = { ...INERT_SHARED_THREAD }
    mockProjectId = null
    useAnswerRevealStore.setState({ revealingId: null })
  })

  const question = (overrides: MessageFixture = {}): MessageFixture => ({
    id: 'user-1',
    role: 'user',
    content: 'Frage',
    messageType: 'user',
    timestamp: new Date('2026-10-09T08:00:00.000Z'),
    thinkingSteps: [thinkingStep()],
    ...overrides,
  })
  const answer = (content: string, overrides: MessageFixture = {}): MessageFixture => ({
    id: 'answer-1',
    role: 'assistant',
    content,
    messageType: 'agent_response',
    ...overrides,
  })
  const use = (state: ChatStoreFixture) =>
    vi
      .mocked(useChatStore)
      .mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) =>
        selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
      )
  const thread = (messages: MessageFixture[], extra: ChatStoreFixture = {}): ChatStoreFixture => ({
    currentConversation: { id: 'c1', messages },
    isLoading: false,
    isStreaming: false,
    hasHydrated: true,
    currentUserMessageId: null,
    respondToPrompt: mockRespondToPrompt,
    dismissErrorCard: mockDismissErrorCard,
    retryLastUserMessage: vi.fn(),
    ...extra,
  })
  const herleitung = () => mockChatThinking.mock.calls.at(-1)![0] as { endedAs?: string; isInterrupted?: boolean; answering?: boolean }

  test('a thread whose messages are on their way shows the skeleton, never the greeting', () => {
    // The awaiting flag used to be a module Set nothing re-rendered on: a
    // thread opened from the server greeted the reader first, and the
    // composer sprang to the middle of the column and back.
    use(thread([], { pendingMessagesFor: 'c1' }))
    render(<ChatArea isAuthenticated={true} />)

    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
    expect(screen.getByRole('status', { name: /loading/i })).toHaveAttribute('aria-busy', 'true')
  })

  test('a deep link to another thread holds the skeleton over the thread still open', () => {
    use(thread([question()], { pendingMessagesFor: 'c-linked' }))
    render(<ChatArea isAuthenticated={true} />)

    expect(screen.queryByTestId('user-message')).not.toBeInTheDocument()
  })

  test('messages that arrive after the skeleton are placed, not entered', () => {
    use(thread([], { pendingMessagesFor: 'c1' }))
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)

    use(thread([question(), answer('Antwort')]))
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)

    // An entering row mounts at opacity 0; a placed one has no entrance style.
    expect(document.getElementById('message-user-1')?.style.opacity).not.toBe('0')
    expect(document.getElementById('message-answer-1')?.style.opacity).not.toBe('0')
  })

  test('a turn handed to a run keeps its answer row: the run message takes the same node', () => {
    use(thread([question(), answer('Ich lege einen Auftrag an.')]))
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    const row = document.getElementById('message-answer-1')
    expect(row).not.toBeNull()

    use(
      thread([
        question(),
        answer('', {
          id: 'run-message-1',
          runLedger: {
            runId: 'run-1',
            status: 'laeuft',
            phases: [],
            steps: [],
            startedAt: '2026-10-09T08:00:00.000Z',
            updatedAt: '2026-10-09T08:00:00.000Z',
          },
        }),
      ])
    )
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)

    expect(document.getElementById('message-run-message-1')).toBe(row)
    expect(herleitung().endedAs).toBe('handed_off')
  })

  test('a turn that failed reads as failed, never as interrupted or done', () => {
    use(thread([question(), answer('Halber Satz', { failed: true })]))
    render(<ChatArea isAuthenticated={true} />)

    expect(herleitung()).toMatchObject({ endedAs: 'failed', isInterrupted: false })
  })

  test('a turn the queue refused is not handled, not failed and not done', () => {
    use(
      thread([
        question(),
        {
          id: 'err-queue',
          role: 'assistant',
          content: '',
          messageType: 'error',
          errorData: { errorCode: 'research.queue_full', errorMessage: 'Warteschlange voll' },
        },
      ])
    )
    render(<ChatArea isAuthenticated={true} />)

    expect(herleitung()).toMatchObject({ endedAs: 'refused', isInterrupted: false })
  })

  test('a retraction does not reopen the Herleitung over the answer it folded for', () => {
    use(thread([question(), answer('Erster Satz.', { isStreaming: true })], { isStreaming: true, currentUserMessageId: 'user-1' }))
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    expect(herleitung().answering).toBe(true)

    // The answer is retracted: empty again while the next round works.
    use(thread([question(), answer('', { isStreaming: true })], { isStreaming: true, currentUserMessageId: 'user-1' }))
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)

    expect(herleitung().answering).toBe(true)
  })

  test('a dropped connection is a quiet line above the composer, not a card in the thread', async () => {
    const lost: MessageFixture = {
      id: 'err-conn',
      role: 'assistant',
      content: '',
      messageType: 'error',
      errorData: { errorCode: 'connection.failed' },
    }
    use(thread([question(), answer('Antwort'), lost]))
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)

    expect(screen.queryByTestId('error-card')).not.toBeInTheDocument()
    const dock = screen.getByTestId('thread-status-dock')
    expect(dock).toHaveTextContent(/connection lost/i)

    // The socket is back: the recovery hook dismissed the card.
    use(thread([question(), answer('Antwort')]))
    rerender(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('thread-status-dock')).toHaveTextContent(/reconnected/i))
  })

  test('a colleague typing is said in the dock, outside the thread it would bob', () => {
    mockSharedThread = {
      ...INERT_SHARED_THREAD,
      shared: true,
      typists: [{ userId: 'user_anna', name: 'Anna Berger' }],
    }
    use(thread([question(), answer('Antwort')]))
    render(<ChatArea isAuthenticated={true} />)

    const presence = screen.getByTestId('typing-presence')
    expect(screen.getByTestId('thread-status-dock')).toContainElement(presence)
    expect(screen.getByRole('region')).not.toContainElement(presence)
  })
})
