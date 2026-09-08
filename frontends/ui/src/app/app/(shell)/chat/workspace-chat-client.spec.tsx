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

import { useChatStore } from '@/features/chat'
import { WorkspaceChatClient } from './workspace-chat-client'

const flags = {
  showSourceBadges: true,
  showConfidenceChip: true,
  showAnswerFeedback: true,
  showResearchInHistory: true,
}

beforeEach(() => {
  useChatStore.setState({ projectId: 'proj-a', scope: 'project', conversations: [] })
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
