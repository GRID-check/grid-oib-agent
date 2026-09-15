/**
 * Einreichen · Freigeben · Veröffentlichen, as the reader meets them.
 *
 * Approval is a liability act with minimum ceremony — never one click, never
 * silent — and Freigabe and Veröffentlichung are two separate acts. What is
 * asserted here is the ceremony itself: that submitting names a reviewer and
 * states its order before the button opens, that approving signs its stand
 * with a checkbox, and that publishing stands apart.
 *
 * Two things this strip used to do are now somebody else's, and the last block
 * pins that it really stopped doing them: the WAITING LINE belongs to
 * `DocumentLifecycleStand` (it has to be said whether or not there are controls,
 * and it used to be said only when there were none), and „Archivieren" belongs
 * to `DocumentArchiveAction` (it is item-level, it is a one-way door, and as a
 * fifth button in this row it was the whole of what a published upload offered).
 */

import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test-utils'
import { formatAbsoluteTime } from '@/lib/format'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import {
  DocumentReviewControls,
  type ReviewerOption,
} from './document-review-controls'

function version(
  state: DocumentVersionState,
  overrides: {
    versionNumber?: number
    updatedAt?: string
    submittedBy?: string | null
  } = {},
) {
  return {
    id: 'ver_2',
    state,
    submittedBy: null,
    versionNumber: 2,
    updatedAt: '2026-09-03T10:15:00.000Z',
    ...overrides,
  }
}

const editor = {
  permissions: ['project:view', 'project:edit'] as const,
  userId: 'user_me',
}

const reviewers: readonly ReviewerOption[] = [
  { userId: 'user_anna', name: 'Anna Berger' },
  { userId: 'user_huber', name: 'DI Huber' },
]

describe('DocumentReviewControls — submitting names its reviewer and its order', () => {
  it('keeps the button shut with its reasons until reviewer and order are set', async () => {
    const onAct = vi.fn()
    render(
      <DocumentReviewControls
        version={version('draft')}
        lifecycle="active"
        viewer={editor}
        onAct={onAct}
        reviewers={reviewers}
      />,
    )

    const submit = screen.getByTestId('document-lifecycle-submit')
    expect(submit).toBeDisabled()
    expect(screen.getByTestId('document-review-submit-hint')).toHaveTextContent(
      'Choose who should review this version.',
    )
    expect(screen.getByTestId('document-review-submit-hint')).toHaveTextContent(
      'State the order in one sentence.',
    )
    expect(onAct).not.toHaveBeenCalled()
  })

  it('sends the named reviewer once both are set', async () => {
    const onAct = vi.fn()
    render(
      <DocumentReviewControls
        version={version('draft')}
        lifecycle="active"
        viewer={editor}
        onAct={onAct}
        reviewers={reviewers}
      />,
    )

    await userEvent.click(screen.getByTestId('document-review-reviewer'))
    await userEvent.click(await screen.findByRole('option', { name: 'DI Huber' }))
    await userEvent.type(
      screen.getByTestId('document-review-order'),
      'Bitte die Fluchtweglänge prüfen.',
    )

    const submit = screen.getByTestId('document-lifecycle-submit')
    expect(submit).toBeEnabled()
    expect(screen.queryByTestId('document-review-submit-hint')).not.toBeInTheDocument()
    await userEvent.click(submit)

    expect(onAct).toHaveBeenCalledWith('submit', {
      reviewerUserIds: ['user_huber'],
      orderMessage: 'Bitte die Fluchtweglänge prüfen.',
    })
  })

  it('records a sole editor as a self-review instead of asking who', async () => {
    // Nobody to choose between: the wire's own waiver, stated rather than
    // silent — and the order still gates the button.
    const onAct = vi.fn()
    render(
      <DocumentReviewControls
        version={version('draft')}
        lifecycle="active"
        viewer={editor}
        onAct={onAct}
        reviewers={[]}
      />,
    )

    expect(screen.queryByTestId('document-review-reviewer')).not.toBeInTheDocument()
    expect(screen.getByTestId('document-review-submit-note')).toHaveTextContent('self-review')

    const submit = screen.getByTestId('document-lifecycle-submit')
    expect(submit).toBeDisabled()
    await userEvent.type(screen.getByTestId('document-review-order'), 'Bitte prüfen.')
    expect(submit).toBeEnabled()
    await userEvent.click(submit)

    expect(onAct).toHaveBeenCalledWith('submit', { orderMessage: 'Bitte prüfen.' })
  })
})

