import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { render as renderPlain } from '@testing-library/react'
import { act, fireEvent, render, screen, waitFor } from '@/test-utils'
import { I18nProvider } from '@/i18n'

import type { InboxItemView } from '@/lib/inbox/types'
import { formatAbsoluteTime } from '@/lib/format'
import { DocumentLifecycleError } from '@/lib/documents/lifecycle-client'
import { AnnotationRequestError } from '@/lib/annotations/client'
import userEvent from '@testing-library/user-event'
import { InboxItemRow, type InboxMarkClient } from './InboxItemRow'

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
  archived: false,
  actionable: true,
  resourceType: 'conversation',
  resourceId: 'c1',
  anchorId: 'm-9',
  actorName: 'Anna Weber',
  actorUserId: 'u-anna',
  count: 1,
  href: '/app/projects/p1/chat?session=c1#m-9',
  subject: 'Atrium – Rauchabschnitte',
  related: null,
  excerpt: 'Ist die Annahme richtig?',
  variant: null,
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

  test('an upload with no place to name reads its own sentence, never a stand-in subject', () => {
    const upload = { type: 'upload.completed' as const, resourceType: 'upload_batch' as const, actorName: null, actorUserId: null, excerpt: null, href: '/app/uploads/b1' }
    const { unmount } = render(<InboxItemRow item={item({ ...upload, subject: 'Wohnbau Nord' })} />)
    expect(screen.getByText('Wohnbau Nord: open the summary to see what arrived.')).toBeInTheDocument()
    unmount()

    render(<InboxItemRow item={item({ ...upload, subject: null })} />)
    expect(screen.getByText('Open the summary to see what arrived.')).toBeInTheDocument()
    expect(screen.queryByText(/Untitled/)).not.toBeInTheDocument()
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

  test('a grouped row uses the many-variant of the counted title, and says who wrote last', () => {
    render(<InboxItemRow item={item({ type: 'conversation.activity', actionable: false, count: 3 })} />)
    expect(screen.getByText('3 new messages in “Atrium – Rauchabschnitte”, latest from Anna Weber')).toBeInTheDocument()
  })

  test('a single occurrence of a counted type says who wrote, and where, in one line', () => {
    render(<InboxItemRow item={item({ type: 'conversation.activity', actionable: false, count: 1 })} />)
    expect(screen.getByText('Anna Weber wrote in “Atrium – Rauchabschnitte”')).toBeInTheDocument()
    // The chat is in the title now, so the old „in {subject}“ line is gone.
    expect(screen.queryByText('in Atrium – Rauchabschnitte')).not.toBeInTheDocument()
  })

  test('a chat row without an actor says what arrived without inventing a „Someone“', () => {
    render(<InboxItemRow item={item({ type: 'conversation.activity', actionable: false, count: 2, actorName: null, actorUserId: null })} />)
    expect(screen.getByText('2 new messages in “Atrium – Rauchabschnitte”')).toBeInTheDocument()
  })

  test('a redacted chat row names no chat in quotes', () => {
    render(<InboxItemRow item={item({ type: 'conversation.activity', actionable: false, count: 2, href: null, subject: null, excerpt: null })} />)
    expect(screen.getByText('Messages in a chat')).toBeInTheDocument()
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
    expect(screen.getByText('Messages in “Atrium – Rauchabschnitte”')).toBeInTheDocument()
    expect(screen.queryByText('1 new message')).not.toBeInTheDocument()
    // …and it must not claim novelty either: there is nothing new in this row.
    expect(screen.queryByText(/new/i)).not.toBeInTheDocument()
  })

  test('falls back to the placeholder copy for an unresolvable actor and an untitled target', () => {
    render(<InboxItemRow item={item({ actorName: null, subject: null })} />)
    expect(screen.getByText('Someone asked for your input')).toBeInTheDocument()
    expect(screen.getByText('in Untitled conversation')).toBeInTheDocument()
  })

  test('an answered request is labelled as resolved, and its title says whose question it was', () => {
    render(<InboxItemRow item={item({ state: 'resolved' })} />)
    expect(screen.getByText('Answered')).toBeInTheDocument()
    expect(screen.getByText('Anna Weber’s question has been answered')).toBeInTheDocument()
    expect(screen.queryByText('Anna Weber asked for your input')).not.toBeInTheDocument()
  })

  test('in German an answered request reads „Die Frage von …“, without a genitive that breaks on „Markus“', () => {
    renderPlain(
      <I18nProvider initialLocale="de" fixedLocale>
        <InboxItemRow item={item({ state: 'resolved', actorName: 'Markus Hofer' })} />
      </I18nProvider>,
    )
    expect(screen.getByText('Die Frage von Markus Hofer ist beantwortet')).toBeInTheDocument()
  })

  test('an answer from nobody in particular says the question was answered, not „Someone replied“', () => {
    render(<InboxItemRow item={item({ type: 'mention.answered', actionable: false, state: 'read', actorName: null, actorUserId: null })} />)
    expect(screen.getByText('Your question was answered')).toBeInTheDocument()
    expect(screen.queryByText('Someone replied')).not.toBeInTheDocument()
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
    // Said once as a badge and once as the body; the third line that repeated it is gone.
    expect(screen.queryByText('You no longer have access to this.')).not.toBeInTheDocument()
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
      screen.getByText('This is no longer available to you.'),
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

    expect(screen.getByText('Your organization is running out of storage')).toBeInTheDocument()
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

    expect(screen.getByText('Your organization is running out of storage')).toBeInTheDocument()
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
    expect(screen.getByText('A new revision is waiting for your approval.')).toBeInTheDocument()
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

  const reviewVersion = {
    id: 'ver_2',
    documentId: 'doc_1',
    versionNumber: 2,
    state: 'in_review',
    archived: false,
    contentType: 'text/markdown',
    fileSize: 1200,
    contentHash: 'sha256:abc',
    submittedBy: 'u-anna',
    submittedAt: '2026-07-24T09:00:00Z',
    reviewedBy: null,
    reviewedAt: null,
    approvedBy: null,
    approvedAt: null,
    publishedBy: null,
    publishedAt: null,
    reviewComment: null,
    createdBy: 'u-anna',
    createdAt: '2026-07-24T09:00:00Z',
    updatedAt: '2026-07-24T09:00:00Z',
  }

  const reviewClient = (overrides: Record<string, unknown> = {}) => ({
    approve: vi.fn().mockResolvedValue({}),
    requestChanges: vi.fn().mockResolvedValue({}),
    reject: vi.fn().mockResolvedValue({}),
    getVersion: vi.fn().mockResolvedValue(reviewVersion),
    ...overrides,
  })

  // The STAND read fires with the row and settles on microtasks. Flush it
  // before interacting so the `ifMatch` each decision sends is deterministic
  // — which STAND the test acts on — rather than a race between the clicks
  // below and the promise.
  const settleStand = () => act(async () => {})

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
    await settleStand()

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    expect(client.approve).not.toHaveBeenCalled()
    // The Fassung number is required: the stand already names which version
    // the signature releases, and the send stays shut until it is signed.
    await waitFor(() =>
      expect(screen.getByTestId('inbox-review-approve-stand')).toHaveTextContent('revision 2'),
    )
    const send = screen.getByTestId('inbox-review-approve-send')
    expect(send).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'I approve this revision' }))
    expect(send).toBeEnabled()
    fireEvent.click(send)

    expect(client.approve).toHaveBeenCalledWith('doc_1', 'ver_2', undefined, 'sha256:abc')
    expect(await screen.findByTestId('inbox-review-decided')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-review-approve')).not.toBeInTheDocument()
  })

  test('approval waits for the STAND: no Fassung number, no signature', async () => {
    // Bestimmtheit: with the read still in flight the stand is unnamed ('…')
    // and the send stays shut even once signed — a liability act without a
    // named Fassung is void.
    const client = reviewClient({ getVersion: vi.fn().mockReturnValue(new Promise(() => {})) })
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    expect(screen.getByTestId('inbox-review-approve-stand')).toHaveTextContent('…')
    fireEvent.click(screen.getByRole('checkbox', { name: 'I approve this revision' }))
    expect(screen.getByTestId('inbox-review-approve-send')).toBeDisabled()
    expect(client.approve).not.toHaveBeenCalled()
  })

  test('a failed STAND read says so, blocks the signature, and retries', async () => {
    // The read failure used to be a silent dead end: the stand stayed '…' and
    // the send stayed shut with nothing saying why. The row must name it and
    // offer the retry, and must never fall back to approving without ifMatch.
    const client = reviewClient({
      getVersion: vi
        .fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValue(reviewVersion),
    })
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    expect(await screen.findByTestId('inbox-review-stand-failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'I approve this revision' }))
    expect(screen.getByTestId('inbox-review-approve-send')).toBeDisabled()
    expect(client.approve).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('inbox-review-stand-retry'))

    await waitFor(() =>
      expect(screen.getByTestId('inbox-review-approve-stand')).toHaveTextContent('revision 2'),
    )
    expect(screen.queryByTestId('inbox-review-stand-failed')).toBeNull()
    expect(screen.getByTestId('inbox-review-approve-send')).toBeEnabled()
  })

  test('approval names the stand, the actor, the acting moment and the date — like the file pane', async () => {
    // The STAND read settles first under real timers (`findBy`/`waitFor` poll
    // on timers, so freezing them first would hang the wait below); only then
    // is the clock frozen, so the acting line — which stamps the viewer's own
    // press — is asserted in full, never just its prefix.
    render(<InboxItemRow item={reviewRequest()} reviewClient={reviewClient()} />)
    await settleStand()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T10:00:00Z'))
    try {
      fireEvent.click(screen.getByTestId('inbox-review-approve'))

      // Which stand: the document, its Fassung number (required — file-pane
      // parity) and when the round opened (≈ submission).
      expect(screen.getByTestId('inbox-review-approve-stand')).toHaveTextContent(
        `Brandschutzkonzept_Wohnbau-Nord.md · revision 2 · as of ${formatAbsoluteTime('2026-07-24T09:00:00Z', 'en')}`,
      )
      // Actor identity: whose request this stand answers — no name is stamped
      // on the acting line itself (none is known here), so the row title carries it.
      expect(
        screen.getByText('Anna Weber asked you to review Brandschutzkonzept_Wohnbau-Nord.md'),
      ).toBeInTheDocument()
      // Who acts when: the viewer signs now — the full stamped moment, date and all.
      expect(screen.getByTestId('inbox-review-approve-acting').textContent).toBe(
        `Acting: ${formatAbsoluteTime('2026-08-04T10:00:00Z', 'en')}`,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  test('requesting changes requires words', async () => {
    const client = reviewClient()
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)
    await settleStand()

    fireEvent.click(screen.getByTestId('inbox-review-request-changes'))
    // The STAND read runs when the decision opens; its `contentHash` rides the
    // call below as `ifMatch`, so a stale row 409s instead of refusing bytes
    // the reviewer never saw.
    await waitFor(() => expect(client.getVersion).toHaveBeenCalled())
    const send = screen.getByTestId('inbox-review-comment-send')
    expect(send).toBeDisabled()
    expect(client.requestChanges).not.toHaveBeenCalled()

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Die Fluchtweglänge fehlt.' },
    })
    fireEvent.click(send)

    await waitFor(() =>
      expect(client.requestChanges).toHaveBeenCalledWith(
        'doc_1',
        'ver_2',
        'Die Fluchtweglänge fehlt.',
        undefined,
        'sha256:abc',
      ),
    )
    expect(await screen.findByTestId('inbox-review-decided')).toBeInTheDocument()
  })

  test('rejecting requires a reason', async () => {
    const client = reviewClient()
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)
    await settleStand()

    fireEvent.click(screen.getByTestId('inbox-review-reject'))
    await waitFor(() => expect(client.getVersion).toHaveBeenCalled())
    expect(screen.getByText('Reason for rejection')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'Falsches Gebäude.' },
    })
    fireEvent.click(screen.getByTestId('inbox-review-comment-send'))

    await waitFor(() =>
      expect(client.reject).toHaveBeenCalledWith('doc_1', 'ver_2', 'Falsches Gebäude.', 'sha256:abc'),
    )
    expect(await screen.findByTestId('inbox-review-decided')).toBeInTheDocument()
  })

  test('a refused decision says so and keeps the row decidable', async () => {
    const client = reviewClient({ approve: vi.fn().mockRejectedValue(new Error('403')) })
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)
    await settleStand()

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    expect(await screen.findByTestId('inbox-review-approve-stand')).toHaveTextContent('revision 2')
    fireEvent.click(screen.getByRole('checkbox', { name: 'I approve this revision' }))
    fireEvent.click(screen.getByTestId('inbox-review-approve-send'))

    expect(await screen.findByTestId('inbox-review-failed')).toBeInTheDocument()
    // One error red: the product `text-error` token, like every other surface.
    expect(screen.getByTestId('inbox-review-failed')).toHaveClass('text-error')
    // Nothing settled: the decisions stay offered for a retry.
    expect(screen.getByTestId('inbox-review-approve-confirm')).toBeInTheDocument()
  })

  test('a stale STAND surfaces distinctly, with the file as the way back', async () => {
    // Somebody decided first, or the bytes changed under the row: the server
    // 409s with the current STAND, and the row must not dress that as a
    // generic failure — it names the move and links where the current Fassung
    // lives, and it keeps the confirm offered for a retry once re-read.
    const client = reviewClient({
      approve: vi
        .fn()
        .mockRejectedValue(new DocumentLifecycleError(409, 'CONFLICT', 'state changed')),
    })
    render(<InboxItemRow item={reviewRequest()} reviewClient={client} />)
    await settleStand()

    fireEvent.click(screen.getByTestId('inbox-review-approve'))
    expect(await screen.findByTestId('inbox-review-approve-stand')).toHaveTextContent('revision 2')
    fireEvent.click(screen.getByRole('checkbox', { name: 'I approve this revision' }))
    fireEvent.click(screen.getByTestId('inbox-review-approve-send'))

    expect(await screen.findByTestId('inbox-review-stale')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-review-failed')).not.toBeInTheDocument()
    expect(screen.getByTestId('inbox-review-reload')).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc_1',
    )
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

  test('no inline decisions without a version anchor, a Fassung name, or on other types', () => {
    const { unmount } = render(
      <InboxItemRow item={reviewRequest({ anchorId: null })} reviewClient={reviewClient()} />,
    )
    expect(screen.queryByTestId('inbox-review-actions')).not.toBeInTheDocument()
    unmount()

    // The signature releases a NAMED Fassung: without a subject the confirm
    // could not say which document it releases, so no decisions are offered.
    const { unmount: unmountSecond } = render(
      <InboxItemRow item={reviewRequest({ subject: null })} reviewClient={reviewClient()} />,
    )
    expect(screen.queryByTestId('inbox-review-actions')).not.toBeInTheDocument()
    unmountSecond()

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

describe('InboxItemRow — a new Fassung (document.new_fassung)', () => {
  const newFassung = (overrides: Partial<InboxItemView> = {}) =>
    item({
      type: 'document.new_fassung',
      state: 'unread',
      archived: false,
      actionable: false,
      resourceType: 'document',
      resourceId: 'doc-b',
      anchorId: 'doc-a',
      actorName: 'Anna Weber',
      actorUserId: 'u-anna',
      href: '/app/projects/p1/files?doc=doc-b',
      subject: 'Grundriss EG A',
      related: 'Grundriss EG B',
      excerpt: 'Wand im EG verschoben.',
      ...overrides,
    })

  test('is a sentence about the person who uploaded it, with what changed as its only body', () => {
    render(<InboxItemRow item={newFassung()} />)
    expect(screen.getByText('Anna Weber uploaded a new revision of “Grundriss EG A”')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveTextContent('Wand im EG verschoben.')
    // No sentence above the excerpt repeating that something changed, so the
    // excerpt gets the three lines a phone needs to say what.
    expect(screen.queryByText(/to see what changed/)).not.toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveClass('line-clamp-3')
    expect(screen.getByRole('link', { name: /uploaded a new revision/ })).toHaveAttribute(
      'href',
      '/app/projects/p1/files?doc=doc-b',
    )
  })

  test('reads in German as a sentence about the person', () => {
    renderPlain(
      <I18nProvider initialLocale="de" fixedLocale>
        <InboxItemRow item={newFassung()} />
      </I18nProvider>,
    )
    expect(screen.getByText('Anna Weber hat eine neue Fassung von „Grundriss EG A“ hochgeladen')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-compare-fassungen')).toHaveTextContent('Fassungen vergleichen')
  })

  test('offers „Compare revisions" first, opening the newer document with the comparison against the older', () => {
    const onOpen = vi.fn()
    render(<InboxItemRow item={newFassung()} onOpen={onOpen} />)
    const compare = screen.getByTestId('inbox-compare-fassungen')
    expect(compare).toHaveAttribute('href', '/app/projects/p1/files?doc=doc-b&compare=doc-a')
    expect(compare).toHaveAccessibleName('Compare the new and the older revision of “Grundriss EG A”')
    // „Discuss" stays, after it: the secondary move.
    const discuss = screen.getByTestId('discuss-document')
    expect(compare.compareDocumentPosition(discuss) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(compare)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('says where the change is when there is no excerpt', () => {
    render(<InboxItemRow item={newFassung({ excerpt: null })} />)
    expect(screen.getByText('Open the revision to see what changed.')).toBeInTheDocument()
  })

  test('without a known actor, it does not say „Someone uploaded"', () => {
    render(<InboxItemRow item={newFassung({ actorName: null })} />)
    expect(screen.getByText('New revision of “Grundriss EG A”')).toBeInTheDocument()
    expect(screen.queryByText(/Someone/)).not.toBeInTheDocument()
  })

  test('a same-name version has no second document, so nothing to lay side by side', () => {
    render(<InboxItemRow item={newFassung({ related: null, resourceId: 'doc-a', anchorId: 'ver-2', excerpt: null })} />)
    expect(screen.getByText('Anna Weber uploaded a new revision of “Grundriss EG A”')).toBeInTheDocument()
    expect(screen.queryByText(/Grundriss EG B/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('inbox-compare-fassungen')).not.toBeInTheDocument()
  })

  test('a row the reader can no longer reach names neither document and is not a link', () => {
    render(<InboxItemRow item={newFassung({ href: null, subject: null, related: null, excerpt: null })} />)
    expect(screen.queryByText(/Grundriss EG/)).not.toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

describe('InboxItemRow — what Piloti did, in the reader’s words', () => {
  const onMark = (overrides: Partial<InboxItemView> = {}) =>
    item({
      type: 'piloti.work_done',
      state: 'unread',
      archived: false,
      actionable: false,
      resourceType: 'document',
      resourceId: 'doc-eg',
      anchorId: 'mark-4',
      actorName: null,
      actorUserId: null,
      href: '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4',
      subject: 'Grundriss EG',
      related: '4',
      excerpt: 'Türbreite prüfen',
      variant: null,
      ...overrides,
    })

  const german = (row: InboxItemView) =>
    renderPlain(
      <I18nProvider initialLocale="de" fixedLocale>
        <InboxItemRow item={row} />
      </I18nProvider>,
    )

  test('a finished mark names the mark and the document, says it was for the reader, and what to do', () => {
    german(onMark())
    expect(screen.getByText('Piloti hat Anmerkung 4 in „Grundriss EG“ für Sie bearbeitet')).toBeInTheDocument()
    expect(screen.getByText('Lesen Sie die Antwort im Verlauf der Anmerkung.')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveTextContent('Türbreite prüfen')
    expect(screen.getByTestId('inbox-item-link')).toHaveAttribute('href', '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4')
  })

  test('without a document name it still names the mark, never „Chat ohne Titel“', () => {
    german(onMark({ subject: null }))
    expect(screen.getByText('Piloti hat Anmerkung 4 für Sie bearbeitet')).toBeInTheDocument()
    expect(screen.queryByText(/Chat ohne Titel/)).not.toBeInTheDocument()
  })

  test.each([
    ['budget', /Das Nutzungsbudget ist aufgebraucht\..*Organisation → Nutzung & Budgets/],
    ['busy', /Piloti kam nicht rechtzeitig dazu.*später noch einmal/],
    ['access', /Piloti konnte sich nicht in Ihrem Namen anmelden\./],
    ['error', /Die Bearbeitung brach ab, bevor eine Antwort da war\./],
  ] as const)('a failure says why (%s) and what the reader can do', (variant, body) => {
    german(onMark({ type: 'piloti.work_failed', variant }))
    expect(screen.getByText('Piloti konnte Anmerkung 4 in „Grundriss EG“ nicht bearbeiten')).toBeInTheDocument()
    expect(screen.getByText(body)).toBeInTheDocument()
  })

  test('a failure stored before the reason was kept reads the general sentence', () => {
    german(onMark({ type: 'piloti.work_failed', variant: null }))
    expect(
      screen.getByText('Öffnen Sie die Anmerkung: Bitten Sie Piloti noch einmal darum oder bearbeiten Sie sie selbst.'),
    ).toBeInTheDocument()
  })

  test('a variant the build has no words for reads the type’s general wording', () => {
    german(onMark({ type: 'piloti.work_failed', variant: 'quota_from_the_future' }))
    expect(screen.getByText('Piloti konnte Anmerkung 4 in „Grundriss EG“ nicht bearbeiten')).toBeInTheDocument()
    expect(screen.getByText(/Bitten Sie Piloti noch einmal darum oder bearbeiten Sie sie selbst/)).toBeInTheDocument()
  })

  test('a delegation handed back says the mark is with the reader again', () => {
    german(onMark({ variant: 'assigned' }))
    expect(screen.getByText('Piloti hat Anmerkung 4 in „Grundriss EG“ für Sie bearbeitet')).toBeInTheDocument()
    expect(screen.getByText('Die Anmerkung liegt wieder bei Ihnen.')).toBeInTheDocument()
  })

  test('a Piloti row wears Piloti’s glyph, and a person’s row its type icon', () => {
    const { unmount } = german(onMark())
    expect(document.querySelector('[data-slot="piloti-glyph"]')).not.toBeNull()
    unmount()

    german(onMark({ type: 'annotation.activity', actorName: 'Anna Weber', variant: 'reply' }))
    expect(document.querySelector('[data-slot="piloti-glyph"]')).toBeNull()
  })

  test('a Rückfrage asks the reader, with the question below', () => {
    german(onMark({ type: 'piloti.asks_you', actionable: true, excerpt: 'Ist die Brüstungshöhe hier 1,00 m?' }))
    expect(screen.getByText('Piloti hat eine Rückfrage an Sie zu Anmerkung 4 in „Grundriss EG“')).toBeInTheDocument()
    expect(screen.getByText('Piloti wartet auf Ihre Antwort. Antworten Sie im Verlauf der Anmerkung.')).toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveTextContent('Ist die Brüstungshöhe hier 1,00 m?')
  })

  test('a proposal says what it changes, and that nothing changes until the reader decides', () => {
    german(
      onMark({
        type: 'piloti.proposal_waiting',
        actionable: true,
        resourceType: 'conversation',
        resourceId: 'c1',
        anchorId: 'prop-1',
        href: '/app/projects/p1/chat?session=c1',
        subject: null,
        related: null,
        excerpt: 'Grundriss.pdf, Schnitt.pdf +1',
        variant: 'rename',
      }),
    )
    expect(screen.getByText('Piloti schlägt eine Umbenennung vor')).toBeInTheDocument()
    expect(
      screen.getByText('Der Vorschlag steht im Chat. Übernehmen oder verwerfen Sie ihn dort; bis dahin ändert sich nichts.'),
    ).toBeInTheDocument()
  })

  test('mirrors the meaning in English', () => {
    render(<InboxItemRow item={onMark({ type: 'piloti.work_failed', variant: 'budget' })} />)
    expect(screen.getByText('Piloti could not work on annotation 4 in “Grundriss EG”')).toBeInTheDocument()
    expect(screen.getByText(/The usage budget is used up\./)).toBeInTheDocument()
  })

  test('a redacted row names neither the mark nor why', () => {
    german(onMark({ type: 'piloti.work_failed', href: null, subject: null, related: null, excerpt: null, variant: null }))
    expect(screen.getByText('Piloti konnte eine Anmerkung nicht bearbeiten')).toBeInTheDocument()
    // Not „Dieser Chat …": the row points at a mark in a document.
    expect(screen.getByText('Das ist für Sie nicht mehr verfügbar.')).toBeInTheDocument()
  })
})

describe('InboxItemRow — a colleague’s work on a mark, in the reader’s words', () => {
  const onMark = (overrides: Partial<InboxItemView> = {}) =>
    item({
      type: 'annotation.assigned_to_you',
      state: 'unread',
      archived: false,
      actionable: true,
      resourceType: 'document',
      resourceId: 'doc-eg',
      anchorId: 'mark-4',
      actorName: 'Anna Weber',
      actorUserId: 'u-anna',
      href: '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4',
      subject: 'Grundriss EG',
      related: '4',
      excerpt: 'Türbreite prüfen',
      variant: 'person',
      ...overrides,
    })

  const german = (row: InboxItemView) =>
    renderPlain(
      <I18nProvider initialLocale="de" fixedLocale>
        <InboxItemRow item={row} />
      </I18nProvider>,
    )

  test('being made responsible names who, which mark in which document, and what to do', () => {
    german(onMark())
    expect(screen.getByText('Anna Weber hat Ihnen Anmerkung 4 in „Grundriss EG“ zugewiesen')).toBeInTheDocument()
    expect(
      screen.getByText('Sie sind dafür zuständig. Antworten Sie im Verlauf oder erledigen Sie die Anmerkung.'),
    ).toBeInTheDocument()
    expect(screen.getByTestId('inbox-item-excerpt')).toHaveTextContent('Türbreite prüfen')
    expect(screen.getByTestId('inbox-item-link')).toHaveAttribute('href', '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4')
  })

  test('says Piloti did it for the colleague when Piloti assigned it', () => {
    german(onMark({ variant: 'piloti' }))
    expect(screen.getByText('Piloti hat Ihnen für Anna Weber Anmerkung 4 in „Grundriss EG“ zugewiesen')).toBeInTheDocument()
  })

  test('counts replies on one mark in one row, and reads a read row without „neu“', () => {
    const reply = { type: 'annotation.activity' as const, actionable: false, variant: 'reply', excerpt: 'Ist bestellt.' }
    const { unmount } = german(onMark({ ...reply, count: 1 }))
    expect(screen.getByText('Anna Weber hat zu Anmerkung 4 in „Grundriss EG“ geantwortet')).toBeInTheDocument()
    unmount()

    const many = german(onMark({ ...reply, count: 3 }))
    expect(screen.getByText('3 neue Antworten zu Anmerkung 4 in „Grundriss EG“, zuletzt von Anna Weber')).toBeInTheDocument()
    many.unmount()

    const noName = german(onMark({ ...reply, count: 3, subject: null }))
    expect(screen.getByText('3 neue Antworten zu Anmerkung 4, zuletzt von Anna Weber')).toBeInTheDocument()
    noName.unmount()

    // Piloti's reply carries no person: the title says what arrived, never „Jemand“.
    const piloti = german(onMark({ ...reply, count: 1, actorName: null, actorUserId: null }))
    expect(screen.getByText('Neue Antwort zu Anmerkung 4 in „Grundriss EG“')).toBeInTheDocument()
    piloti.unmount()

    german(onMark({ ...reply, state: 'read', count: 0 }))
    expect(screen.getByText('Antworten zu Anmerkung 4 in „Grundriss EG“')).toBeInTheDocument()
  })

  test.each([
    ['resolved', 'Anna Weber hat Anmerkung 4 in „Grundriss EG“ erledigt'],
    ['dismissed', 'Anna Weber hat Anmerkung 4 in „Grundriss EG“ verworfen'],
    ['reopened', 'Anna Weber hat Anmerkung 4 in „Grundriss EG“ wieder geöffnet'],
  ] as const)('tells the author someone else %s their mark', (variant, title) => {
    german(onMark({ type: 'annotation.activity', actionable: false, variant, count: 2 }))
    expect(screen.getByText(title)).toBeInTheDocument()
  })
})

describe('InboxItemRow — a row about a mark acts on the mark', () => {
  const markRow = (overrides: Partial<InboxItemView> = {}) =>
    item({
      type: 'annotation.assigned_to_you',
      state: 'unread',
      archived: false,
      actionable: true,
      resourceType: 'document',
      resourceId: 'doc-eg',
      anchorId: 'mark-4',
      actorName: 'Anna Weber',
      actorUserId: 'u-anna',
      href: '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4',
      subject: 'Grundriss EG',
      related: '4',
      excerpt: 'Türbreite prüfen',
      variant: null,
      ...overrides,
    })

  const client = (overrides: Partial<InboxMarkClient> = {}): InboxMarkClient => ({
    reply: vi.fn(async () => ({}) as never),
    update: vi.fn(async () => ({}) as never),
    ...overrides,
  })

  test('leads with „Go to annotation“, which opens the mark and marks the row read, and offers no chat about the document', () => {
    const onOpen = vi.fn()
    render(<InboxItemRow item={markRow()} onOpen={onOpen} />)
    const open = screen.getByTestId('inbox-open-mark')
    expect(open).toHaveTextContent('Go to annotation')
    expect(open).toHaveAttribute('href', '/app/projects/p1/files?doc=doc-eg&review=1&mark=mark-4')
    expect(screen.queryByTestId('discuss-document')).not.toBeInTheDocument()
    fireEvent.click(open)
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'i1' }))
  })

  test('answers an assigned mark through the annotations client, and the answered row is read', async () => {
    const marks = client()
    const onOpen = vi.fn()
    render(<InboxItemRow item={markRow()} onOpen={onOpen} markClient={marks} />)
    fireEvent.click(screen.getByTestId('inbox-mark-reply'))
    fireEvent.change(screen.getByLabelText('Your reply to annotation 4'), { target: { value: '  Ist bestellt.  ' } })
    fireEvent.click(screen.getByTestId('inbox-mark-reply-send'))
    await waitFor(() => expect(screen.getByTestId('inbox-mark-outcome')).toHaveTextContent('Reply sent.'))
    expect(marks.reply).toHaveBeenCalledWith('doc-eg', 'mark-4', { body: 'Ist bestellt.' })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('resolves an assigned mark only if it is still open, and says so when someone moved it first', async () => {
    const marks = client({
      update: vi.fn(async () => {
        throw new AnnotationRequestError(409, 'CONFLICT', 'moved')
      }),
    })
    render(<InboxItemRow item={markRow()} markClient={marks} />)
    fireEvent.click(screen.getByTestId('inbox-mark-resolve'))
    await waitFor(() => expect(screen.getByTestId('inbox-mark-outcome')).toHaveTextContent(/Someone changed the annotation first/))
    expect(marks.update).toHaveBeenCalledWith('doc-eg', 'mark-4', { status: 'resolved', expectedStatus: 'open' })
  })

  test('answers Piloti’s question, but does not resolve the mark for it', () => {
    render(<InboxItemRow item={markRow({ type: 'piloti.asks_you', actorName: null, actorUserId: null })} markClient={client()} />)
    expect(screen.getByTestId('inbox-mark-reply')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-mark-resolve')).not.toBeInTheDocument()
  })

  test('news on a mark only opens it: nothing waits on the reader there', () => {
    render(<InboxItemRow item={markRow({ type: 'annotation.activity', actionable: false, variant: 'reply' })} markClient={client()} />)
    expect(screen.getByTestId('inbox-open-mark')).toBeInTheDocument()
    expect(screen.queryByTestId('inbox-mark-reply')).not.toBeInTheDocument()
    expect(screen.queryByTestId('inbox-mark-resolve')).not.toBeInTheDocument()
  })

  test('a resolved or redacted mark row offers no answer', () => {
    const { unmount } = render(<InboxItemRow item={markRow({ state: 'resolved' })} markClient={client()} />)
    expect(screen.queryByTestId('inbox-mark-reply')).not.toBeInTheDocument()
    unmount()
    render(<InboxItemRow item={markRow({ state: 'inert', href: null })} markClient={client()} />)
    expect(screen.queryByTestId('inbox-open-mark')).not.toBeInTheDocument()
    expect(screen.queryByTestId('inbox-mark-reply')).not.toBeInTheDocument()
  })
})

describe('InboxItemRow — who and what at a glance', () => {
  test('a row a person caused wears their face, with the type’s glyph in the corner', () => {
    render(<InboxItemRow item={item()} />)
    expect(screen.getByTestId('person-avatar')).toHaveTextContent('AW')
    expect(screen.getByTestId('inbox-item-type-badge')).toBeInTheDocument()
  })

  test('a system row keeps its glyph, and Piloti’s row keeps Piloti’s face, drawn as a line', () => {
    const { unmount } = render(
      <InboxItemRow item={item({ type: 'storage.quota_warning', actorName: null, actorUserId: null, resourceType: 'organization', href: '/app/organization/storage' })} />,
    )
    expect(screen.queryByTestId('person-avatar')).not.toBeInTheDocument()
    unmount()
    render(<InboxItemRow item={item({ type: 'piloti.work_done', actionable: false, actorName: null, actorUserId: null })} />)
    expect(document.querySelector('[data-slot="piloti-glyph"]')).toHaveAttribute('data-tone', 'outline')
    expect(screen.queryByTestId('person-avatar')).not.toBeInTheDocument()
  })

  test('the line under the title wraps to two lines instead of cutting its sentence', () => {
    render(<InboxItemRow item={item()} />)
    expect(screen.getByText('in Atrium – Rauchabschnitte')).toHaveClass('line-clamp-2', 'whitespace-normal')
  })

  test('a read title steps back in dark mode; an unread one does not', () => {
    const { unmount } = render(<InboxItemRow item={item({ state: 'read' })} />)
    expect(screen.getByTestId('inbox-item-link')).toHaveClass('dark:text-muted-foreground')
    unmount()
    render(<InboxItemRow item={item()} />)
    expect(screen.getByTestId('inbox-item-link')).not.toHaveClass('dark:text-muted-foreground')
  })

  test('the keyboard’s row is marked and ringed', () => {
    render(<InboxItemRow item={item()} focused />)
    const row = screen.getByTestId('inbox-item')
    expect(row).toHaveAttribute('data-focused', 'true')
    expect(row).toHaveClass('ring-2', 'ring-inset')
  })

  test('a filing suggestion says it waits on the file under Dateien, not in a chat', () => {
    renderPlain(
      <I18nProvider initialLocale="de" fixedLocale>
        <InboxItemRow
          item={item({
            type: 'piloti.proposal_waiting',
            actorName: null,
            actorUserId: null,
            resourceType: 'project',
            resourceId: 'p1',
            anchorId: 'prop-1',
            href: '/app/projects/p1/files',
            subject: null,
            excerpt: null,
            variant: 'move',
          })}
        />
      </I18nProvider>,
    )
    expect(
      screen.getByText('Der Vorschlag steht bei der Datei unter Dateien. Übernehmen oder verwerfen Sie ihn dort; bis dahin ändert sich nichts.'),
    ).toBeInTheDocument()
  })
})

describe('InboxItemRow — the row’s menu', () => {
  test('marks an unread row read, and a read row unread', async () => {
    const user = userEvent.setup()
    const onMarkRead = vi.fn()
    const onMarkUnread = vi.fn()
    const { unmount } = render(<InboxItemRow item={item()} onMarkRead={onMarkRead} onMarkUnread={onMarkUnread} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByTestId('inbox-mark-read'))
    expect(onMarkRead).toHaveBeenCalledWith('i1')
    unmount()

    render(<InboxItemRow item={item({ state: 'read' })} onMarkRead={onMarkRead} onMarkUnread={onMarkUnread} />)
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByTestId('inbox-mark-unread'))
    expect(onMarkUnread).toHaveBeenCalledWith('i1')
  })

  test('carries archiving, the only archive control on a phone, where the icon is hidden', async () => {
    const user = userEvent.setup()
    const onArchive = vi.fn()
    render(<InboxItemRow item={item()} onArchive={onArchive} />)
    expect(screen.getByRole('button', { name: 'Archive' })).toHaveClass('max-sm:hidden')
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByTestId('inbox-archive-menu'))
    expect(onArchive).toHaveBeenCalledWith('i1')
  })

  test('an archived row is restored, not archived again', async () => {
    const user = userEvent.setup()
    const onArchive = vi.fn()
    const onUnarchive = vi.fn()
    render(<InboxItemRow item={item({ state: 'archived', archived: true })} onArchive={onArchive} onUnarchive={onUnarchive} />)
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByTestId('inbox-unarchive'))
    expect(onUnarchive).toHaveBeenCalledWith('i1')
    expect(onArchive).not.toHaveBeenCalled()
  })
})

describe('InboxItemRow — an archived row whose target went away', () => {
  test('is restored, never archived again: archived is its own fact, not its state', async () => {
    const user = userEvent.setup()
    const onArchive = vi.fn()
    const onUnarchive = vi.fn()
    render(
      <InboxItemRow
        item={item({ state: 'inert', archived: true, href: null, subject: null, excerpt: null })}
        onArchive={onArchive}
        onUnarchive={onUnarchive}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'More actions' }))
    expect(screen.queryByTestId('inbox-archive-menu')).not.toBeInTheDocument()
    await user.click(await screen.findByTestId('inbox-unarchive'))
    expect(onUnarchive).toHaveBeenCalledWith('i1')
  })
})

describe('InboxItemRow — every way to its target counts as opening it', () => {
  test('„Datei öffnen“ on a review request is a client link that marks the row read', () => {
    const onOpen = vi.fn()
    render(
      <InboxItemRow
        item={item({ type: 'document.review_requested', resourceType: 'document', resourceId: 'doc-7', anchorId: 'ver-7', href: '/app/projects/p1/files?doc=doc-7', subject: 'Befund' })}
        onOpen={onOpen}
        reviewClient={{ approve: vi.fn(), requestChanges: vi.fn(), reject: vi.fn() }}
      />,
    )
    fireEvent.click(screen.getByTestId('inbox-review-open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  test('„Mit Piloti besprechen“ marks the row read, and is an icon with a name on a phone', () => {
    const onOpen = vi.fn()
    render(
      <InboxItemRow
        item={item({ type: 'document.new_fassung', actionable: false, resourceType: 'document', resourceId: 'doc-7', anchorId: 'ver-2', href: '/app/projects/p1/files?doc=doc-7', subject: 'Befund', related: null })}
        onOpen={onOpen}
      />,
    )
    const discuss = screen.getByTestId('discuss-document')
    expect(discuss).toHaveAttribute('aria-label', 'Discuss with Piloti')
    expect(discuss.querySelector('.max-sm\\:hidden')).not.toBeNull()
    fireEvent.click(discuss)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
