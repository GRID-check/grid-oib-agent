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

describe('AppSidebar - Research nav item (FB-10)', () => {
  test('shows the Research nav item when showResearch is true (legacy tab)', () => {
    render(<AppSidebar {...baseProps} showResearch />)
    // Desktop + mobile both render the label; at least one is present.
    expect(screen.getAllByText('Research').length).toBeGreaterThan(0)
  })

  test('defaults to showing Research when the prop is omitted (back-compat)', () => {
    render(<AppSidebar {...baseProps} />)
    expect(screen.getAllByText('Research').length).toBeGreaterThan(0)
  })

  test('hides the Research nav item when showResearch is false (folded into chat)', () => {
    render(<AppSidebar {...baseProps} showResearch={false} />)
    expect(screen.queryByText('Research')).not.toBeInTheDocument()
    // Sibling items remain.
    expect(screen.getAllByText('Chat').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Files').length).toBeGreaterThan(0)
  })
})
