// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AppBar } from './AppBar'

// Mock the layout store
const mockToggleSessionsPanel = vi.fn()
const mockOpenRightPanel = vi.fn()
const mockCloseRightPanel = vi.fn()
const mockSetTheme = vi.fn()
const mockSignIn = vi.fn()
const mockSignOut = vi.fn()
const mockGetAccessToken = vi.fn()

const mockState = () => ({
  toggleSessionsPanel: mockToggleSessionsPanel,
  rightPanel: null as string | null,
  openRightPanel: mockOpenRightPanel,
  closeRightPanel: mockCloseRightPanel,
  theme: 'system',
  setTheme: mockSetTheme,
})

const expectElementBefore = (first: Element, second: Element) => {
  expect(Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
    true
  )
}

vi.mock('../store', () => ({
  useLayoutStore: Object.assign(
    vi.fn((selector?: (s: any) => any) => {
      const state = mockState()
      return selector ? selector(state) : state
    }),
    { getState: () => mockState() }
  ),
}))

vi.mock('@/adapters/auth', () => ({
  useAuth: vi.fn(() => ({
    isAuthenticated: false,
    authRequired: true,
    isLoading: false,
    user: null,
    accessToken: undefined,
    idToken: undefined,
    organizationId: undefined,
    error: undefined,
    signIn: mockSignIn,
    signOut: mockSignOut,
    getAccessToken: mockGetAccessToken,
  })),
}))

vi.mock('@/components/projects/project-selector', () => ({
  ProjectSelector: function ProjectSelector() {
    return null
  },
}))

import { useAuth } from '@/adapters/auth'

const setAuthState = (overrides: Partial<ReturnType<typeof useAuth>> = {}) => {
  vi.mocked(useAuth).mockReturnValue({
    isAuthenticated: false,
    authRequired: true,
    isLoading: false,
    user: null,
    accessToken: undefined,
    idToken: undefined,
    organizationId: undefined,
    error: undefined,
    signIn: mockSignIn,
    signOut: mockSignOut,
    getAccessToken: mockGetAccessToken,
    ...overrides,
  } as ReturnType<typeof useAuth>)
}

