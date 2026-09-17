/**
 * Where the document stands, said unconditionally.
 *
 * The line this covers used to live inside the control strip and render only
 * when that strip had NOTHING to offer — so the states a reader could act on,
 * and the published upload whose one control was „Archivieren", both got a verb
 * and no sentence. What is asserted here is that the sentence is now always
 * there, and that the track beside it puts the state's word in an order rather
 * than leaving it as a label the reader had to have been taught.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import type { DocumentVersionState } from '@/lib/documents/lifecycle-types'
import { DocumentLifecycleStand } from './document-lifecycle-stand'

function version(state: DocumentVersionState, submittedBy: string | null = null) {
  return { state, submittedBy }
}

const names: Record<string, string> = { user_anna: 'Anna Berger' }
const nameOf = (userId: string | null): string =>
  userId ? (names[userId] ?? 'Someone') : 'Someone'

describe('DocumentLifecycleStand — the sentence', () => {
  it('names the submitter the approval is waited on', () => {
    render(
      <DocumentLifecycleStand
        version={version('in_review', 'user_anna')}
        lifecycle="active"
        nameOf={nameOf}
      />,
    )

    const waiting = screen.getByTestId('document-review-waiting')
    expect(waiting).toHaveTextContent('In review')
    expect(waiting).toHaveTextContent('Anna Berger')
  })

  it('states finality on a state nothing leaves', () => {
    render(
      <DocumentLifecycleStand version={version('published')} lifecycle="active" nameOf={nameOf} />,
    )

    expect(screen.getByTestId('document-review-waiting')).toHaveTextContent('Published')
  })

  it('lets the item win over the version once it is retired', () => {
    // „Stillgelegt" is a statement about the FILE. Which version was live when
    // it left the working set is not the question somebody who found it anyway
    // is asking. And it is NOT „archived": the Archiv is where a document goes
    // to become office knowledge, which is the opposite of this.
    render(
      <DocumentLifecycleStand version={version('published')} lifecycle="archived" nameOf={nameOf} />,
    )

    expect(screen.getByTestId('document-review-waiting')).toHaveTextContent('Retired')
  })
})

describe('DocumentLifecycleStand — the track', () => {
  it('fills one segment per stage the document has walked', () => {
    render(
      <DocumentLifecycleStand version={version('approved')} lifecycle="active" nameOf={nameOf} />,
    )

    const track = screen.getByTestId('document-lifecycle-track')
    expect(track).toHaveAttribute('data-reached', '3')
    expect(track.querySelectorAll('[data-done]')).toHaveLength(3)
    // Four segments, always: the stages are the model, not a bar that grows.
    expect(track.children).toHaveLength(4)
  })

  it('marks a sent-back version as stopped rather than as still walking', () => {
    render(
      <DocumentLifecycleStand
        version={version('changes_requested')}
        lifecycle="active"
        nameOf={nameOf}
      />,
    )

    const track = screen.getByTestId('document-lifecycle-track')
    // Back at the draft it came from — one segment, and halted.
    expect(track).toHaveAttribute('data-reached', '1')
    expect(track).toHaveAttribute('data-halted', 'true')
  })

  it('says nothing to a screen reader that the sentence does not', () => {
    render(<DocumentLifecycleStand version={version('draft')} lifecycle="active" nameOf={nameOf} />)

    expect(screen.getByTestId('document-lifecycle-track')).toHaveAttribute('aria-hidden', 'true')
  })
})
