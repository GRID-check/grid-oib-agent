import { render, screen } from '@/test-utils'
import { vi, describe, test, expect, afterEach } from 'vitest'
import { AppShellChrome } from './app-shell-chrome'

// The chrome DECIDES which shape stands; the shapes themselves are covered by
// their own specs. Stubs keep the decision observable without mounting a rail.
let pathname = '/app/projects/p1/chat'
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}))
vi.mock('./app-sidebar', () => ({
  AppSidebar: ({ projectId }: { projectId: string }) => (
    <div data-testid="rail" data-project-id={projectId} />
  ),
}))
vi.mock('./org-header', () => ({
  OrgHeader: () => <div data-testid="org-header" />,
}))

const baseProps = {
  projects: [],
  authRequired: false,
  canManageOrganization: false,
  canViewOrganization: false,
  canManagePlatform: false,
  canAccessArchiv: true,
  canAccessInbox: true,
  showSkills: false,
  showModels: false,
  overlay: null,
}

afterEach(() => {
  pathname = '/app/projects/p1/chat'
})

describe('AppShellChrome — which chrome stands', () => {
  test('inside a project: the rail, with that project id', () => {
    render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('rail')).toHaveAttribute('data-project-id', 'p1')
    expect(screen.queryByTestId('org-header')).not.toBeInTheDocument()
  })

  test('above a project: the org header, full stop', () => {
    pathname = '/app/projects'
    render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('org-header')).toBeInTheDocument()
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument()
  })
})

describe('AppShellChrome — overlay routes keep the chrome of the covered page', () => {
  test('opening the Archiv over a project keeps the project rail standing', () => {
    // An intercepted navigation changes the URL to /app/archiv while the
    // segment below keeps rendering the project page. Flipping the rail into
    // the org header UNDER the sheet is the reflow this logic exists to
    // prevent.
    const { rerender } = render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    pathname = '/app/archiv'
    rerender(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('rail')).toHaveAttribute('data-project-id', 'p1')
    expect(screen.queryByTestId('org-header')).not.toBeInTheDocument()
  })

  test('opening the Postfach over the org home keeps the org header standing', () => {
    pathname = '/app/projects'
    const { rerender } = render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    pathname = '/app/inbox'
    rerender(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('org-header')).toBeInTheDocument()
  })

  test('a hard load of an overlay URL has no covered page — org header stands', () => {
    pathname = '/app/archiv'
    render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('org-header')).toBeInTheDocument()
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument()
  })

  test('navigating on from an overlay releases the remembered scope', () => {
    const { rerender } = render(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    pathname = '/app/archiv'
    rerender(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    pathname = '/app/projects'
    rerender(<AppShellChrome {...baseProps}>page</AppShellChrome>)
    expect(screen.getByTestId('org-header')).toBeInTheDocument()
    expect(screen.queryByTestId('rail')).not.toBeInTheDocument()
  })
})
