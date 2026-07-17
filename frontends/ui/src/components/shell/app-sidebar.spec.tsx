import type { ReactNode } from 'react'
import { render, screen } from '@/test-utils'
import { vi, describe, test, expect } from 'vitest'
import { AppSidebar } from './app-sidebar'

// Isolate the nav-filtering logic from routing and the shell's sibling widgets.
vi.mock('next/navigation', () => ({
  usePathname: () => '/app/projects/p1/chat',
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock('@/hooks/use-last-project-section', () => ({
  useRecordProjectSection: () => {},
  pruneProjectSections: () => {},
}))

vi.mock('./project-switcher', () => ({ ProjectSwitcher: () => <div /> }))
vi.mock('./sidebar-user-menu', () => ({ SidebarUserMenu: () => <div /> }))
vi.mock('./connection-presence-indicator', () => ({
  ConnectionPresenceIndicator: () => <div />,
}))
vi.mock('@/components/brand/logo', () => ({ Logo: () => <div /> }))

const baseProps = {
  projectId: 'p1',
  projects: [{ id: 'p1', name: 'Project One' }],
  authRequired: false,
}

describe('AppSidebar - click-dummy IA (FB-9/FB-10)', () => {
  test('renders the core nav set: Chat, Files, History', () => {
    render(<AppSidebar {...baseProps} />)
    expect(screen.getAllByText('Chat').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Files').length).toBeGreaterThan(0)
    expect(screen.getAllByText('History').length).toBeGreaterThan(0)
  })

  test('Overview, Members, Research and Knowledge no longer appear in the nav', () => {
    render(<AppSidebar {...baseProps} showWorkflows canAccessArchiv />)
    expect(screen.queryByText('Overview')).not.toBeInTheDocument()
    expect(screen.queryByText('Members')).not.toBeInTheDocument()
    expect(screen.queryByText('Research')).not.toBeInTheDocument()
    expect(screen.queryByText('Knowledge')).not.toBeInTheDocument()
  })

  test('renders a pinned Settings entry linking to the project settings page', () => {
    render(<AppSidebar {...baseProps} />)
    const links = screen.getAllByText('Settings').map((el) => el.closest('a'))
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/app/projects/p1/settings')
    }
  })

  test('History links into the project subtree', () => {
    render(<AppSidebar {...baseProps} />)
    const links = screen.getAllByText('History').map((el) => el.closest('a'))
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/app/projects/p1/history')
    }
  })
})

describe('AppSidebar - Workflows nav item', () => {
  test('shows the Workflows nav item when showWorkflows is true', () => {
    render(<AppSidebar {...baseProps} showWorkflows />)
    expect(screen.getAllByText('Workflows').length).toBeGreaterThan(0)
  })

  test('hides the Workflows nav item by default (feature-flagged, default off)', () => {
    render(<AppSidebar {...baseProps} />)
    expect(screen.queryByText('Workflows')).not.toBeInTheDocument()
    // Sibling items remain.
    expect(screen.getAllByText('Chat').length).toBeGreaterThan(0)
    expect(screen.getAllByText('History').length).toBeGreaterThan(0)
  })

  test('hides the Workflows nav item when showWorkflows is false', () => {
    render(<AppSidebar {...baseProps} showWorkflows={false} />)
    expect(screen.queryByText('Workflows')).not.toBeInTheDocument()
  })
})

describe('AppSidebar - Archiv nav item (ADR-0024)', () => {
  test('shows Archiv when canAccessArchiv is true, linking to the org Archiv', () => {
    render(<AppSidebar {...baseProps} canAccessArchiv />)
    const links = screen.getAllByText('Archiv').map((el) => el.closest('a'))
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/app/archiv')
    }
  })

  test('hides Archiv by default (org feature flag off)', () => {
    render(<AppSidebar {...baseProps} />)
    expect(screen.queryByText('Archiv')).not.toBeInTheDocument()
  })
})

describe('AppSidebar - active state', () => {
  test('marks the Chat item as the current page on the chat route', () => {
    render(<AppSidebar {...baseProps} />)
    const chatLinks = screen.getAllByText('Chat').map((el) => el.closest('a'))
    expect(chatLinks.some((link) => link?.getAttribute('aria-current') === 'page')).toBe(true)
    const settingsLinks = screen.getAllByText('Settings').map((el) => el.closest('a'))
    for (const link of settingsLinks) {
      expect(link).not.toHaveAttribute('aria-current')
    }
  })
})
