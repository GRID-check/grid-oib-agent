import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { render, screen, act, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, afterEach } from 'vitest'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useLayoutStore } from '@/features/layout/store'
import { I18nProvider } from '@/i18n'
import { AppSidebar, railActivePillId } from './app-sidebar'

// Isolate the nav-filtering logic from routing and the shell's sibling widgets.
// The pathname is mutable because the rail now reads its own scope from it —
// project scope inside `/app/projects/<id>/…`, org scope everywhere above.
let pathname = '/app/projects/p1/chat'
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
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
  // Explicit, like `canAccessInbox` below and for the same reason: a defaulted
  // scope would let a caller render the wrong rail and never find out.
  scope: 'project' as const,
  projectId: 'p1',
  projects: [{ id: 'p1', name: 'Project One' }],
  authRequired: false,
  // Explicit, and `true`, because these tests are about the nav a real user sees.
  // This prop used to default to `false` and this fixture omitted it, so every
  // test below silently asserted the rail with the Inbox entry HIDDEN — the state
  // no signed-in member of an org is in.
  canAccessInbox: true,
}

const orgProps = {
  ...baseProps,
  scope: 'org' as const,
  projectId: null,
}

afterEach(() => {
  pathname = '/app/projects/p1/chat'
  // The primitive persists collapse in localStorage, so a test that collapses
  // the rail used to hand the icon rail to every test that ran after it.
  window.localStorage.removeItem('grid.sidebar.collapsed')
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
    const labels = Array.from(nav!.querySelectorAll('a span[data-slot="rail-nav-label"]')).map((el) => el.textContent)
    // Ask Piloti · Files · History · Jobs* · Skills* · Archiv* · Inbox*,
    // per `project-sections.ts`. Skills and Jobs are absent here because
    // `showSkills` is off.
    expect(labels).toEqual(['Ask Piloti', 'Files', 'History', 'Archiv', 'Inbox'])
  })
})

describe('AppSidebar - collapsed icon rail', () => {
  test('keeps nav labels in the a11y tree but does not paint them', async () => {
    const user = userEvent.setup()
    render(<AppSidebar {...baseProps} />)

    const sections = screen.getByLabelText('Project sections')
    expect(within(sections).getByText('Ask Piloti')).toBeVisible()
    expect(within(sections).getByText('Work')).toBeVisible()

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))

    // Named for AT (sr-only), not painted in the 64px rail. Happy-dom treats
    // sr-only as visible, so we assert the class rather than toBeVisible.
    expect(within(sections).getByText('Ask Piloti')).toHaveClass('sr-only')
    expect(within(sections).getByText('Files')).toHaveClass('sr-only')
    expect(within(sections).queryByText('Work')).not.toBeInTheDocument()
  })
})

