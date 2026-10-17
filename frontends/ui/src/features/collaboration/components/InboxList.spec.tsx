import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@/test-utils'

import type { InboxItemView } from '@/lib/inbox/types'

// The undo toast is the contract; sonner is stubbed so its action can be pressed.
const toastMock = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: toastMock }))

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
const markUnread = vi.fn(async () => {})
const markAllRead = vi.fn(async () => {})
const archive = vi.fn(async () => {})
const unarchive = vi.fn(async () => true)
const loadMore = vi.fn()
const dismissMutationError = vi.fn()

function result(overrides: Partial<UseInboxListResult> = {}): UseInboxListResult {
  return {
    items: [],
    pending: 0,
    counts: { requests: 0, unread: 0 },
    hasMore: false,
    loadingMore: false,
    loadMoreFailed: false,
    loadMore,
    markUnread,
    unarchive,
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
  archived: false,
  actionable: true,
  resourceType: 'conversation',
  resourceId: 'c1',
  anchorId: null,
  actorName: 'Anna Weber',
  actorUserId: 'u-anna',
  count: 1,
  href: '/app/projects/p1/chat?session=c1',
  subject: 'Atrium',
  related: null,
  excerpt: null,
  variant: null,
  createdAt: '2026-07-29T09:00:00Z',
  updatedAt: '2026-07-29T09:00:00Z',
}

/** Default locale in an unprovided test tree is `en`. */
describe('InboxList — filters', () => {
  beforeEach(() => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
  })

  test('defaults to "needs me", which asks the hook for open requests only', () => {
    render(<InboxList />)
    expect(useInboxListMock).toHaveBeenCalledWith(true, 'requests')
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

  test('switching to "all" re-reads everything unarchived', () => {
    render(<InboxList />)
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(useInboxListMock).toHaveBeenLastCalledWith(true, 'all')
    const all = screen.getByRole('radio', { name: 'All' })
    expect(all).toHaveAttribute('data-state', 'on')
    expect(all).toHaveAttribute('aria-checked', 'true')
  })

  test('passes the disabled flag through, so a gated org issues no request', () => {
    render(<InboxList enabled={false} />)
    expect(useInboxListMock).toHaveBeenCalledWith(false, 'requests')
  })

  test('„Unread“ and „Archived“ are filters of their own, each reading its own slice', () => {
    render(<InboxList />)
    fireEvent.click(screen.getByRole('radio', { name: 'Unread' }))
    expect(useInboxListMock).toHaveBeenLastCalledWith(true, 'unread')
    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }))
    expect(useInboxListMock).toHaveBeenLastCalledWith(true, 'archived')
  })

  test('the selected filter wears a filled thumb', () => {
    render(<InboxList />)
    const needsMe = screen.getByRole('radio', { name: /Needs me/ })
    expect(needsMe.querySelector('[data-slot="toggle-pill"]')).toHaveClass('bg-foreground')
  })

  test('a filter carries its count only when there is one, with no blank tail at zero', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1, counts: { requests: 2, unread: 0 } }))
    render(<InboxList />)
    expect(screen.getByRole('radio', { name: /Needs me/ })).toHaveTextContent('Needs me2')
    expect(screen.getByRole('radio', { name: 'Unread' }).querySelector('[data-slot="count-pill"]')).toBeNull()
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
      screen.getByText('When someone mentions you, assigns you an annotation or Piloti asks you something, it appears here.'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(screen.getByText('Your inbox is empty')).toBeInTheDocument()
    expect(screen.getByText('News from your team and from Piloti appears here.')).toBeInTheDocument()
    expect(screen.queryByText('Nothing needs you')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }))
    expect(screen.getByText('Nothing archived')).toBeInTheDocument()
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
  test('mark-all-read is not offered on an empty list, nor under „Archived“', () => {
    useInboxListMock.mockReturnValue(result())
    render(<InboxList />)
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument()

    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'archived' }] }))
    fireEvent.click(screen.getByRole('radio', { name: 'Archived' }))
    expect(screen.queryByRole('button', { name: 'Mark all as read' })).not.toBeInTheDocument()
  })

  test('says there are older items, and loads them on request', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1, hasMore: true }))
    render(<InboxList />)
    fireEvent.click(screen.getByRole('button', { name: 'Load older items' }))
    expect(loadMore).toHaveBeenCalled()
  })

  test('says nothing about older items when there are none', () => {
    useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1, hasMore: false }))
    render(<InboxList />)
    expect(screen.queryByRole('button', { name: 'Load older items' })).not.toBeInTheDocument()
  })

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

  describe('archiving', () => {
    beforeEach(() => {
      toastMock.mockClear()
      vi.useFakeTimers()
    })
    afterEach(() => vi.useRealTimers())

    test('hides the row at once and tells the server only when the undo window closes', () => {
      useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
      render(<InboxList />)
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

      expect(screen.queryByTestId('inbox-item')).not.toBeInTheDocument()
      expect(toastMock).toHaveBeenCalledWith(
        'Archived',
        expect.objectContaining({ action: expect.objectContaining({ label: 'Undo' }) }),
      )
      expect(archive).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(archive).toHaveBeenCalledWith('i1')
    })

    test('Undo brings the row back and sends nothing', () => {
      useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
      render(<InboxList />)
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))

      const options = toastMock.mock.calls[0][1] as { action: { onClick: () => void } }
      act(() => options.action.onClick())
      expect(screen.getByTestId('inbox-item')).toBeInTheDocument()

      act(() => {
        vi.advanceTimersByTime(10000)
      })
      expect(archive).not.toHaveBeenCalled()
    })

    test('leaving the list sends an archive that is still waiting', () => {
      useInboxListMock.mockReturnValue(result({ items: [ITEM], pending: 1 }))
      const { unmount } = render(<InboxList />)
      fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
      unmount()
      expect(archive).toHaveBeenCalledWith('i1')
    })
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