describe('DocumentReviewControls — approving signs its stand', () => {
  const inReview = () => version('in_review', { submittedBy: 'user_anna' })

  it('opens the signature instead of releasing on the click', async () => {
    const onAct = vi.fn()
    render(
      <DocumentReviewControls
        version={inReview()}
        lifecycle="active"
        viewer={editor}
        onAct={onAct}
        actingName="DI Huber"
      />,
    )

    await userEvent.click(screen.getByTestId('document-lifecycle-approve'))
    expect(onAct).not.toHaveBeenCalled()

    // The act names its Geltungsstand: which version, as of when.
    const stand = screen.getByTestId('document-review-approve-stand')
    expect(stand).toHaveTextContent('Version 2')
    expect(stand).toHaveTextContent(formatAbsoluteTime('2026-09-03T10:15:00.000Z', 'en'))
    // …the acting person and the moment…
    const acting = screen.getByTestId('document-review-approve-acting')
    expect(acting).toHaveTextContent('DI Huber')
    // …and the signature itself, still unsigned.
    expect(screen.getByRole('checkbox', { name: 'I release this version' })).not.toBeChecked()
    expect(screen.getByTestId('document-review-approve-send')).toBeDisabled()
  })

  it('releases once the stand is signed', async () => {
    const onAct = vi.fn()
    render(
      <DocumentReviewControls
        version={inReview()}
        lifecycle="active"
        viewer={editor}
        onAct={onAct}
        actingName="DI Huber"
      />,
    )

    await userEvent.click(screen.getByTestId('document-lifecycle-approve'))
    await userEvent.click(screen.getByRole('checkbox', { name: 'I release this version' }))
    expect(screen.getByTestId('document-review-approve-send')).toBeEnabled()
    await userEvent.click(screen.getByTestId('document-review-approve-send'))

    expect(onAct).toHaveBeenCalledWith('approve')
    expect(screen.queryByTestId('document-review-approve-confirm')).not.toBeInTheDocument()
  })

  it('states the moment without inventing a name', async () => {
    // The surface does not always know the viewer's display name; the line
    // then carries the date alone — never a raw user id.
    const onAct = vi.fn()
    render(
      <DocumentReviewControls
        version={inReview()}
        lifecycle="active"
        viewer={editor}
        onAct={onAct}
      />,
    )

    await userEvent.click(screen.getByTestId('document-lifecycle-approve'))
    const acting = screen.getByTestId('document-review-approve-acting')
    expect(acting.textContent).not.toContain('user_me')
    expect(acting.textContent?.trim()).not.toBe('')
  })
})

describe('DocumentReviewControls — publishing is its own act', () => {
  it('stands apart from approval with its target stated', () => {
    const onAct = vi.fn()
    const { container } = render(
      <DocumentReviewControls
        version={version('approved')}
        lifecycle="active"
        viewer={{
          permissions: ['project:view', 'project:documents:write'],
          userId: 'user_me',
        }}
        onAct={onAct}
      />,
    )

    const section = screen.getByTestId('document-review-publish')
    expect(section).toHaveTextContent('Publication')
    expect(section).toHaveTextContent('submission set / authority')
    expect(section).toHaveTextContent('version 2')
    // Its own section, visually cut off from the row above it.
    expect(section.className).toContain('border-t')
    // …and never a button in the row beside the other gestures. On `approved`
    // there is now no row at all: publish owns its section, and „Archivieren"
    // — which used to be the row's sole occupant here — has its own block.
    const row = container.querySelector('[data-testid="document-review-controls"] > div.flex')
    expect(row).toBeNull()
  })
})

describe('DocumentReviewControls — it draws review decisions and nothing else', () => {
  const viewOnly = { permissions: ['project:view'] as const, userId: 'user_me' }
  const writer = {
    permissions: ['project:view', 'project:documents:write'] as const,
    userId: 'user_me',
  }

  it('renders nothing where the reader has no decision to take', () => {
    const { container } = render(
      <DocumentReviewControls
        version={version('in_review', { submittedBy: 'user_anna' })}
        lifecycle="active"
        viewer={viewOnly}
        onAct={() => undefined}
      />,
    )

    // Not an empty bordered strip and not a waiting line: the stand one tier up
    // says what the version waits for, and saying it twice reads as two facts.
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByTestId('document-review-waiting')).not.toBeInTheDocument()
  })

  it('does not draw Archivieren in the decision row', () => {
    // The reported case: a published upload. The only gesture the old row could
    // offer was „Archivieren", so every ordinary file in the project showed one
    // unexplained verb under a heading about approvals.
    const { container } = render(
      <DocumentReviewControls
        version={version('published')}
        lifecycle="active"
        viewer={writer}
        onAct={() => undefined}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
    expect(container).toBeEmptyDOMElement()
  })
})
