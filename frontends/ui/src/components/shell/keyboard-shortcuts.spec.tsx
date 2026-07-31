import { render, screen, waitFor } from '@/test-utils'
import { fireEvent } from '@testing-library/react'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { KeyboardShortcuts } from './keyboard-shortcuts'
import { projectIdFromPathname } from './command-palette'
import { SHORTCUTS_PREFERENCE_KEY } from '@/hooks/use-shortcuts-preference'

const push = vi.fn()
let pathname = '/app/projects'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname,
}))

const signOut = vi.fn()
vi.mock('@/adapters/auth/use-auth', () => ({
  useAuth: () => ({ signOut }),
}))

const projects = [
  { id: 'p1', name: 'Alpine Tower' },
  { id: 'p2', name: 'Donau Loft' },
]

// cmdk scrolls the selected item into view; happy-dom may not implement it.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

const pressCmdK = () => fireEvent.keyDown(window, { key: 'k', metaKey: true })

describe('KeyboardShortcuts', () => {
  beforeEach(() => {
    push.mockClear()
    window.localStorage.removeItem(SHORTCUTS_PREFERENCE_KEY)
    pathname = '/app/projects'
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => projects }),
    )
  })

  test('⌘K opens the palette with project + general groups', async () => {
    render(<KeyboardShortcuts authRequired canViewOrganization />)

    pressCmdK()

    expect(await screen.findByPlaceholderText('Type a command or search…')).toBeInTheDocument()
    // Projects arrive from the existing GET /api/projects endpoint.
    expect(await screen.findByText('Alpine Tower')).toBeInTheDocument()
    expect(screen.getByText('Donau Loft')).toBeInTheDocument()
    expect(screen.getByText('Projects')).toBeInTheDocument()
    expect(screen.getByText('General')).toBeInTheDocument()
    // Global actions, navigation-only.
    expect(screen.getByText('New project')).toBeInTheDocument()
    expect(screen.getByText('Organization')).toBeInTheDocument()
    expect(screen.getByText('Profile')).toBeInTheDocument()
    expect(screen.getByText('Toggle theme')).toBeInTheDocument()
    expect(screen.getByText('Sign out')).toBeInTheDocument()
    // Outside a project there is no current-project section group.
    expect(screen.queryByText('Current project')).toBeNull()
  })

  test('inside a project the palette lists the section commands', async () => {
    pathname = '/app/projects/p1/chat'
    render(<KeyboardShortcuts authRequired canViewOrganization />)

    pressCmdK()

    expect(await screen.findByText('Current project')).toBeInTheDocument()
    // Click-dummy IA (spec §5): Chat/Files/History/Settings + Setup (intake).
    for (const section of ['Ask Piloti', 'Files', 'History', 'Settings', 'Setup']) {
      expect(screen.getByText(section)).toBeInTheDocument()
    }
    // Overview/Members/Research left the IA (FB-9/FB-10).
    expect(screen.queryByText('Overview')).toBeNull()
    expect(screen.queryByText('Members')).toBeNull()
    expect(screen.queryByText('Research')).toBeNull()
  })

  test('org and sign-out entries follow their capability props', async () => {
    render(<KeyboardShortcuts authRequired={false} canViewOrganization={false} />)

    pressCmdK()

    expect(await screen.findByText('New project')).toBeInTheDocument()
    expect(screen.queryByText('Organization')).toBeNull()
    expect(screen.queryByText('Sign out')).toBeNull()
  })

  test('? opens the shortcuts cheatsheet', async () => {
    render(<KeyboardShortcuts authRequired canViewOrganization />)

    fireEvent.keyDown(window, { key: '?', shiftKey: true })

    expect(await screen.findByText('Keyboard shortcuts')).toBeInTheDocument()
    // Grouped: what the shell binds, where you can jump, what the chat does.
    for (const group of ['General', 'Jump to', 'Chat']) {
      expect(screen.getByText(group)).toBeInTheDocument()
    }
    expect(screen.getByText('Open the command palette')).toBeInTheDocument()
    expect(screen.getByText('Close a dialog or menu')).toBeInTheDocument()
    // Composer rows document the send / newline bindings.
    expect(screen.getByText('Send message')).toBeInTheDocument()
    expect(screen.getByText('New line')).toBeInTheDocument()
    expect(screen.getByText('Pick a numbered option')).toBeInTheDocument()
  })

  test('the cheatsheet documents every jump the handler actually binds', async () => {
    render(<KeyboardShortcuts authRequired canViewOrganization canAccessArchiv />)

    fireEvent.keyDown(window, { key: '?', shiftKey: true })

    await screen.findByText('Keyboard shortcuts')
    // Rows are derived from the shared IA, so they carry the rail's own labels.
    for (const label of ['All projects', 'Organization', 'Ask Piloti', 'Files', 'History', 'Archiv', 'Settings']) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
    // Flag-gated sections stay out until their flag is on.
    expect(screen.queryByText('Workflows')).toBeNull()
    expect(screen.queryByText('Knowledge')).toBeNull()
    // The keycaps show the leader sequence, not a bare letter.
    const filesRow = document.querySelector('[data-shortcut="jump-f"]')
    expect(filesRow?.textContent).toContain('G')
    expect(filesRow?.textContent).toContain('then')
    expect(filesRow?.textContent).toContain('F')
  })

  test('a gated-off shortcut group row disappears with its feature', async () => {
    render(<KeyboardShortcuts authRequired canViewOrganization />)

    fireEvent.keyDown(window, { key: '?', shiftKey: true })

    await screen.findByText('Keyboard shortcuts')
    // Mentions only exist where collaboration is on.
    expect(screen.queryByText('Mention a colleague')).toBeNull()
  })

  test('g then p navigates to the projects list', async () => {
    render(<KeyboardShortcuts authRequired canViewOrganization />)

    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 'p' })

    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/projects'))
  })

  test('g then a section key jumps within the project the user is in', async () => {
    pathname = '/app/projects/p1/chat'
    render(<KeyboardShortcuts authRequired canViewOrganization />)

    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 'f' })

    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/projects/p1/files'))
  })

  test('a project-scoped jump outside a project does nothing', () => {
    pathname = '/app/profile'
    render(<KeyboardShortcuts authRequired canViewOrganization />)

    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 'f' })

    expect(push).not.toHaveBeenCalled()
  })

  test('cross-project doorways jump from anywhere, and stay gated', async () => {
    pathname = '/app/profile'
    const { unmount } = render(<KeyboardShortcuts authRequired canViewOrganization canAccessArchiv />)

    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 'a' })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/app/archiv'))

    unmount()
    push.mockClear()
    render(<KeyboardShortcuts authRequired canViewOrganization />)

    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(push).not.toHaveBeenCalled()
  })

  test('an unbound second key disarms the leader instead of navigating', () => {
    render(<KeyboardShortcuts authRequired canViewOrganization />)

    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 'z' })
    expect(push).not.toHaveBeenCalled()

    // The leader is spent: a following `p` is a fresh key, not a completion.
    fireEvent.keyDown(window, { key: 'p' })
    expect(push).not.toHaveBeenCalled()
  })

  test('plain-key shortcuts do not fire while typing in an input', async () => {
    render(
      <>
        <input aria-label="Field" />
        <KeyboardShortcuts authRequired canViewOrganization />
      </>,
    )

    const input = screen.getByLabelText('Field')
    input.focus()
    fireEvent.keyDown(input, { key: '?', shiftKey: true })
    fireEvent.keyDown(input, { key: 'g' })
    fireEvent.keyDown(input, { key: 'p' })

    expect(screen.queryByText('Keyboard shortcuts')).toBeNull()
    expect(push).not.toHaveBeenCalled()
  })

  test('user toggle off: everything is inert — no dialogs, no keydown listeners', () => {
    window.localStorage.setItem(SHORTCUTS_PREFERENCE_KEY, 'false')
    const addListener = vi.spyOn(window, 'addEventListener')

    const { container } = render(<KeyboardShortcuts authRequired canViewOrganization />)

    // Zero global keydown listeners registered while gated off.
    expect(addListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0)
    expect(container).toBeEmptyDOMElement()

    pressCmdK()
    fireEvent.keyDown(window, { key: '?', shiftKey: true })
    fireEvent.keyDown(window, { key: 'g' })
    fireEvent.keyDown(window, { key: 'p' })

    expect(screen.queryByPlaceholderText('Type a command or search…')).toBeNull()
    expect(screen.queryByText('Keyboard shortcuts')).toBeNull()
    expect(push).not.toHaveBeenCalled()

    addListener.mockRestore()
  })

  test('keydown listener is removed on unmount', () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')

    const { unmount } = render(<KeyboardShortcuts authRequired canViewOrganization />)
    const added = addListener.mock.calls.filter(([type]) => type === 'keydown')
    expect(added).toHaveLength(1)

    unmount()
    const removed = removeListener.mock.calls.filter(([type]) => type === 'keydown')
    expect(removed.map(([, handler]) => handler)).toContain(added[0][1])

    addListener.mockRestore()
    removeListener.mockRestore()
  })
})

describe('projectIdFromPathname', () => {
  test('extracts the id from project routes', () => {
    expect(projectIdFromPathname('/app/projects/p1')).toBe('p1')
    expect(projectIdFromPathname('/app/projects/p1/files')).toBe('p1')
  })

  test('returns null outside a project', () => {
    expect(projectIdFromPathname('/app/projects')).toBeNull()
    expect(projectIdFromPathname('/app/profile')).toBeNull()
    expect(projectIdFromPathname('')).toBeNull()
  })
})
