import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { render, screen, act } from '@/test-utils'
import { vi, describe, test, expect, afterEach } from 'vitest'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useLayoutStore } from '@/features/layout/store'
import { AppSidebar } from './app-sidebar'

// Isolate the nav-filtering logic from routing and the shell's sibling widgets.
vi.mock('next/navigation', () => ({
  usePathname: () => '/app/projects/p1/chat',
}))

vi.mock('next/link', () => ({
  default: forwardRef<
    HTMLAnchorElement,
    { href: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>
  >(function MockLink({ href, children, ...rest }, ref) {
    return (
      <a ref={ref} href={href} {...rest}>
        {children}
      </a>
    )
  }),
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

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: vi.fn(() => false),
}))

const baseProps = {
  projectId: 'p1',
  projects: [{ id: 'p1', name: 'Project One' }],
  authRequired: false,
  // Explicit, and `true`, because these tests are about the nav a real user sees.
  // This prop used to default to `false` and this fixture omitted it, so every
  // test below silently asserted the rail with the Inbox entry HIDDEN — the state
  // no signed-in member of an org is in.
  canAccessInbox: true,
}

afterEach(() => {
  vi.mocked(useIsMobile).mockReturnValue(false)
  useLayoutStore.setState({ isMobileNavOpen: false })
})

describe('the Inbox entry follows canAccessInbox, in both directions', () => {
  // Both states, because the prop was optional and defaulting to `false` meant
  // the disabled state was the only one this file ever covered.
  test('shows the entry when the reader may reach the inbox', () => {
    render(<AppSidebar {...baseProps} canAccessInbox />)
    expect(screen.getAllByText('Inbox').length).toBeGreaterThan(0)
  })

  test('hides it when they may not', () => {
    render(<AppSidebar {...baseProps} canAccessInbox={false} />)
    expect(screen.queryByText('Inbox')).not.toBeInTheDocument()
  })
})

describe('AppSidebar - click-dummy IA (FB-9/FB-10)', () => {
  test('renders the core nav set: Ask Piloti, Files, History', () => {
    render(<AppSidebar {...baseProps} />)
    expect(screen.getAllByText('Ask Piloti').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Files').length).toBeGreaterThan(0)
    expect(screen.getAllByText('History').length).toBeGreaterThan(0)
  })

  test('Overview, Members, Research and Knowledge no longer appear in the nav', () => {
    render(<AppSidebar {...baseProps} canAccessArchiv />)
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

  test('Ask Piloti links to a FRESH chat (?new=1), not the last thread', () => {
    render(<AppSidebar {...baseProps} />)
    // Filter to actual nav links — on the chat route the mobile top bar also
    // renders "Ask Piloti" as a plain active-section label (not an anchor).
    const links = screen
      .getAllByText('Ask Piloti')
      .map((el) => el.closest('a'))
      .filter((link): link is HTMLAnchorElement => link !== null)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/app/projects/p1/chat?new=1')
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

describe('AppSidebar - Skills nav item', () => {
  test('hides the Skills nav item by default (feature-flagged, default off)', () => {
    render(<AppSidebar {...baseProps} />)
    expect(screen.queryByText('Skills')).not.toBeInTheDocument()
    // Sibling items remain.
    expect(screen.getAllByText('Ask Piloti').length).toBeGreaterThan(0)
    expect(screen.getAllByText('History').length).toBeGreaterThan(0)
  })

  test('shows the Skills nav item when showSkills is true', () => {
    render(<AppSidebar {...baseProps} showSkills />)
    expect(screen.getAllByText('Skills').length).toBeGreaterThan(0)
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

  test('orders Ask Piloti first and Inbox last in the section nav', () => {
    const { container } = render(<AppSidebar {...baseProps} canAccessArchiv />)
    // Scope to the rail's section nav so the wordmark / Settings footer stay out.
    const nav = container.querySelector('[data-sidebar="content"] nav')
    expect(nav).not.toBeNull()
    const labels = Array.from(nav!.querySelectorAll('a span')).map((el) => el.textContent)
    // Ask Piloti · Files · History · Jobs* · Skills* · Archiv* · Inbox*,
    // per `project-sections.ts`. Skills and Jobs are absent here because
    // `showSkills` is off.
    expect(labels).toEqual(['Ask Piloti', 'Files', 'History', 'Archiv', 'Inbox'])
  })
})

describe('AppSidebar - mobile top bar', () => {
  test('hides the standalone mobile top bar on the chat route (chat owns its chrome)', () => {
    // The mocked pathname is the chat route, so the banner must carry `hidden`
    // — the chat's floating toolbar hosts the nav opener there instead.
    render(<AppSidebar {...baseProps} />)
    const banner = screen.getByRole('banner')
    expect(banner.className).toContain('hidden')
    expect(banner.className).not.toMatch(/(^|\s)flex(\s|$)/)
  })
})

describe('AppSidebar - active state', () => {
  test('marks the Chat item as the current page on the chat route', () => {
    render(<AppSidebar {...baseProps} />)
    const chatLinks = screen.getAllByText('Ask Piloti').map((el) => el.closest('a'))
    expect(chatLinks.some((link) => link?.getAttribute('aria-current') === 'page')).toBe(true)
    const settingsLinks = screen.getAllByText('Settings').map((el) => el.closest('a'))
    for (const link of settingsLinks) {
      expect(link).not.toHaveAttribute('aria-current')
    }
  })
})

describe('AppSidebar - layout store mobile nav sync', () => {
  test('opens the primitive sheet when the chat toolbar sets the store', async () => {
    vi.mocked(useIsMobile).mockReturnValue(true)
    render(<AppSidebar {...baseProps} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await act(async () => {
      useLayoutStore.getState().setMobileNavOpen(true)
    })

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getAllByText('Ask Piloti').length).toBeGreaterThan(0)
  })
})
