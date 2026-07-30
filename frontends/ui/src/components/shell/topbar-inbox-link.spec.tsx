/**
 * The inbox entry above a project (ADR-0035).
 *
 * `AppSidebar` was the ONLY thing in the product that rendered an inbox entry, and it
 * mounts only inside `app/projects/[id]/layout.tsx`. So on the projects home, the
 * profile page, the archive — or the inbox page itself — being tagged had no
 * observable effect at all. For somebody who opens the product once a month, which is
 * most of the people a mention is aimed at, a request for their input was invisible.
 *
 * These assert reachability and the count, which is what makes the entry worth having.
 */
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen } from '@/test-utils'

import { TopbarInboxLink } from './topbar-inbox-link'

let mockPending = 0
let mockPathname = '/app/projects'

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}))

vi.mock('@/features/collaboration/hooks/use-inbox', () => ({
  useInboxBadge: vi.fn((enabled: boolean) => ({ pending: enabled ? mockPending : 0 })),
}))

beforeEach(() => {
  mockPending = 0
  mockPathname = '/app/projects'
})

describe('TopbarInboxLink', () => {
  test('renders nothing without the collaboration flag — the frame stays exactly today’s (NF-8)', () => {
    const { container } = render(<TopbarInboxLink />)
    expect(container).toBeEmptyDOMElement()
  })

  test('links to the inbox with its label', () => {
    render(<TopbarInboxLink canCollaborate />)

    const link = screen.getByTestId('topbar-inbox-link')
    expect(link).toHaveAttribute('href', '/app/inbox')
    expect(link).toHaveTextContent('Inbox')
  })

  test('carries the "needs you" count — a link with no badge still hides the signal', () => {
    mockPending = 3
    render(<TopbarInboxLink canCollaborate />)

    expect(screen.getByTestId('topbar-inbox-link')).toHaveTextContent('3')
  })

  test('shows no count when nothing needs the reader', () => {
    render(<TopbarInboxLink canCollaborate />)
    expect(screen.getByTestId('topbar-inbox-link')).not.toHaveTextContent('0')
  })

  test('marks itself current on the inbox page', () => {
    mockPathname = '/app/inbox'
    render(<TopbarInboxLink canCollaborate />)

    expect(screen.getByTestId('topbar-inbox-link')).toHaveAttribute('aria-current', 'page')
  })

  test('is not current elsewhere', () => {
    render(<TopbarInboxLink canCollaborate />)
    expect(screen.getByTestId('topbar-inbox-link')).not.toHaveAttribute('aria-current')
  })
})
