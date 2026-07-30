import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ChatArea } from './ChatArea'

// Mock the chat store
const mockRespondToPrompt = vi.fn()
const mockDismissErrorCard = vi.fn()
const mockSetComposerPrefill = vi.fn()
const mockGetThinkingStepsForMessage = vi.fn((_messageId: string) => [] as { id: string; displayName: string }[])
const mockChatThinking = vi.fn((_props: unknown) => <div data-testid="chat-thinking">Thinking...</div>)

// The welcome state greets the user by first name via useAuth; mocked here so
// tests don't need the AppConfig/AuthKit provider stack.
let mockUserName: string | null = 'Max Mustermann'

vi.mock('@/adapters/auth', () => ({
  useAuth: vi.fn(() => ({
    isAuthenticated: true,
    user: mockUserName ? { id: 'user-1', name: mockUserName } : null,
  })),
}))

vi.mock('@/features/chat', () => ({
  useChatStore: vi.fn((selector?: (s: any) => any) => {
    const state = {
      currentConversation: { messages: [] },
      isLoading: false,
      isStreaming: false,
      hasHydrated: true,
      thinkingSteps: [],
      respondToPrompt: mockRespondToPrompt,
      dismissErrorCard: mockDismissErrorCard,
      setComposerPrefill: mockSetComposerPrefill,
      getThinkingStepsForMessage: mockGetThinkingStepsForMessage,
    }
    return selector ? selector(state) : state
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
}))

// The ADR-0033 seam is mocked so this spec can drive the states it produces
// (shared / not shared, a turn in flight, an unread anchor) without a server. Its
// own behaviour — what it fetches and when — is covered in
// features/collaboration/hooks/use-shared-thread.spec.ts. The default is the INERT
// result, which is what every pre-collaboration test in this file relies on.
const INERT_SHARED_THREAD = {
  shared: false,
  myRole: null,
  loading: false,
  connected: false,
  turnInFlight: null as { actorUserId: string | null } | null,
  participants: [] as Array<{ userId: string; name: string }>,
  unreadAfterMessageId: null as string | null,
  lastArrival: null as { messageId: string; authorUserId: string | null; authorName: string | null } | null,
  authorOf: (_userId?: string | null) => null as { userId: string; name: string } | null,
  refresh: () => {},
}
let mockSharedThread = { ...INERT_SHARED_THREAD }

vi.mock('@/features/collaboration/hooks/use-shared-thread', () => ({
  useSharedThread: () => mockSharedThread,
}))

// The derived hand-off state behind the hand-back offer. Mocked at the hook
// boundary: the offer must never compute a wait locally (ADR-0034), so what it
// reads is the server's answer and nothing else.
let mockAwaitingPending: Array<{ id: string }> = []

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
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
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
      return selector ? selector(state) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('user-message')).toHaveTextContent('Hello world')
  })

  test('does not render legacy status messages', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
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
      return selector ? selector(state) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    // The dead SSE status transport was removed - status messages are no longer rendered
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('renders agent prompts', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        currentConversation: {
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: 'Please provide more details',
              messageType: 'prompt',
              promptType: 'input',
            },
          ],
        },
        isLoading: false,
        hasHydrated: true,
        isStreaming: false,
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
      }
      return selector ? selector(state) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('agent-prompt')).toBeInTheDocument()
  })

  test('renders agent responses', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
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
      return selector ? selector(state) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('agent-response')).toHaveTextContent('Here is your answer')
  })

  test('renders file messages', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
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
      return selector ? selector(state) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    // File messages render inline with the file name
    expect(screen.getByText(/document\.pdf/)).toBeInTheDocument()
  })

  test('renders error banners', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        currentConversation: {
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: '',
              messageType: 'error',
              errorData: {
                errorCode: 'E001',
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
      return selector ? selector(state) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    expect(screen.getByTestId('error-card')).toBeInTheDocument()
  })

  test('does not render assistant messages (full reports)', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
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
      return selector ? selector(state) : state
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
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        currentConversation: null,
        isLoading: false,
        hasHydrated: true,
        isStreaming: false,
        respondToPrompt: mockRespondToPrompt,
        dismissErrorCard: mockDismissErrorCard,
      }
      return selector ? selector(state) : state
    })

    render(<ChatArea isAuthenticated={true} />)

    // Should render welcome state
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(GREETING_RE)
  })

  // The in-feed file_upload_status banner surface was removed (contract C2), so
  // there is no longer a render branch to exercise here.

  test('keeps earlier interrupted thinking state after a later completed turn', () => {
    mockGetThinkingStepsForMessage.mockImplementation((messageId: string) => {
      if (messageId === 'user-1') return [{ id: 'step-1', displayName: 'Step 1' }]
      if (messageId === 'user-2') return [{ id: 'step-2', displayName: 'Step 2' }]
      return []
    })

    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
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
      return selector ? selector(state) : state
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

    const makeState = (currentUserMessageId: string | null) => ({
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
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) =>
      selector ? selector(makeState(null)) : makeState(null)
    )
    // ChatArea is memoized; with the store mocked there's no live subscription,
    // so a distinct prop (a fresh onSignIn) stands in to trigger the re-render
    // the real store subscription would cause when currentUserMessageId changes.
    const { rerender } = render(<ChatArea isAuthenticated={true} onSignIn={vi.fn()} />)
    expect(scrollIntoView).not.toHaveBeenCalled()

    // A new user message becomes the active turn (send): it must be anchored to
    // the TOP (block: 'start'), letting the answer stream downward — NOT chased
    // to the bottom.
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) =>
      selector ? selector(makeState('user-1')) : makeState('user-1')
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

    const state = {
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

    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) =>
      selector ? selector(state) : state
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
      if (messageId === 'user-1') return [{ id: 'step-1', displayName: 'Step 1' }]
      if (messageId === 'user-2') return [{ id: 'step-2', displayName: 'Step 2' }]
      return []
    })

    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
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
      return selector ? selector(state) : state
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
 * The multi-person thread (spec CC-5, CC-13, CC-19).
 *
 * These cover what ChatArea itself decides: who each message is attributed to,
 * which messages GROUP under one header, where the unread separator lands, and
 * whether the observer is told that the agent is busy on someone else's turn.
 */
