import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import type { ResourceSharingState } from '@/lib/sharing/types'
import { ChatToolbar } from './ChatToolbar'

// Sharing data hooks are stubbed: this spec is about what the toolbar shows and
// gates, not about the (separately tested) fetching. The default state is "nothing
// loaded", which is exactly what a collaboration-disabled org looks like — so the
// pre-existing tests below are unaffected by the sharing surfaces.
let mockSharingState: ResourceSharingState | null = null
const mockUseSharing = vi.fn()

vi.mock('@/features/collaboration/hooks/use-sharing', () => ({
  useSharing: (...args: unknown[]) => {
    mockUseSharing(...args)
    return {
      state: mockSharingState,
      loading: false,
      loadError: false,
      failure: null,
      saving: false,
      refresh: vi.fn(),
      setVisibility: vi.fn(async () => true),
      grant: vi.fn(async () => true),
      changeRole: vi.fn(async () => true),
      revoke: vi.fn(async () => true),
      escalate: vi.fn(async () => true),
    }
  },
  useShareCandidates: () => ({ candidates: [], loading: false }),
}))

// Mock the layout store — the component uses both the hook selector form and
// useLayoutStore.getState() inside click handlers.
const mockToggleSessionsPanel = vi.fn()
const mockCloseRightPanel = vi.fn()
const mockOpenRightPanel = vi.fn()
const mockSetMobileNavOpen = vi.fn()
let mockRightPanel: string | null = null
let mockResearchPanelTab = 'tasks'

function getLayoutState() {
  return {
    rightPanel: mockRightPanel,
    researchPanelTab: mockResearchPanelTab,
    toggleSessionsPanel: mockToggleSessionsPanel,
    closeRightPanel: mockCloseRightPanel,
    openRightPanel: mockOpenRightPanel,
    setMobileNavOpen: mockSetMobileNavOpen,
  }
}

vi.mock('../store', () => {
  const useLayoutStore = Object.assign(
    vi.fn((selector?: (s: ReturnType<typeof getLayoutState>) => unknown) => {
      const state = getLayoutState()
      return selector ? selector(state) : state
    }),
    { getState: () => getLayoutState() }
  )
  return { useLayoutStore }
})

let mockIsAuthenticated = true

vi.mock('@/adapters/auth', () => ({
  useAuth: vi.fn(() => ({ isAuthenticated: mockIsAuthenticated })),
}))

let mockIsDeepResearchStreaming = false
let mockDeepResearchJobId: string | null = null
let mockIsLoadJobDataLoading = false
let mockCurrentSessionId: string | null = 'session-1'
const mockLoadResearchPanelTab = vi.fn()
const mockUpdateConversationTitle = vi.fn()

vi.mock('@/features/chat', () => ({
  useChatStore: (
    selector: (state: {
      isDeepResearchStreaming: boolean
      deepResearchJobId: string | null
      currentConversation: { id: string } | null
      updateConversationTitle: (id: string, title: string) => void
    }) => unknown
  ) =>
    selector({
      isDeepResearchStreaming: mockIsDeepResearchStreaming,
      deepResearchJobId: mockDeepResearchJobId,
      currentConversation: mockCurrentSessionId ? { id: mockCurrentSessionId } : null,
      updateConversationTitle: mockUpdateConversationTitle,
    }),
  useLoadJobData: () => ({
    loadResearchPanelTab: mockLoadResearchPanelTab,
    isLoading: mockIsLoadJobDataLoading,
  }),
}))

/**
 * Open the thread menu — the one place every non-primary header action lives.
 * The header shows only what is TRUE about the thread plus New chat; share,
 * rename and the research report are behind this trigger by design, so most
 * action tests start here.
 */
async function openThreadMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('thread-menu'))
  await screen.findByRole('menu')
}

/**
 * Pick an item out of the open thread menu.
 *
 * The hover is load-bearing, not decoration: a menu item is selected while it is
 * the *focused* item, and it becomes focused on pointer movement. `user.click`
 * dispatches no `pointermove`, so clicking an item that was never hovered fires
 * `onSelect` only sometimes — which showed up as a rename test that failed about
 * one run in four.
 */
async function selectMenuItem(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
): Promise<void> {
  const item = screen.getByTestId(testId)
  await user.hover(item)
  await user.click(item)
}

