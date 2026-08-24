import type { ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test-utils'

import type { InboxItemView } from '@/lib/inbox/types'

// The data hooks are already built and tested; this spec is about the four states
// the list can be in and the controls around them, so the hook is stubbed.
vi.mock('../hooks/use-inbox', () => ({
  useInboxList: vi.fn(),
  useInboxBadge: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

import { useInboxList, type UseInboxListResult } from '../hooks/use-inbox'
import { InboxList } from './InboxList'

const useInboxListMock = vi.mocked(useInboxList)

const refresh = vi.fn()
const markRead = vi.fn(async () => {})
const markAllRead = vi.fn(async () => {})
const archive = vi.fn(async () => {})
const dismissMutationError = vi.fn()

function result(overrides: Partial<UseInboxListResult> = {}): UseInboxListResult {
  return {
    items: [],
    pending: 0,
    loading: false,
    error: false,
    mutationError: false,
    dismissMutationError,
    mutating: false,
    connected: true,
    refresh,
    markRead,
    markAllRead,
    archive,
    ...overrides,
  }
}

const ITEM: InboxItemView = {
  id: 'i1',
  type: 'mention.requested',
  state: 'unread',
  actionable: true,
  resourceType: 'conversation',
  resourceId: 'c1',
  anchorId: null,
  actorName: 'Anna Weber',
  actorUserId: 'u-anna',
  count: 1,
  href: '/app/projects/p1/chat?session=c1',
  subject: 'Atrium',
  excerpt: null,
  createdAt: '2026-07-29T09:00:00Z',
  updatedAt: '2026-07-29T09:00:00Z',
}

/** Default locale in an unprovided test tree is `en`. */
describe('InboxList — filters', () => {
  beforeEach(() => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
  })

  test('defaults to "needs me", which asks the hook for pending items only', () => {
    render(<InboxList />)
    expect(useInboxListMock).toHaveBeenCalledWith(true, true)
    const needsMe = screen.getByRole('radio', { name: /Needs me/ })
    const all = screen.getByRole('radio', { name: 'All' })
    expect(needsMe).toHaveAttribute('data-state', 'on')
    expect(needsMe).toHaveAttribute('aria-checked', 'true')
    expect(all).toHaveAttribute('data-state', 'off')
    expect(all).toHaveAttribute('aria-checked', 'false')
  })

  test('the toggles are a labelled radiogroup, not two loose buttons', () => {
    render(<InboxList />)
    expect(screen.getByRole('radiogroup', { name: 'Filter inbox' })).toBeInTheDocument()
  })

  test('switching to "all" re-reads without the pending-only filter', () => {
    render(<InboxList />)
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(useInboxListMock).toHaveBeenLastCalledWith(true, false)
    const all = screen.getByRole('radio', { name: 'All' })
    expect(all).toHaveAttribute('data-state', 'on')
    expect(all).toHaveAttribute('aria-checked', 'true')
  })

  test('passes the disabled flag through, so a gated org issues no request', () => {
    render(<InboxList enabled={false} />)
    expect(useInboxListMock).toHaveBeenCalledWith(false, true)
  })
})

describe('InboxList — states', () => {
  test('loading renders a skeleton in the list shape, not a spinner', () => {
    useInboxListMock.mockReturnValue(result({ loading: true }))
    render(<InboxList />)
    expect(screen.getByTestId('inbox-skeleton')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-item')).not.toBeInTheDocument()
  })

  test('a load failure shows real copy and a retry that re-reads', () => {
    useInboxListMock.mockReturnValue(result({ error: true }))
    render(<InboxList />)

    expect(screen.getByText('Your inbox could not be loaded.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(refresh).toHaveBeenCalled()
  })

  test('the empty state differs by filter', () => {
    useInboxListMock.mockReturnValue(result())
    render(<InboxList />)

    expect(screen.getByText('Nothing needs you')).toBeInTheDocument()
    expect(
      screen.getByText('When a colleague asks for your input, it shows up here.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByText('Your inbox is empty')).toBeInTheDocument()
    expect(
      screen.getByText('Requests, answers and shared conversations appear here.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Nothing needs you')).not.toBeInTheDocument()
  })

  test('renders one row per item, driven by the type registry', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    render(<InboxList />)
    expect(screen.getAllByTestId('inbox-item')).toHaveLength(1)
    expect(screen.getByText('Anna Weber asked for your input')).toBeInTheDocument()
  })

  test('announces the count politely, without reading the list aloud (NF-3)', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    render(<InboxList />)
    // The live region is a small status node. It used to be the list container,
    // so every filter change and every archive re-announced all fifty rows.
    expect(screen.getByTestId('inbox-list')).not.toHaveAttribute('aria-live')
    const status = screen.getByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('1 item needs your attention')
    expect(status).not.toHaveTextContent('Anna Weber')
  })

  test('says nothing when nothing needs the reader', () => {
    // The region is re-read on every filter change and every archive, so an empty
    // queue used to interrupt with "0 items need your attention" — an
    // announcement about nothing, repeated.
    useInboxListMock.mockReturnValue(result({ items: [], pending: 0 }))
    render(<InboxList />)
    expect(screen.getByRole('status')).toHaveTextContent('')
    expect(screen.queryByText(/0 items/)).not.toBeInTheDocument()
  })

  test('a refused action is reported beside the list, not instead of it', () => {
    // Archiving a row a second tab already archived used to replace every row
    // with "Your inbox could not be loaded." — which had not happened.
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1, mutationError: true }))
    render(<InboxList />)
    expect(screen.getAllByTestId('inbox-item')).toHaveLength(1)
    expect(screen.getByText(/That action could not be completed/)).toBeInTheDocument()
    expect(screen.queryByText('Your inbox could not be loaded.')).not.toBeInTheDocument()
    // The refusal path does not re-read the list, so the alert must not claim it
    // did: the rows on screen are the ones that were already there.
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByText(/Your inbox is unchanged\./)).toBeInTheDocument()
  })

  test('the bulk action stands down while it is in flight', () => {
    useInboxListMock.mockReturnValue(
      result({ items: [ITEM], pending: 1, mutating: true }),
    )
    render(<InboxList />)
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled()
  })
})

describe('InboxList — actions', () => {
  test('mark-all-read is disabled while nothing is unread', () => {
    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'read' }] }))
    render(<InboxList />)
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeDisabled()
  })

  test('mark-all-read is enabled and wired when something is unread', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    render(<InboxList />)

    const button = screen.getByRole('button', { name: 'Mark all as read' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(markAllRead).toHaveBeenCalled()
  })

  test('archiving a row calls through to the hook', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    render(<InboxList />)
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(archive).toHaveBeenCalledWith('i1')
  })

  test('opening an unread row marks just that item read', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
    render(<InboxList />)
    fireEvent.click(screen.getByRole('link'))
    expect(markRead).toHaveBeenCalledWith(['i1'])
  })

  test('opening an already-read row does not re-mark it', () => {
    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'read' }] }))
    render(<InboxList />)
    fireEvent.click(screen.getByRole('link'))
    expect(markRead).not.toHaveBeenCalled()
  })
})
