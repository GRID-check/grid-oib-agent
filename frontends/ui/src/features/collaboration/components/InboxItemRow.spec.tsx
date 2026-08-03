import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test-utils'

import type { InboxItemView } from '@/lib/inbox/types'
import { InboxItemRow } from './InboxItemRow'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const base: InboxItemView = {
  id: 'i1',
  type: 'mention.requested',
  state: 'unread',
  actionable: true,
  resourceType: 'conversation',
  resourceId: 'c1',
  anchorId: 'm-9',
  actorName: 'Anna Weber',
  actorUserId: 'u-anna',
  count: 1,
  href: '/app/projects/p1/chat?session=c1#m-9',
  subject: 'Atrium – Rauchabschnitte',
  excerpt: 'Ist die Annahme richtig?',
  // Deliberately DIFFERENT moments: the row is timed by `updatedAt`, and while
  // the two matched here every assertion about which one the <time> carries was
  // true of both.
  createdAt: '2026-07-24T09:00:00Z',
  updatedAt: '2026-07-29T09:00:00Z',
}

const item = (overrides: Partial<InboxItemView> = {}): InboxItemView => ({ ...base, ...overrides })

/** Default locale in an unprovided test tree is `en`. */
describe('InboxItemRow — registry-driven rendering (IB-6)', () => {
  test('renders a mention request from its registry entry: who, what and where', () => {
    render(<InboxItemRow item={item()} />)
    expect(screen.getByText('Anna Weber asked for your input')).toBeInTheDocument()
    expect(screen.getByText('in Atrium – Rauchabschnitte')).toBeInTheDocument()
    expect(screen.getByText('Ist die Annahme richtig?')).toBeInTheDocument()
    // …and when: a rendered, machine-readable timestamp (the exact relative
    // wording depends on how long ago the fixture is, so assert the element).
    const time = document.querySelector('time')
    expect(time).toHaveAttribute('datetime', base.updatedAt)
    expect(time?.textContent?.trim()).not.toBe('')
  })

  test('times the row by when it last changed, not when it was created', () => {
    // The list is ORDERED by updatedAt, so a grouped row that just absorbed a
    // message sorts to the top — and used to arrive there saying "5 days ago".
    render(
      <InboxItemRow
        item={item({
          type: 'conversation.activity',
          count: 3,
          createdAt: '2026-07-24T09:00:00Z',
          updatedAt: '2026-07-29T09:00:00Z',
        })}
      />,
    )
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-07-29T09:00:00Z')
  })

  test('renders a neutral row for a type this build does not know', () => {
    // `type` is a text column and the presentation map is exhaustive only at
    // compile time: a row from a newer deploy used to throw and take the whole
    // inbox route down with it.
    render(<InboxItemRow item={item({ type: 'conversation.reaction' as never })} />)
    expect(screen.getByText('Something happened')).toBeInTheDocument()
    expect(screen.getByRole('listitem')).toBeInTheDocument()
  })

  test('a modified click does not spend the row\'s read state', () => {
    // Cmd/middle-clicking rows into background tabs is the triage gesture; it
    // used to mark every one of them read and remove them under the cursor.
    const onOpen = vi.fn()
    render(<InboxItemRow item={item()} onOpen={onOpen} />)
    const link = screen.getByRole('link')
    fireEvent.click(link, { metaKey: true })
    fireEvent.click(link, { ctrlKey: true })
    expect(onOpen).not.toHaveBeenCalled()
    fireEvent.click(link)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('links to the target at the exact spot', () => {
    render(<InboxItemRow item={item()} />)
    expect(screen.getByRole('link')).toHaveAttribute('href', base.href as string)
  })

  test('a shared-with-you item renders from the same component, no switch needed', () => {
    render(
      <InboxItemRow
        item={item({ type: 'conversation.shared_with_you', actionable: false, state: 'read' })}
      />,
    )
    expect(screen.getByText('Anna Weber shared a conversation with you')).toBeInTheDocument()
  })

  test('a grouped row uses the many-variant of the counted title', () => {
    render(<InboxItemRow item={item({ type: 'conversation.activity', actionable: false, count: 3 })} />)
    expect(screen.getByText('3 new messages')).toBeInTheDocument()
  })

  test('a single occurrence of a counted type uses the one-variant', () => {
    render(<InboxItemRow item={item({ type: 'conversation.activity', actionable: false, count: 1 })} />)
    expect(screen.getByText('1 new message')).toBeInTheDocument()
  })

  test('a read group with a spent counter does not claim one new message', () => {
    // `count` is occurrences SINCE THE ROW WAS LAST READ, so 0 is the ordinary
    // state of a read row — not an impossible one. Picking the one-variant for it
    // made a group of twenty the user had just read say "1 new message" while it
    // sat there with nothing new in it at all. Three cases, not two.
    render(
      <InboxItemRow
        item={item({ type: 'conversation.activity', actionable: false, state: 'read', count: 0 })}
      />,
    )
    expect(screen.getByText('Messages')).toBeInTheDocument()
    expect(screen.queryByText('1 new message')).not.toBeInTheDocument()
    // …and it must not claim novelty either: there is nothing new in this row.
    expect(screen.queryByText(/new/i)).not.toBeInTheDocument()
  })

  test('falls back to the placeholder copy for an unresolvable actor and an untitled target', () => {
    render(<InboxItemRow item={item({ actorName: null, subject: null })} />)
    expect(screen.getByText('Someone asked for your input')).toBeInTheDocument()
    expect(screen.getByText('in Untitled conversation')).toBeInTheDocument()
  })

  test('an answered request is labelled as resolved', () => {
    render(<InboxItemRow item={item({ state: 'resolved' })} />)
    expect(screen.getByText('Answered')).toBeInTheDocument()
  })

  test('an unread row is visually distinct from a read one', () => {
    const { unmount } = render(<InboxItemRow item={item()} />)
    expect(screen.getByRole('link')).toHaveClass('font-semibold')
    unmount()

    render(<InboxItemRow item={item({ state: 'read' })} />)
    expect(screen.getByRole('link')).not.toHaveClass('font-semibold')
  })
})

/**
 * IB-13/IB-14: an item whose target the recipient can no longer reach is redacted,
 * and must never be a working-looking link. This is a security behaviour, not a
 * cosmetic one — hence its own block.
 */
describe('InboxItemRow — inert items are never links (IB-13)', () => {
  const inert = item({ state: 'inert', href: null, excerpt: null, subject: null })

  test('renders no anchor at all — not an empty one, and not "#"', () => {
    render(<InboxItemRow item={inert} />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(document.querySelector('a')).toBeNull()
  })

  test('renders no anchor even if the server contradicted itself and sent an href', () => {
    // Defence in depth: `state` alone decides, so a stale/incorrect href on an
    // inert row cannot become a clickable link.
    render(<InboxItemRow item={item({ state: 'inert', href: '/app/projects/p1/chat?session=c1' })} />)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  test('explains itself instead of vanishing', () => {
    render(<InboxItemRow item={inert} />)
    expect(screen.getByText('No longer available')).toBeInTheDocument()
    expect(screen.getByText('You no longer have access to this.')).toBeInTheDocument()
    // The title still renders, so the row is not a mystery blank.
    expect(screen.getByText('Anna Weber asked for your input')).toBeInTheDocument()
  })

  test('names a withheld subject "no longer available", not "untitled"', () => {
    // The server withholds `subject` — the conversation TITLE — for any row whose
    // target the recipient can no longer reach, exactly as it withholds the
    // snippet (IB-13). Calling that "Untitled conversation" would misstate WHY the
    // row is nameless: the thread has a name, this reader is no longer entitled to
    // it. `href: null` is the server's signal that the row is redacted.
    render(<InboxItemRow item={item({ href: null, subject: null, excerpt: null })} />)

    // A complete sentence rather than the templated "in {subject}": that template
    // needs a real title, and the placeholder inside it produced nonsense in the
    // primary product language ("… in Nicht mehr verfügbar").
    expect(
      screen.getByText('This conversation is no longer available to you.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('in Untitled conversation')).not.toBeInTheDocument()
  })

  test('still says "untitled" for a REACHABLE thread that genuinely has no name', () => {
    // The two cases must not be conflated in the other direction either.
    render(<InboxItemRow item={item({ subject: null })} />)

    expect(screen.getByText('in Untitled conversation')).toBeInTheDocument()
  })
})

describe('InboxItemRow — actions', () => {
  test('archive is a labelled button OUTSIDE the row link (no nested interactives)', () => {
    const onArchive = vi.fn()
    render(<InboxItemRow item={item()} onArchive={onArchive} />)

    const button = screen.getByRole('button', { name: 'Archive' })
    expect(button.closest('a')).toBeNull()
    expect(screen.getByRole('link').querySelector('button')).toBeNull()

    fireEvent.click(button)
    expect(onArchive).toHaveBeenCalledWith('i1')
  })

  test('omits the archive control when no handler is supplied', () => {
    render(<InboxItemRow item={item()} />)
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
  })

  test('reports an opened row so the list can mark it read', () => {
    const onOpen = vi.fn()
    render(<InboxItemRow item={item()} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('link'))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }))
  })
})
