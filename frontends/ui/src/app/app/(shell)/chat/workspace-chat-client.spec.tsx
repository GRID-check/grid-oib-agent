/**
 * The Büro's client half (P1.5).
 *
 * What it must do is small and entirely about the store: declare the surface,
 * ask for the right rows, and hand the surface back on the way out. The last
 * one is the guard worth a test — a scope left set makes the NEXT project chat
 * fetch workspace rows and show the reader an empty history.
 */

import { render, screen, waitFor } from '@/test-utils'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/adapters/auth', () => ({
  useAuth: () => ({ isAuthenticated: true, signIn: vi.fn() }),
}))

vi.mock('@/features/layout', () => ({
  MainLayout: (props: Record<string, unknown>) => (
    <div data-testid="main-layout" data-props={JSON.stringify(props)} />
  ),
}))

/**
 * The URL, made drivable. The global setup mocks `next/navigation` with an
 * empty `URLSearchParams` and a `/` pathname; `?mount=` is the one thing this
 * client reads OFF the URL and then has to remove from it, so both halves have
 * to be observable here.
 */
const mockReplace = vi.fn()
let mockSearch = new URLSearchParams()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/chat',
  useSearchParams: () => mockSearch,
}))

import { useChatStore } from '@/features/chat'
import { initialMountsState } from '@/features/chat/stores'
import { WorkspaceChatClient } from './workspace-chat-client'

const flags = {
  showSourceBadges: true,
  showConfidenceChip: true,
  showAnswerFeedback: true,
  showResearchInHistory: true,
}

beforeEach(() => {
  mockSearch = new URLSearchParams()
  mockReplace.mockClear()
  useChatStore.setState({
    projectId: 'proj-a',
    scope: 'project',
    conversations: [],
    currentUserId: 'user-1',
    currentConversation: null,
    ...initialMountsState,
  })
  vi.spyOn(useChatStore.getState(), 'loadServerConversations').mockResolvedValue(undefined)
})

describe('WorkspaceChatClient', () => {
  it('declares the workspace surface and drops the project', async () => {
    render(<WorkspaceChatClient {...flags} />)

    await waitFor(() => expect(useChatStore.getState().scope).toBe('workspace'))
    expect(useChatStore.getState().projectId).toBeNull()
  })

  it('loads the office history without naming a project', async () => {
    const load = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({ loadServerConversations: load })

    render(<WorkspaceChatClient {...flags} />)

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    expect(load).toHaveBeenCalledWith()
  })

  it('hands the project surface back on unmount', async () => {
    const { unmount } = render(<WorkspaceChatClient {...flags} />)
    await waitFor(() => expect(useChatStore.getState().scope).toBe('workspace'))

    unmount()

    expect(useChatStore.getState().scope).toBe('project')
  })

  it('passes the chat feature flags on, and no project of any kind', async () => {
    render(<WorkspaceChatClient {...flags} />)

    const props = JSON.parse(
      screen.getByTestId('main-layout').getAttribute('data-props') ?? '{}',
    ) as Record<string, unknown>
    expect(props).toMatchObject(flags)
    expect(props).not.toHaveProperty('projectId')
    expect(props).not.toHaveProperty('projectCollection')
    expect(props).not.toHaveProperty('projectName')
  })
})

/**
 * `/app/chat?mount=<projectId>` — the doorway out of a project chat.
 *
 * Two things have to be true and they pull against each other: the project must
 * land in view without the reader doing anything, and the parameter must be
 * gone afterwards, so a refresh does not re-mount a project they have since
 * removed.
 */
describe('the ?mount= doorway', () => {
  it('mounts the project once and strips the parameter', async () => {
    mockSearch = new URLSearchParams('mount=proj-see')
    const mountProject = vi.fn().mockResolvedValue(true)
    useChatStore.setState({ mountProject })

    render(<WorkspaceChatClient {...flags} />)

    await waitFor(() => expect(mountProject).toHaveBeenCalledTimes(1))
    const [, projectId, , reason] = mountProject.mock.calls[0] as unknown[]
    expect(projectId).toBe('proj-see')
    // The notice has to say WHY it is in view, and this is the only carrier.
    expect(reason).toBe('fromProject')
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/app/chat', { scroll: false }))
  })

  it('does not mount again when the client re-renders', async () => {
    mockSearch = new URLSearchParams('mount=proj-see')
    const mountProject = vi.fn().mockResolvedValue(true)
    useChatStore.setState({ mountProject })

    const { rerender } = render(<WorkspaceChatClient {...flags} />)
    await waitFor(() => expect(mountProject).toHaveBeenCalledTimes(1))
    rerender(<WorkspaceChatClient {...flags} />)

    expect(mountProject).toHaveBeenCalledTimes(1)
  })

  it('renders the office anyway when the mount is refused — not an empty chat', async () => {
    mockSearch = new URLSearchParams('mount=proj-see')
    const mountProject = vi.fn().mockResolvedValue(false)
    useChatStore.setState({ mountProject })

    render(<WorkspaceChatClient {...flags} />)

    await waitFor(() => expect(mountProject).toHaveBeenCalled())
    expect(screen.getByTestId('main-layout')).toBeInTheDocument()
    // The refusal itself is the store's, and the transcript renders it — the
    // route must not swallow it by failing to reach the surface at all.
    expect(useChatStore.getState().mounts).toEqual([])
  })

  it('touches nothing when there is no parameter', async () => {
    const mountProject = vi.fn()
    useChatStore.setState({ mountProject })

    render(<WorkspaceChatClient {...flags} />)

    await waitFor(() => expect(useChatStore.getState().scope).toBe('workspace'))
    expect(mountProject).not.toHaveBeenCalled()
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