describe('InboxList — keyboard triage', () => {
  const SECOND: InboxItemView = { ...ITEM, id: 'i2', state: 'read', actorName: 'Markus Hofer', actorUserId: 'u-markus' }

  beforeEach(() => {
    toastMock.mockClear()
    markRead.mockClear()
    markUnread.mockClear()
    useInboxListMock.mockReturnValue(result({ items: [ITEM, SECOND], pending: 1 }))
  })

  const focusedRow = () => document.querySelector('[data-focused="true"]')?.getAttribute('data-item-id') ?? null

  test('j and k move between rows', () => {
    render(<InboxList />)
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(focusedRow()).toBe('i1')
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(focusedRow()).toBe('i2')
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(focusedRow()).toBe('i2')
    fireEvent.keyDown(document.body, { key: 'k' })
    expect(focusedRow()).toBe('i1')
  })

  test('Enter opens the row, which marks it read', () => {
    render(<InboxList />)
    fireEvent.keyDown(document.body, { key: 'j' })
    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(markRead).toHaveBeenCalledWith(['i1'])
  })

  test('u toggles read, and e archives with the same undo as the button', () => {
    vi.useFakeTimers()
    try {
      render(<InboxList />)
      fireEvent.keyDown(document.body, { key: 'j' })
      fireEvent.keyDown(document.body, { key: 'u' })
      expect(markRead).toHaveBeenCalledWith(['i1'])
      fireEvent.keyDown(document.body, { key: 'j' })
      fireEvent.keyDown(document.body, { key: 'u' })
      expect(markUnread).toHaveBeenCalledWith(['i2'])
      fireEvent.keyDown(document.body, { key: 'e' })
      expect(toastMock).toHaveBeenCalledWith('Archived', expect.objectContaining({ action: expect.anything() }))
      act(() => {
        vi.advanceTimersByTime(5000)
      })
      expect(archive).toHaveBeenCalledWith('i2')
    } finally {
      vi.useRealTimers()
    }
  })

  test('after e, the keyboard focus moves to the next row, in the DOM as well', () => {
    vi.useFakeTimers()
    try {
      render(<InboxList />)
      fireEvent.keyDown(document.body, { key: 'j' })
      fireEvent.keyDown(document.body, { key: 'e' })
      expect(document.activeElement?.getAttribute('data-item-id')).toBe('i2')
    } finally {
      vi.useRealTimers()
    }
  })

  test('typing in a field never triages', () => {
    render(
      <>
        <input aria-label="Elsewhere" />
        <InboxList />
      </>,
    )
    const field = screen.getByLabelText('Elsewhere')
    fireEvent.keyDown(field, { key: 'j' })
    fireEvent.keyDown(field, { key: 'e' })
    expect(focusedRow()).toBeNull()
    expect(toastMock).not.toHaveBeenCalled()
  })
})

describe('InboxList — the archive', () => {
  beforeEach(() => {
    toastMock.mockClear()
    unarchive.mockClear()
    archive.mockClear()
  })

  test('restores an archived row from its menu, and says so once it is true', async () => {
    const userEvent = (await import('@testing-library/user-event')).default
    const user = userEvent.setup()
    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'archived', archived: true }] }))
    render(<InboxList initialFilter="archived" />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByTestId('inbox-unarchive'))
    expect(unarchive).toHaveBeenCalledWith('i1')
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Restored'))
  })

  test('says nothing when the restore was refused', async () => {
    unarchive.mockResolvedValueOnce(false)
    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'archived', archived: true }] }))
    render(<InboxList initialFilter="archived" />)
    fireEvent.keyDown(document.body, { key: 'j' })
    fireEvent.keyDown(document.body, { key: 'e' })
    await waitFor(() => expect(unarchive).toHaveBeenCalled())
    await Promise.resolve()
    expect(toastMock).not.toHaveBeenCalledWith('Restored')
  })

  test('e restores an archived row whose target went away, instead of archiving it again', () => {
    useInboxListMock.mockReturnValue(result({ items: [{ ...ITEM, state: 'inert', archived: true, href: null }] }))
    render(<InboxList initialFilter="archived" />)
    fireEvent.keyDown(document.body, { key: 'j' })
    fireEvent.keyDown(document.body, { key: 'e' })
    expect(unarchive).toHaveBeenCalledWith('i1')
    expect(toastMock).not.toHaveBeenCalledWith('Archived', expect.anything())
  })
})