describe('AppBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setAuthState()
  })

  test('renders logo and title', () => {
    render(<AppBar />)

    expect(screen.getByText('Grid')).toBeInTheDocument()
  })

  test('renders sessions label beside the menu button', () => {
    setAuthState({ isAuthenticated: true, user: { id: 'u1', email: 'test@example.com' } })
    render(<AppBar />)

    expect(screen.getByText('Sessions')).toBeInTheDocument()
  })

  test('shows Sign In button when not authenticated', () => {
    setAuthState({ isAuthenticated: false, authRequired: true })
    render(<AppBar />)

    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
  })

  test('calls signIn when Sign In is clicked', async () => {
    const user = userEvent.setup()
    setAuthState({ isAuthenticated: false, authRequired: true })

    render(<AppBar />)

    await user.click(screen.getByRole('button', { name: /sign in/i }))

    expect(mockSignIn).toHaveBeenCalledOnce()
  })

  test('shows session title when authenticated', () => {
    setAuthState({ isAuthenticated: true, user: { id: 'u1', email: 'test@example.com' } })
    render(<AppBar sessionTitle="My Research Session" />)

    expect(screen.getByText('My Research Session')).toBeInTheDocument()
  })

  test('disables action buttons when not authenticated', () => {
    setAuthState({ isAuthenticated: false, authRequired: true })
    render(<AppBar />)

    expect(screen.getByRole('button', { name: /create new session/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /toggle sessions sidebar/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /add data sources/i })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /open documentation/i })).not.toBeInTheDocument()
  })

  test('enables action buttons when authenticated', () => {
    setAuthState({ isAuthenticated: true, user: { id: 'u1', email: 'test@example.com' } })
    render(<AppBar />)

    expect(screen.getByRole('button', { name: /create new session/i })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /toggle sessions sidebar/i })).not.toBeDisabled()
    expect(screen.getByRole('button', { name: /add data sources/i })).not.toBeDisabled()
    expect(screen.queryByRole('button', { name: /open documentation/i })).not.toBeInTheDocument()
  })

  test('calls onNewSession when logo button clicked', async () => {
    const user = userEvent.setup()
    const onNewSession = vi.fn()
    setAuthState({ isAuthenticated: true, user: { id: 'u1', email: 'test@example.com' } })

    render(<AppBar onNewSession={onNewSession} />)

    await user.click(screen.getByRole('button', { name: /create new session/i }))

    expect(onNewSession).toHaveBeenCalledOnce()
  })

  test('disables new session button when shallow navigation is blocked', () => {
    setAuthState({ isAuthenticated: true, user: { id: 'u1', email: 'test@example.com' } })
    render(<AppBar isNewSessionDisabled={true} />)

    expect(screen.getByRole('button', { name: /create new session/i })).toBeDisabled()
    // Other action buttons remain enabled.
    expect(screen.getByRole('button', { name: /toggle sessions sidebar/i })).not.toBeDisabled()
  })

  test('toggles sessions panel when menu button clicked', async () => {
    const user = userEvent.setup()
    setAuthState({ isAuthenticated: true, user: { id: 'u1', email: 'test@example.com' } })

    render(<AppBar />)

    await user.click(screen.getByRole('button', { name: /toggle sessions sidebar/i }))

    expect(mockToggleSessionsPanel).toHaveBeenCalledOnce()
  })

  test('opens data-sources panel when Add Sources clicked', async () => {
    const user = userEvent.setup()
    setAuthState({ isAuthenticated: true, user: { id: 'u1', email: 'test@example.com' } })

    render(<AppBar />)

    await user.click(screen.getByRole('button', { name: /add data sources/i }))

    expect(mockOpenRightPanel).toHaveBeenCalledWith('data-sources')
  })

  test('does not render Documentation in the top navigation', () => {
    render(<AppBar />)

    expect(screen.queryByRole('button', { name: /open documentation/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Documentation')).not.toBeInTheDocument()
  })

  test('shows user avatar when authenticated', () => {
    setAuthState({
      isAuthenticated: true,
      authRequired: true,
      user: { name: 'John Doe', email: 'john@example.com' },
    })
    render(<AppBar />)

    expect(screen.getByRole('button', { name: /user menu for john doe/i })).toBeInTheDocument()
  })

  test('shows Documentation section in authenticated user menu', async () => {
    const user = userEvent.setup()
    setAuthState({
      isAuthenticated: true,
      authRequired: true,
      user: { name: 'John Doe', email: 'john@example.com' },
    })

    render(<AppBar />)

    await user.click(screen.getByRole('button', { name: /user menu for john doe/i }))

    expect(screen.getByText('Appearance')).toBeInTheDocument()
    expect(screen.getByText('Documentation')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open documentation/i })).toBeInTheDocument()
  })

  test('shows organization id in authenticated user menu', async () => {
    const user = userEvent.setup()
    setAuthState({
      isAuthenticated: true,
      authRequired: true,
      user: { name: 'John Doe', email: 'john@example.com' },
      organizationId: 'org_123',
    })

    render(<AppBar />)

    await user.click(screen.getByRole('button', { name: /user menu for john doe/i }))

    expect(screen.getByText('Org: org_123')).toBeInTheDocument()
  })

  describe('auth disabled mode', () => {
    test('shows Default User avatar button when auth is disabled', () => {
      setAuthState({ isAuthenticated: true, authRequired: false })
      render(<AppBar />)

      // Should show avatar button with tooltip indicating auth is disabled
      const avatarButton = screen.getByRole('button', {
        name: /default user.*authentication not configured/i,
      })
      expect(avatarButton).toBeInTheDocument()
    })

    test('does not show Sign In button when auth is disabled', () => {
      setAuthState({ isAuthenticated: true, authRequired: false })
      render(<AppBar />)

      expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument()
    })

    test('shows auth disabled popover with info message before appearance and docs', async () => {
      const user = userEvent.setup()
      setAuthState({ isAuthenticated: true, authRequired: false })
      render(<AppBar />)

      const avatarButton = screen.getByRole('button', {
        name: /default user.*authentication not configured/i,
      })
      await user.click(avatarButton)

      // Popover should show "Default User", auth notice, theme control, and docs.
      expect(screen.getByText('Default User')).toBeInTheDocument()
      expect(screen.getByRole('radiogroup', { name: /theme/i })).toBeInTheDocument()
      const authNotice = screen.getByText('Authentication Not Configured')
      const appearanceSection = screen.getByText('Appearance')
      const docsSection = screen.getByText('Documentation')
      expect(authNotice).toBeInTheDocument()
      expect(docsSection).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /Open documentation/i })).toBeInTheDocument()
      expectElementBefore(authNotice, appearanceSection)
      expectElementBefore(appearanceSection, docsSection)
    })

    test('uses the KUI popover with the app background surface for user settings', async () => {
      const user = userEvent.setup()
      setAuthState({ isAuthenticated: true, authRequired: false })
      render(<AppBar />)

      await user.click(screen.getByRole('button', {
        name: /default user.*authentication not configured/i,
      }))

      const popoverContent = screen.getByTestId('nv-popover-content')
      expect(popoverContent).toHaveClass('nv-popover-content')
      expect(popoverContent).toHaveClass('bg-surface-base')
      expect(popoverContent).not.toHaveClass('!bg-transparent')
      expect(popoverContent).not.toHaveClass('!shadow-none')
      expect(popoverContent).not.toHaveStyle({ backgroundColor: 'transparent' })
    })

    test('does not show Sign Out button when auth is disabled', async () => {
      const user = userEvent.setup()
      setAuthState({ isAuthenticated: true, authRequired: false })
      render(<AppBar />)

      const avatarButton = screen.getByRole('button', {
        name: /default user.*authentication not configured/i,
      })
      await user.click(avatarButton)

      // Should not have a sign out button
      expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument()
    })

    test('action buttons are enabled when auth is disabled (user is authenticated)', () => {
      setAuthState({ isAuthenticated: true, authRequired: false })
      render(<AppBar />)

      expect(screen.getByRole('button', { name: /create new session/i })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: /toggle sessions sidebar/i })).not.toBeDisabled()
      expect(screen.getByRole('button', { name: /add data sources/i })).not.toBeDisabled()
      expect(screen.queryByRole('button', { name: /open documentation/i })).not.toBeInTheDocument()
    })

    test('shows session title when auth is disabled', () => {
      setAuthState({ isAuthenticated: true, authRequired: false })
      render(<AppBar sessionTitle="My Research Session" />)

      expect(screen.getByText('My Research Session')).toBeInTheDocument()
    })
  })
})