describe('AppSidebar - the resize edge', () => {
  // The primitive ships English strings of its own; the rail is a tab stop now,
  // so the one control a keyboard user lands on must be named from the
  // dictionary like the rest of the nav. This is the JOIN — the primitive's
  // props and the dictionary keys are each correct on their own, and neither
  // side notices when nobody passes them.
  //
  // Asserted in GERMAN on purpose: in English the dictionary's strings and the
  // primitive's own defaults are the same words, so an English assertion passes
  // just as happily with the props removed. It was written that way first, and
  // that version survived deleting the very wiring it was written to pin.
  const renderGerman = (): void => {
    render(
      <I18nProvider initialLocale="de" fixedLocale>
        <AppSidebar {...baseProps} />
      </I18nProvider>
    )
  }

  test('names the edge from the dictionary, in both of its states', async () => {
    const user = userEvent.setup()
    renderGerman()

    const edge = screen.getByRole('separator', { name: 'Breite der Seitenleiste ändern' })
    expect(edge).toHaveAttribute('title', 'Ziehen zum Ändern der Breite, klicken zum Einklappen')

    await user.click(screen.getByRole('button', { name: 'Seitenleiste einklappen' }))

    // From the icon column there is no width to change yet, only a rail to
    // bring back — so the hint follows the state the rail is in.
    expect(screen.getByRole('separator', { name: 'Breite der Seitenleiste ändern' })).toHaveAttribute(
      'title',
      'Ziehen oder klicken zum Ausklappen'
    )
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

  test('draws the shared-layout pill on the active entry, and nowhere else', () => {
    // The pill is what the active state IS now — the button no longer carries
    // `bg-card`/`border`, so "exactly one pill, inside the current link" is the
    // assertion that the active surface still exists at all.
    const { container } = render(<AppSidebar {...baseProps} />)
    const pills = Array.from(container.querySelectorAll('[data-slot="rail-active-pill"]'))
    expect(pills).toHaveLength(1)
    expect(pills[0]!.closest('a')).toHaveAttribute('aria-current', 'page')
    expect(pills[0]!.closest('a')).toHaveTextContent('Ask Piloti')
  })

  test('keys the pill identity by scope AND by rail width, so it never flies across either', () => {
    // `layoutId` is motion state, not a DOM attribute, so the animation itself
    // is not observable from a jsdom render — but the KEY is, and the key is
    // the whole design decision. Two entries sharing it glide between each
    // other; two entries differing in it do not. Both axes must therefore
    // separate, or a pill would animate from "Dateien" to "Organisation"
    // (different lists) or scale a 212px chip into a 36px one (different rail).
    const ids = [
      railActivePillId('project', false),
      railActivePillId('project', true),
      railActivePillId('org', false),
      railActivePillId('org', true),
    ]
    expect(new Set(ids).size).toBe(4)
    // Entries WITHIN one rail must share it — that is what makes the glide a
    // glide rather than four independent chips.
    expect(railActivePillId('project', false)).toBe(railActivePillId('project', false))
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

/**
 * Org scope. The rail is mounted once, in the shared layout, and swaps its
 * CONTENTS — so what these assert is not "a second sidebar exists" but that the
 * one sidebar stops claiming a project the reader is no longer in.
 */
describe('AppSidebar - org scope', () => {
  test('unmounts the project switcher and the pinned project Settings row', () => {
    pathname = '/app/inbox'
    render(<AppSidebar {...orgProps} canAccessArchiv />)

    // The switcher is mocked to a bare <div>, so the claim it makes is asserted
    // through the pinned Settings row, which is the rail's own markup: in org
    // scope there is no project whose settings it could open.
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
    // …and none of the project's sections are offered either.
    expect(screen.queryByText('Files')).not.toBeInTheDocument()
    expect(screen.queryByText('Ask Piloti')).not.toBeInTheDocument()
  })

  test('offers the org destinations, gated exactly as the flags say', () => {
    pathname = '/app/inbox'
    const { container } = render(
      <AppSidebar {...orgProps} canAccessArchiv canManagePlatform canViewOrganization />
    )
    const nav = container.querySelector('[data-sidebar="content"] nav')
    const labels = Array.from(nav!.querySelectorAll('a span[data-slot="rail-nav-label"]')).map((el) => el.textContent)
    expect(labels).toEqual(['Projects', 'Archiv', 'Inbox', 'Organization', 'Platform', 'Profile'])
  })

  test('drops the entries the reader has no capability for', () => {
    pathname = '/app/profile'
    const { container } = render(
      <AppSidebar
        {...orgProps}
        canAccessArchiv={false}
        canAccessInbox={false}
        canManagePlatform={false}
        canViewOrganization={false}
        canManageOrganization={false}
      />
    )
    const nav = container.querySelector('[data-sidebar="content"] nav')
    const labels = Array.from(nav!.querySelectorAll('a span[data-slot="rail-nav-label"]')).map((el) => el.textContent)
    expect(labels).toEqual(['Projects', 'Profile'])
  })

  test('marks the destination the reader is on, and only that one', () => {
    pathname = '/app/organization/models'
    render(<AppSidebar {...orgProps} canViewOrganization />)
    const current = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.getAttribute('href'))
    expect(current).toEqual(['/app/organization'])
  })

  test('never lights up the projects entry from inside a project', () => {
    // `/app/projects` is a PREFIX of every project URL, so a naive
    // `startsWith` would mark the listing active while the reader is deep
    // inside a project — in the one scope where that entry is not even shown.
    pathname = '/app/archiv'
    render(<AppSidebar {...orgProps} canAccessArchiv />)
    const archiv = screen
      .getAllByText('Archiv')
      .map((el) => el.closest('a'))
      .filter((link): link is HTMLAnchorElement => link !== null)
    expect(archiv.some((link) => link.getAttribute('aria-current') === 'page')).toBe(true)
    const projects = screen
      .getAllByText('Projects')
      .map((el) => el.closest('a'))
      .filter((link): link is HTMLAnchorElement => link !== null)
    expect(projects.every((link) => !link.hasAttribute('aria-current'))).toBe(true)
  })

  test('leads with a back control everywhere except the projects listing itself', () => {
    pathname = '/app/inbox'
    const { unmount } = render(<AppSidebar {...orgProps} />)
    expect(screen.getByTestId('back-link')).toBeInTheDocument()
    unmount()

    // The listing IS the fallback every back control points at; a control there
    // would link to the page it is on.
    pathname = '/app/projects'
    render(<AppSidebar {...orgProps} />)
    expect(screen.queryByTestId('back-link')).not.toBeInTheDocument()
  })

  test('keeps the rail geometry identical across scopes', () => {
    pathname = '/app/inbox'
    const { container: org, unmount } = render(<AppSidebar {...orgProps} />)
    const orgHeader = org.querySelector('[data-sidebar="header"]')!.className
    const orgFooter = org.querySelector('[data-sidebar="footer"]')!.className
    unmount()

    pathname = '/app/projects/p1/chat'
    const { container: project } = render(<AppSidebar {...baseProps} />)
    // Same padding, same shrink behaviour, same box — only the contents differ.
    // This is the whole reason the rail moved into the shared layout.
    expect(org).not.toBe(project)
    expect(project.querySelector('[data-sidebar="header"]')!.className).toBe(orgHeader)
    expect(project.querySelector('[data-sidebar="footer"]')!.className).toBe(orgFooter)
  })

  test('tints the rail so the scope is visible without anything moving', () => {
    pathname = '/app/inbox'
    const { container } = render(<AppSidebar {...orgProps} />)
    const rail = container.querySelector('[data-slot="sidebar-container"]')!
    expect(rail.className).toContain('--color-sidebar:var(--background-color-interaction-base)')
  })
})
