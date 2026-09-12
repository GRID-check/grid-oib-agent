import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@/test-utils'

import type { InboxItemView } from '@/lib/inbox/types'
import { formatAbsoluteTime } from '@/lib/format'
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

describe('InboxItemRow — the operational storage alert (ADR-0042)', () => {
  /** The row as `evaluateStorageAlert` produces it: system-generated, no actor. */
  const storageAlert = (overrides: Partial<InboxItemView> = {}): InboxItemView =>
    item({
      id: 'i-storage',
      type: 'storage.quota_warning',
      actionable: false,
      resourceType: 'organization',
      resourceId: 'org_1',
      anchorId: '80',
      actorName: null,
      actorUserId: null,
      href: '/app/organization/storage',
      // The locale-neutral token the emitter puts in `payload.subject`.
      subject: '82%',
      excerpt: null,
      ...overrides,
    })

  test('renders the warning copy and links to the page that explains it', () => {
    render(<InboxItemRow item={storageAlert()} />)

    expect(screen.getByText('Your organisation is running out of storage')).toBeInTheDocument()
    expect(
      screen.getByText(
        '82% of the storage quota is in use. Once it is full, uploads will start failing — delete documents you no longer need, or ask whoever runs Piloti for you to raise the quota.',
      ),
    ).toBeInTheDocument()
    // The deep link goes to Organization → Storage, which every member can read
    // — not to a settings control the tenant does not have.
    expect(screen.getByRole('link')).toHaveAttribute('href', '/app/organization/storage')
  })

  test('names no actor — the platform is not a colleague', () => {
    render(<InboxItemRow item={storageAlert()} />)

    // The mention rows read "<Name> asked for your input"; a system alert that
    // fell back to the actor placeholder would invent a person.
    expect(screen.queryByText(/Someone/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Anna Weber/)).not.toBeInTheDocument()
  })

  test('still reads correctly after a re-crossing bumps the count', () => {
    // A recovery archives the row; the next crossing REVIVES it, so `count`
    // arrives at 2. The type ships a single `title` (no titleOne/titleMany), and
    // the count-aware key picker must fall back to it rather than dropping the
    // title entirely.
    render(<InboxItemRow item={storageAlert({ count: 2 })} />)

    expect(screen.getByText('Your organisation is running out of storage')).toBeInTheDocument()
  })

  test('is tinted as needing attention without being an actionable request', () => {
    const { container } = render(<InboxItemRow item={storageAlert()} />)

    // `tone: 'warning'` shares the request tint — something needs attention —
    // but the row is not actionable, so it never sits in the "needs me" badge.
    expect(container.querySelector('.bg-warning-subtle')).not.toBeNull()
  })
})

describe('InboxItemRow — a version waiting for a decision (ADR-0054)', () => {
  const reviewRequest = (overrides: Partial<InboxItemView> = {}): InboxItemView =>
    item({
      id: 'i-review',
      type: 'document.review_requested',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ver_2',
      actorName: 'Anna Weber',
      actorUserId: 'u-anna',
      // What the emission writes into the payload: the document's own name.
      subject: 'Brandschutzkonzept_Wohnbau-Nord.md',
      excerpt: null,
      href: '/app/projects/p1/files?doc=doc_1',
      ...overrides,
    })

  test('names the document and who is asking, and links to the file', () => {
    render(<InboxItemRow item={reviewRequest()} />)

    expect(
      screen.getByText('Anna Weber asked you to review Brandschutzkonzept_Wohnbau-Nord.md'),
    ).toBeInTheDocument()
    expect(screen.getByText('A new version is waiting for your approval.')).toBeInTheDocument()
    // The deep links are the document's own — the title row and the explicit
    // open control both land on the pane where the review controls are.
    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/app/projects/p1/files?doc=doc_1')
    }
  })

  test('reads as an outstanding request while it is open', () => {
    const { container } = render(<InboxItemRow item={reviewRequest()} />)
    expect(container.querySelector('.bg-warning-subtle')).not.toBeNull()
  })

  test('stops shouting once the decision has been taken', () => {
    // The backend resolves the round for every reviewer who was asked; the row
    // is then history, and colouring it would keep asking for something that
    // has already happened.
    const { container } = render(<InboxItemRow item={reviewRequest({ state: 'resolved' })} />)
    expect(container.querySelector('.bg-warning-subtle')).toBeNull()
  })
})