describe('ChatArea — shared thread', () => {
  const ME = 'user-1'
  const ANNA = 'user_anna'

  // Typed with `never` rather than the file's older `any` so the helper adds no
  // new lint warnings; the state object is a fixture, not the real store shape.
  const setThread = (messages: unknown[]) => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: never) => unknown) => {
      const state = {
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
      return selector ? selector(state as never) : state
    })
  }

  const userMessage = (id: string, authorUserId: string | null, content = id) => ({
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

  const setThread = (messages: unknown[]) => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: never) => unknown) => {
      const state = {
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
      return selector ? selector(state as never) : state
    })
  }

  const userMessage = (
    id: string,
    authorUserId: string | null,
    extra: Record<string, unknown> = {},
  ) => ({ id, role: 'user', messageType: 'user', content: id, authorUserId, ...extra })

  /** The hand-off itself: the server addressed people and NOT the agent (MN-1). */
  const asks = (users: string[]) => ({ addressees: { agent: false, users } })

  /** The reader asked Anna; Anna has answered; nothing is outstanding. */
  const resolvedThread = () => [
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
      'Anna Berger answered — let Piloti carry on?',
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
      'Anna Berger, Tobias Kern answered — let Piloti carry on?',
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

    expect(mockSetComposerPrefill).toHaveBeenCalledWith('@Piloti please carry on from here.')
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

  test('stays away while the thread is still waiting on someone — the banner owns that state', () => {
    mockAwaitingPending = [{ id: 'r-1' }]
    setThread(resolvedThread())

    render(<ChatArea isAuthenticated canCollaborate />)

    expect(screen.queryByTestId('handback-offer')).not.toBeInTheDocument()
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