describe('ChatToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAuthenticated = true
    mockRightPanel = null
    mockResearchPanelTab = 'tasks'
    mockIsDeepResearchStreaming = false
    mockDeepResearchJobId = null
    mockIsLoadJobDataLoading = false
    mockCurrentSessionId = 'session-1'
    mockSharingState = null
  })

  describe('research toggle', () => {
    // The toggle is RE-ENTRY to a report this thread already has — the answer card
    // that produced it is the primary door — so its precondition is that a report
    // exists. Every test below that is about the toggle's behaviour starts there.
    beforeEach(() => {
      mockDeepResearchJobId = 'job-123'
    })

    test('is offered in the thread menu once a report exists', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar />)

      await openThreadMenu(user)

      expect(screen.getByTestId('research-panel-toggle')).toBeInTheDocument()
    })

    test('is absent on a thread that never ran deep research', () => {
      mockDeepResearchJobId = null
      mockCurrentSessionId = null // …and nothing else to put in the menu either

      render(<ChatToolbar />)

      // Not merely hidden in the menu: with no report, no rename and no sharing,
      // there is nothing occasional to disclose, so the trigger itself is gone.
      // A permanent "Research" button here was a door to an empty room.
      expect(screen.queryByTestId('thread-menu')).not.toBeInTheDocument()
      expect(screen.queryByTestId('research-panel-toggle')).not.toBeInTheDocument()
    })

    test('appears while a run is streaming, before any job id is known', async () => {
      mockDeepResearchJobId = null
      mockIsDeepResearchStreaming = true
      const user = userEvent.setup()

      render(<ChatToolbar />)
      await openThreadMenu(user)

      expect(screen.getByTestId('research-panel-toggle')).toBeInTheDocument()
    })

    test('stays while the panel is open, so it can close what it opened', async () => {
      mockDeepResearchJobId = null
      mockRightPanel = 'research'
      const user = userEvent.setup()

      render(<ChatToolbar />)
      await openThreadMenu(user)

      expect(screen.getByTestId('research-panel-toggle')).toBeInTheDocument()
    })

    test('opens the research panel when closed', async () => {
      mockRightPanel = null
      const user = userEvent.setup()

      render(<ChatToolbar />)
      await openThreadMenu(user)

      await selectMenuItem(user, 'research-panel-toggle')

      expect(mockOpenRightPanel).toHaveBeenCalledWith('research')
    })

    test('closes the research panel when open', async () => {
      mockRightPanel = 'research'
      const user = userEvent.setup()

      render(<ChatToolbar />)
      await openThreadMenu(user)

      await selectMenuItem(user, 'research-panel-toggle')

      expect(mockCloseRightPanel).toHaveBeenCalled()
      expect(mockOpenRightPanel).not.toHaveBeenCalled()
    })

    test('reloads the active tab for the current job when opening', async () => {
      mockRightPanel = null
      mockDeepResearchJobId = 'job-123'
      mockResearchPanelTab = 'thinking'
      const user = userEvent.setup()

      render(<ChatToolbar />)
      await openThreadMenu(user)

      await selectMenuItem(user, 'research-panel-toggle')

      expect(mockLoadResearchPanelTab).toHaveBeenCalledWith('job-123', 'thinking')
    })

    test('does not reload job data while another load is in flight', async () => {
      mockRightPanel = null
      mockDeepResearchJobId = 'job-123'
      mockIsLoadJobDataLoading = true
      const user = userEvent.setup()

      render(<ChatToolbar />)
      await openThreadMenu(user)

      await selectMenuItem(user, 'research-panel-toggle')

      expect(mockOpenRightPanel).toHaveBeenCalledWith('research')
      expect(mockLoadResearchPanelTab).not.toHaveBeenCalled()
    })

    test('is disabled when not authenticated', async () => {
      mockIsAuthenticated = false
      const user = userEvent.setup()

      render(<ChatToolbar />)
      await openThreadMenu(user)

      expect(screen.getByTestId('research-panel-toggle')).toHaveAttribute('aria-disabled', 'true')
    })

    test('a live run is STATUS in the header, not a control', () => {
      mockIsDeepResearchStreaming = true
      mockSharingState = SHARED_STATE

      render(<ChatToolbar conversationId="session-1" isCollaborationEnabled />)

      // The one piece of research the header carries in the open: the thread's own
      // banner scrolls away, so this is the persistent "still working" signal. It
      // states — the way INTO the report is the menu item.
      const running = screen.getByTestId('research-running')
      expect(running).toBeInTheDocument()
      expect(running.querySelector('button')).toBeNull()
    })

    test('says nothing about research when nothing is running', () => {
      mockIsDeepResearchStreaming = false
      mockSharingState = SHARED_STATE

      render(<ChatToolbar conversationId="session-1" isCollaborationEnabled />)

      expect(screen.queryByTestId('research-running')).not.toBeInTheDocument()
    })
  })

  describe('chat-started gating', () => {
    test('hides New chat, Research and the breadcrumb before a chat has started', () => {
      render(
        <ChatToolbar
          sessionTitle="My Session"
          projectName="Wohnbau Favoriten"
          isChatStarted={false}
        />
      )

      // The quiet navigation affordances stay available on the empty start screen.
      expect(screen.getByRole('button', { name: 'Toggle sessions sidebar' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open navigation' })).toBeInTheDocument()

      // The actions + thread identity are withheld until a chat starts.
      expect(screen.queryByTestId('thread-menu')).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Create new session' })
      ).not.toBeInTheDocument()
      expect(screen.queryByText('Wohnbau Favoriten')).not.toBeInTheDocument()
      expect(screen.queryByText('My Session')).not.toBeInTheDocument()
    })

    test('shows New chat, the thread menu and the breadcrumb once a chat has started', async () => {
      mockDeepResearchJobId = 'job-123'
      const user = userEvent.setup()
      render(
        <ChatToolbar
          sessionTitle="My Session"
          projectName="Wohnbau Favoriten"
          isChatStarted
        />
      )

      expect(screen.getByRole('button', { name: 'Create new session' })).toBeInTheDocument()
      expect(screen.getByText('Wohnbau Favoriten')).toBeInTheDocument()
      expect(screen.getByText('My Session')).toBeInTheDocument()

      await openThreadMenu(user)
      expect(screen.getByTestId('research-panel-toggle')).toBeInTheDocument()
    })
  })

  describe('new session button', () => {
    test('invokes onNewSession when enabled', async () => {
      const onNewSession = vi.fn()
      const user = userEvent.setup()

      render(<ChatToolbar onNewSession={onNewSession} />)

      await user.click(screen.getByRole('button', { name: 'Create new session' }))

      expect(onNewSession).toHaveBeenCalledOnce()
    })

    test('is disabled while a session is active', () => {
      render(<ChatToolbar isNewSessionDisabled />)

      expect(screen.getByRole('button', { name: 'Create new session' })).toBeDisabled()
    })
  })

  // The data-sources toggle was removed from the toolbar: the composer's
  // Datengrundlage chip already owns opening that panel, so the navbar no
  // longer duplicates it.
  describe('sessions toggle', () => {
    test('toggles the sessions panel', async () => {
      const user = userEvent.setup()

      render(<ChatToolbar />)

      await user.click(screen.getByRole('button', { name: 'Toggle sessions sidebar' }))

      expect(mockToggleSessionsPanel).toHaveBeenCalledOnce()
    })
  })

  describe('mobile navigation opener', () => {
    test('opens the global nav drawer (the way back out of chat on mobile)', async () => {
      const user = userEvent.setup()

      render(<ChatToolbar />)

      await user.click(screen.getByRole('button', { name: 'Open navigation' }))

      expect(mockSetMobileNavOpen).toHaveBeenCalledWith(true)
    })
  })

  describe('breadcrumb + inline rename', () => {
    test('renders the current session title', () => {
      render(<ChatToolbar sessionTitle="My Session" />)

      expect(screen.getByText('My Session')).toBeInTheDocument()
    })

    test('renders "{project} / {session title}" when a project name is given', () => {
      render(<ChatToolbar sessionTitle="My Session" projectName="Wohnbau Favoriten" />)

      expect(screen.getByText('Wohnbau Favoriten')).toBeInTheDocument()
      expect(screen.getByText('/')).toBeInTheDocument()
      expect(screen.getByText('My Session')).toBeInTheDocument()
    })

    test('the project segment does not shrink — it truncates at its own cap or not at all', () => {
      render(<ChatToolbar sessionTitle="My Session" projectName="Wohnbau Favoriten" />)

      // Guards the regression this rule exists for: as a shrinkable flex child the
      // project name collapsed to "Wohnb…" — an ellipsis naming nothing while still
      // charging for its space and its separator. Only a screenshot shows the
      // crowding; this pins the fix that a refactor would otherwise drop.
      expect(screen.getByText('Wohnbau Favoriten')).toHaveClass('shrink-0')
    })

    test('clicking the title opens the editor — the shortcut, alongside the menu', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      // Two ways in, on purpose: the menu entry is how anyone DISCOVERS renaming,
      // this is the fast path once you know it. Unlike the menu route it needs no
      // deferral — no menu is closing, so nothing is about to reclaim focus.
      await user.click(screen.getByRole('button', { name: /rename session/i }))

      expect(screen.getByRole('textbox', { name: /session title/i })).toHaveValue('My Session')
    })

    test('the title cannot be renamed without an active session', () => {
      mockCurrentSessionId = null
      render(<ChatToolbar sessionTitle="My Session" />)

      expect(screen.getByRole('button', { name: /rename session/i })).toBeDisabled()
    })

    test('the menu opens the inline editor; Enter commits via the store rename action', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await openThreadMenu(user)
      await selectMenuItem(user, 'rename-session')

      const input = await screen.findByRole('textbox', { name: /session title/i }, { timeout: 5000 })
      expect(input).toHaveValue('My Session')

      await user.clear(input)
      await user.type(input, 'Fluchtweg OG2{Enter}')

      expect(mockUpdateConversationTitle).toHaveBeenCalledWith('session-1', 'Fluchtweg OG2')
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    test('Escape cancels the edit without renaming', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await openThreadMenu(user)
      await selectMenuItem(user, 'rename-session')
      const input = await screen.findByRole('textbox', { name: /session title/i }, { timeout: 5000 })
      await user.clear(input)
      await user.type(input, 'discarded{Escape}')

      expect(mockUpdateConversationTitle).not.toHaveBeenCalled()
      expect(screen.getByText('My Session')).toBeInTheDocument()
    })

    test('blur commits the edit', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await openThreadMenu(user)
      await selectMenuItem(user, 'rename-session')
      const input = await screen.findByRole('textbox', { name: /session title/i }, { timeout: 5000 })
      await user.clear(input)
      await user.type(input, 'Renamed on blur')
      await user.tab()

      expect(mockUpdateConversationTitle).toHaveBeenCalledWith('session-1', 'Renamed on blur')
    })

    test('committing an unchanged or empty title does not rename', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await openThreadMenu(user)
      await selectMenuItem(user, 'rename-session')
      await screen.findByRole('textbox', { name: /session title/i }, { timeout: 5000 })
      await user.keyboard('{Enter}')

      expect(mockUpdateConversationTitle).not.toHaveBeenCalled()
    })

    test('rename is not offered without an active session', async () => {
      mockCurrentSessionId = null
      mockDeepResearchJobId = 'job-123' // keep the menu itself around
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await openThreadMenu(user)

      // An action that cannot run is not listed. A disabled row here would only
      // pose a question the reader cannot answer from the menu.
      expect(screen.queryByTestId('rename-session')).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Sharing surfaces (spec SH-17/SH-18). Everything here is gated twice: the org's
// collaboration flag AND a reachable, started conversation.
// ---------------------------------------------------------------------------

const SHARED_STATE: ResourceSharingState = {
  resourceType: 'conversation',
  resourceId: 'session-1',
  visibility: 'private',
  allowedVisibilities: ['private', 'project'],
  myRole: 'owner',
  canManage: true,
  canEscalate: false,
  shared: true,
  entries: [
    {
      person: { userId: 'u-me', name: 'Matthias Bigl', email: null, profilePictureUrl: null },
      role: 'owner',
      reason: 'creator',
      grantedBy: null,
    },
    {
      person: { userId: 'u-anna', name: 'Anna Weber', email: null, profilePictureUrl: null },
      role: 'collaborator',
      reason: 'grant',
      grantedBy: 'u-me',
    },
  ],
}

describe('ChatToolbar — sharing surfaces', () => {
  // This block used to inherit whatever the previous test happened to leave in the
  // module-level mocks — the reset lives in the other describe's beforeEach, which
  // does not reach here. Reset explicitly so each case states its own preconditions.
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAuthenticated = true
    mockRightPanel = null
    mockIsDeepResearchStreaming = false
    mockDeepResearchJobId = null
    mockIsLoadJobDataLoading = false
    mockCurrentSessionId = 'session-1'
    mockSharingState = null
  })

  test('shows nothing collaboration-related when the feature is off (default-deny)', () => {
    render(<ChatToolbar sessionTitle="My Session" conversationId="session-1" />)

    expect(mockUseSharing).toHaveBeenCalledWith('conversation', 'session-1', false)
    expect(screen.queryByTestId('participant-strip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('access-chip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('share-button')).not.toBeInTheDocument()
  })

  test('does not even ask the server without a conversation, or before the chat starts', () => {
    render(<ChatToolbar isCollaborationEnabled conversationId={null} />)
    expect(mockUseSharing).toHaveBeenLastCalledWith('conversation', null, false)

    render(<ChatToolbar isCollaborationEnabled conversationId="session-1" isChatStarted={false} />)
    expect(mockUseSharing).toHaveBeenLastCalledWith('conversation', 'session-1', false)
  })

  test('asks for sharing state once the feature is on and the thread is reachable', () => {
    mockSharingState = SHARED_STATE
    render(<ChatToolbar sessionTitle="My Session" isCollaborationEnabled conversationId="session-1" />)

    expect(mockUseSharing).toHaveBeenCalledWith('conversation', 'session-1', true)
  })

  test('states who-can-see-this ONCE — the faces, not the faces plus a chip saying the same', () => {
    mockSharingState = SHARED_STATE
    render(
      <ChatToolbar
        sessionTitle="My Session"
        isCollaborationEnabled
        conversationId="session-1"
        currentUserId="u-me"
      />,
    )

    expect(screen.getByTestId('participant-strip')).toBeInTheDocument()
    // The chip would read "Shared with 1" — the same sentence the two faces
    // already are, and the widest element in a row that has to hold the thread's
    // own title. Under `private` the roster IS the audience, so the faces say it.
    expect(screen.queryByTestId('access-chip')).not.toBeInTheDocument()
  })

  test('the faces are STATUS — they say who is here, they do not act', () => {
    mockSharingState = SHARED_STATE
    render(
      <ChatToolbar
        sessionTitle="My Session"
        isCollaborationEnabled
        conversationId="session-1"
        currentUserId="u-me"
      />,
    )

    // The header's rule: information is not clickable, controls look like
    // controls. An avatar stack that silently opened a dialog was the clearest
    // case of the two being mixed — and it made sharing's ONE door into three.
    expect(screen.getByTestId('participant-strip').tagName).not.toBe('BUTTON')
  })

  test('a blanket rule REPLACES the faces — the rule is the audience, not the roster', () => {
    mockSharingState = { ...SHARED_STATE, visibility: 'project' }
    render(
      <ChatToolbar
        sessionTitle="My Session"
        isCollaborationEnabled
        conversationId="session-1"
        currentUserId="u-me"
      />,
    )

    expect(screen.getByTestId('access-chip')).toHaveTextContent('Project')
    // Not both. Under a blanket rule the roster is not a summary of the audience
    // but a partial sample of it — two faces beside "Projekt" read as "these two
    // can see it" when the truth is "everyone in the project can". The named
    // exceptions belong where there is room to explain them: the sharing surface.
    expect(screen.queryByTestId('participant-strip')).not.toBeInTheDocument()
  })

  test('a solo private thread carries no collaboration furniture at all', async () => {
    mockSharingState = { ...SHARED_STATE, entries: [SHARED_STATE.entries[0]] }
    const user = userEvent.setup()
    render(
      <ChatToolbar
        sessionTitle="My Session"
        isCollaborationEnabled
        conversationId="session-1"
        currentUserId="u-me"
      />,
    )

    // Neither faces nor a "Private" chip: the default state of the overwhelmingly
    // common thread needs no announcement…
    expect(screen.queryByTestId('participant-strip')).not.toBeInTheDocument()
    expect(screen.queryByTestId('access-chip')).not.toBeInTheDocument()
    // …but sharing is still reachable, which is how a thread stops being solo.
    await openThreadMenu(user)
    expect(screen.getByTestId('share-button')).toBeInTheDocument()
  })

  test('sharing has exactly ONE door in the header (SH-17), and it is the menu', async () => {
    mockSharingState = SHARED_STATE
    const user = userEvent.setup()
    render(
      <ChatToolbar
        sessionTitle="My Session"
        isCollaborationEnabled
        conversationId="session-1"
        currentUserId="u-me"
      />,
    )

    // Nothing in the open row opens it — not the faces, not a second button.
    expect(screen.queryByTestId('share-dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('share-button')).not.toBeInTheDocument()

    await openThreadMenu(user)
    await selectMenuItem(user, 'share-button')

    expect(await screen.findByTestId('share-dialog')).toBeInTheDocument()
  })

  test('nothing is claimed about access before the server has answered', async () => {
    mockSharingState = null
    mockDeepResearchJobId = 'job-123' // keep the menu itself around
    const user = userEvent.setup()
    render(<ChatToolbar sessionTitle="My Session" isCollaborationEnabled conversationId="session-1" />)

    expect(screen.queryByTestId('access-chip')).not.toBeInTheDocument()
    await openThreadMenu(user)
    expect(screen.queryByTestId('share-button')).not.toBeInTheDocument()
  })
})