describe('InboxItemRow — inline review decisions (triage without Files)', () => {
  const reviewRequest = (overrides: Partial<InboxItemView> = {}): InboxItemView =>
    item({
      id: 'i-review',
      type: 'document.review_requested',
      resourceType: 'document',
      resourceId: 'doc_1',
      anchorId: 'ver_2',
      actorName: 'Anna Weber',
      actorUserId: 'u-anna',
      subject: 'Brandschutzkonzept_Wohnbau-Nord.md',
      excerpt: 'Bitte die Fluchtweglänge prüfen.',
      href: '/app/projects/p1/files?doc=doc_1',
      ...overrides,
    })

  const reviewClient = (overrides: Record<string, unknown> = {}) => ({
    approve: vi.fn().mockResolvedValue({}),
    requestChanges: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    ...overrides,
  })

  test('offers the three decisions and the file beside them', () => {
    render(<InboxItemRow item={reviewRequest()} reviewClient={reviewClient()} />)

    expect(screen.getByTestId('inbox-review-approve')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-review-request-changes')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-review-reject')).toBeInTheDocument()
    // The order excerpt stays visible, and the file opens from the row.
    expect(screen.getByText('Bitte die Fluchtweglänge prüfen.')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-review-open')).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc_1',
    )
  })

  test('approval is signed, never one click', async () => {
    const client = reviewClient()
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    expect(client.approve).not.toHaveBeenCalled()
    const send = screen.getByTestId('inbox-review-approve-send')
    expect(send).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'I release this version' }))
    expect(send).toBeEnabled()
    fireEvent.click(send)

    expect(client.approve).toHaveBeenCalledWith('doc_1', 'ver_2')
    expect(await screen.findByTestId('inbox-review-decided')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-review-approve')).not.toBeInTheDocument()
  })

  test('approval names the stand, the acting moment and the date — like the file pane', () => {
    render(<InboxItemRow item={reviewRequest()} reviewClient={reviewClient()} />)

    fireEvent.click(screen.getByTestId('inbox-review-approve'))

    // Which stand: the document and when the round opened (≈ submission).
    expect(screen.getByTestId('inbox-review-approve-stand')).toHaveTextContent(
      `Brandschutzkonzept_Wohnbau-Nord.md · as of ${formatAbsoluteTime('2026-07-24T09:00:00Z', 'en')}`,
    )
    // Who acts when: the viewer signs now — no name is known here, so date only.
    expect(screen.getByTestId('inbox-review-approve-acting').textContent).toMatch(/^Acting: /)
  })

  test('requesting changes requires words', async () => {
    const client = reviewClient()
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)

    fireEvent.click(screen.getByTestId('inbox-review-request-changes'))
    const send = screen.getByTestId('inbox-review-comment-send')
    expect(send).toBeDisabled()
    expect(client.requestChanges).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Die Fluchtweglänge fehlt.' },
    })
    fireEvent.click(send)

    expect(client.requestChanges).toHaveBeenCalledWith(
      'doc_1',
      'ver_2',
      'Die Fluchtweglänge fehlt.',
    )
    expect(await screen.findByTestId('inbox-review-decided')).toBeInTheDocument()
  })

  test('rejecting requires a reason', async () => {
    const client = reviewClient()
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)

    fireEvent.click(screen.getByTestId('inbox-review-reject'))
    expect(screen.getByText('Reason for rejection')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Falsches Gebäude.' },
    })
    fireEvent.click(screen.getByTestId('inbox-review-comment-send'))

    expect(client.reject).toHaveBeenCalledWith('doc_1', 'ver_2', 'Falsches Gebäude.')
    expect(await screen.findByTestId('inbox-review-decided')).toBeInTheDocument()
  })

  test('a refused decision says so and keeps the row decidable', async () => {
    const client = reviewClient({ approve: vi.fn().mockRejectedValue(new Error('403')) })
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    fireEvent.click(screen.getByRole('checkbox', { name: 'I release this version' }))
    fireEvent.click(screen.getByTestId('inbox-review-approve-send'))

    expect(await screen.findByTestId('inbox-review-failed')).toBeInTheDocument()
    // One error red: the product `text-error` token, like every other surface.
    expect(screen.getByTestId('inbox-review-failed')).toHaveClass('text-error')
    // Nothing settled: the decisions stay offered for a retry.
    expect(screen.getByTestId('inbox-review-approve-confirm')).toBeInTheDocument()
  })

  test('no inline decisions once the round is settled, unreachable, or anchorless', () => {
    const { unmount } = render(
      <InboxItemRow item={reviewRequest({ state: 'resolved' })} reviewClient={reviewClient()} />,
    )
    expect(screen.queryByTestId('inbox-review-actions')).not.toBeInTheDocument()
    unmount()

    render(
      <InboxItemRow
        item={reviewRequest({ state: 'inert', href: null })}
        reviewClient={reviewClient()}
      />,
    )
    expect(screen.queryByTestId('inbox-review-actions')).not.toBeInTheDocument()
  })

  test('no inline decisions without a version anchor or on other types', () => {
    const { unmount } = render(
      <InboxItemRow item={reviewRequest({ anchorId: null })} reviewClient={reviewClient()} />,
    )
    expect(screen.queryByTestId('inbox-review-actions')).not.toBeInTheDocument()
    unmount()

    render(<InboxItemRow item={item()} reviewClient={reviewClient()} />)
    expect(screen.queryByTestId('inbox-review-actions')).not.toBeInTheDocument()
  })
})
describe('InboxItemRow — a row whose target is a document', () => {
  const reviewRequest = (overrides: Partial<InboxItemView> = {}): InboxItemView =>
    item({
      type: 'document.review_requested',
      resourceType: 'document',
      resourceId: 'doc-7',
      anchorId: 'ver-7',
      href: '/app/projects/p1/files?doc=doc-7',
      subject: 'Befund Fluchtwege',
      excerpt: null,
      ...overrides,
    })

  test('offers Besprechen beside the link that opens the file', () => {
    // A reviewer has two next moves — open the file, or ask about it — and only
    // the first had a control. The second used to be impossible anyway: a
    // submitted draft has no chunks, so Piloti could not answer about it.
    render(<InboxItemRow item={reviewRequest()} />)
    expect(screen.getByTestId('discuss-document')).toBeInTheDocument()
  })

  test('does not switch on the item type, only on what the row points at', () => {
    // The registry is the only thing that decides how a row LOOKS; this control
    // is keyed on `resourceType`, which every row already carries.
    render(<InboxItemRow item={item()} />)
    expect(screen.queryByTestId('discuss-document')).not.toBeInTheDocument()
  })

  test('offers nothing on an inert row, whose target is gone', () => {
    // Same reason the title is not a link there: a working-looking control
    // pointing at content this reader may no longer reach (IB-13/IB-14).
    render(<InboxItemRow item={reviewRequest({ state: 'inert', href: null })} />)
    expect(screen.queryByTestId('discuss-document')).not.toBeInTheDocument()
  })

  test('offers nothing for an Archiv document, which has no project chat', () => {
    render(<InboxItemRow item={reviewRequest({ href: '/app/archiv?doc=doc-7' })} />)
    expect(screen.queryByTestId('discuss-document')).not.toBeInTheDocument()
  })
})
