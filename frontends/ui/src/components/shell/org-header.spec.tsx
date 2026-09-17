import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from 'react'
import { render, screen } from '@/test-utils'
import { vi, describe, test, expect, afterEach } from 'vitest'
import { OrgHeader } from './org-header'

let pathname = '/app/projects'
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

vi.mock('./sidebar-user-menu', () => ({
  SidebarUserMenu: () => <div data-testid="user-menu" />,
}))

// The badge subscription is the hook's own concern; here only the count's
// placement matters.
let pending = 0
vi.mock('@/features/collaboration/hooks/use-inbox', () => ({
  useInboxBadge: () => ({ pending }),
}))

const baseProps = {
  user: { name: 'Anna Berger', email: 'anna.berger@example.at' },
  organizationName: 'Musterarchitektur ZT GmbH',
  authRequired: false,
  canManageOrganization: false,
  canViewOrganization: false,
  canManagePlatform: false,
  canAccessArchiv: true,
  canAccessInbox: true,
}

afterEach(() => {
  pathname = '/app/projects'
  pending = 0
})

describe('OrgHeader — the org scope in one slim band', () => {
  test('carries the wordmark home link, both doorways, and the avatar menu', () => {
    render(<OrgHeader {...baseProps} />)
    expect(screen.getByText('Piloti').closest('a')).toHaveAttribute('href', '/app/projects')
    expect(screen.getByLabelText('Archiv')).toHaveAttribute('href', '/app/archiv')
    expect(screen.getByLabelText('Inbox')).toHaveAttribute('href', '/app/inbox')
    expect(screen.getByTestId('user-menu')).toBeInTheDocument()
  })

  test('drops each doorway with its own gate', () => {
    render(<OrgHeader {...baseProps} canAccessArchiv={false} canAccessInbox={false} />)
    expect(screen.queryByLabelText('Archiv')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Inbox')).not.toBeInTheDocument()
    // The avatar stays — the header is never just a wordmark.
    expect(screen.getByTestId('user-menu')).toBeInTheDocument()
  })

  test('marks the doorway whose sheet is open, and only that one', () => {
    pathname = '/app/archiv'
    render(<OrgHeader {...baseProps} />)
    expect(screen.getByLabelText('Archiv')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByLabelText('Inbox')).not.toHaveAttribute('aria-current')
  })

  test('surfaces the pending count on the inbox doorway', () => {
    pending = 3
    render(<OrgHeader {...baseProps} />)
    const inbox = screen.getByLabelText('Inbox')
    expect(inbox.textContent).toContain('3')
  })
})
