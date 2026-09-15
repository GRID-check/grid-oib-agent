/**
 * The version history as the reader meets it, at the component level.
 *
 * A lone version collapses to its stand — no „Versionen" header, no one-row
 * list, no counter — and a refusal leaves a milestone with who and when.
 * Refusals used to leave none: only submitted/approved/published stamped a
 * row, so a version sent back showed the reviewer's words with no record of
 * the act itself.
 *
 * The who/when of a refusal lives in the generic review columns
 * (`reviewedBy`/`reviewedAt`), which an approval stamps too — so the refusal
 * row is gated on the version's state, and an approved version must never
 * render one.
 *
 * Renders without an `I18nProvider`, so the dictionary falls back to `en`
 * (`src/i18n/context.tsx`) and the strings asserted below are the English ones.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@/test-utils'
import type { DocumentVersionState, DocumentVersionView } from '@/lib/documents/lifecycle-types'
import { DocumentVersionList } from './document-version-list'

function makeVersion(
  versionNumber: number,
  state: DocumentVersionState,
  overrides: Partial<DocumentVersionView> = {},
): DocumentVersionView {
  return {
    id: `ver_${versionNumber}`,
    documentId: 'doc_1',
    versionNumber,
    state,
    contentType: 'text/markdown',
    fileSize: 1200,
    contentHash: 'sha256:abc',
    submittedBy: null,
    submittedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    approvedBy: null,
    approvedAt: null,
    publishedBy: null,
    publishedAt: null,
    reviewComment: null,
    createdBy: 'user_author',
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  }
}

const propsOf = (
  versions: readonly DocumentVersionView[],
  overrides: Partial<Parameters<typeof DocumentVersionList>[0]> = {},
) => ({
  documentId: 'doc_1',
  versions,
  publishedVersionId: null as string | null,
  names: { user_author: 'Anna Berger', user_reviewer: 'Clara Schmid' },
  onCompare: vi.fn(() => Promise.reject(new Error('not stubbed'))),
  ...overrides,
})

describe('DocumentVersionList — a lone version is a stand line, not a list', () => {
  it('collapses one version: no header, no row, no counter', () => {
    render(
      <DocumentVersionList
        {...propsOf([
          makeVersion(1, 'in_review', {
            submittedBy: 'user_author',
            submittedAt: '2026-09-02T09:00:00.000Z',
          }),
        ])}
      />,
    )

    expect(screen.getByTestId('document-version-state-line')).toBeInTheDocument()
    expect(screen.queryByText('Versions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('document-version-row')).not.toBeInTheDocument()
    const line = screen.getByTestId('document-version-state-line')
    // The acts, and only the acts. Not „Fassung 1", and not the STATE either:
    // the panel's stand says that twice already — once as the badge on the
    // section's row, once as the sentence under the track — and a third copy
    // stops reading as the same fact.
    expect(line).toHaveTextContent('Submitted')
    expect(line).toHaveTextContent('Anna Berger')
    expect(line).not.toHaveTextContent('Version 1')
    expect(line).not.toHaveTextContent('In review')
  })

  it('names the refusal on a lone version sent back, with who and when', () => {
    render(
      <DocumentVersionList
        {...propsOf([
          makeVersion(1, 'changes_requested', {
            submittedBy: 'user_author',
            submittedAt: '2026-09-02T09:00:00.000Z',
            reviewedBy: 'user_reviewer',
            reviewedAt: '2026-09-03T10:00:00.000Z',
            reviewComment: 'Bitte die Fluchtweglänge ergänzen.',
          }),
        ])}
      />,
    )

    const line = screen.getByTestId('document-version-state-line')
    expect(line).toHaveTextContent('Changes requested')
    expect(line).toHaveTextContent('Clara Schmid')
    expect(screen.getByTestId('document-version-comment')).toHaveTextContent(
      'Bitte die Fluchtweglänge ergänzen.',
    )
  })

  it('names a rejection the same way', () => {
    render(
      <DocumentVersionList
        {...propsOf([
          makeVersion(1, 'rejected', {
            submittedBy: 'user_author',
            submittedAt: '2026-09-02T09:00:00.000Z',
            reviewedBy: 'user_reviewer',
            reviewedAt: '2026-09-03T10:00:00.000Z',
            reviewComment: 'Außerhalb des Auftrags.',
          }),
        ])}
      />,
    )

    const line = screen.getByTestId('document-version-state-line')
    expect(line).toHaveTextContent('Rejected')
    expect(line).toHaveTextContent('Clara Schmid')
  })
})

describe('DocumentVersionList — refusals leave milestones in the full list', () => {
  it('rows who sent a version back and when, beside the submission', () => {
    render(
      <DocumentVersionList
        {...propsOf([
          makeVersion(1, 'superseded'),
          makeVersion(2, 'changes_requested', {
            submittedBy: 'user_author',
            submittedAt: '2026-09-02T09:00:00.000Z',
            reviewedBy: 'user_reviewer',
            reviewedAt: '2026-09-03T10:00:00.000Z',
            reviewComment: 'Bitte die Fluchtweglänge ergänzen.',
          }),
        ])}
      />,
    )

    const rows = screen.getAllByTestId('document-version-row')
    expect(rows).toHaveLength(2)
    // Twice, on purpose: the row's state badge AND its milestone line carry
    // the same word, from the same mapping.
    expect(within(rows[0]).getAllByText('Changes requested')).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Clara Schmid')
    expect(rows[0]).toHaveTextContent('Submitted')
  })

  it('rows a rejection with who and when', () => {
    render(
      <DocumentVersionList
        {...propsOf([
          makeVersion(1, 'superseded'),
          makeVersion(2, 'rejected', {
            submittedBy: 'user_author',
            submittedAt: '2026-09-02T09:00:00.000Z',
            reviewedBy: 'user_reviewer',
            reviewedAt: '2026-09-03T10:00:00.000Z',
            reviewComment: 'Außerhalb des Auftrags.',
          }),
        ])}
      />,
    )

    const rows = screen.getAllByTestId('document-version-row')
    expect(rows[0]).toHaveTextContent('Rejected')
    expect(rows[0]).toHaveTextContent('Clara Schmid')
  })

  it('never renders a refusal row for an approval — the same columns, a different act', () => {    // Approving stamps `reviewedBy`/`reviewedAt` too. Without the state gate
    // every approval would read as a refusal beside its own milestone.
    render(
      <DocumentVersionList
        {...propsOf([
          makeVersion(1, 'superseded'),
          makeVersion(2, 'approved', {
            submittedBy: 'user_author',
            submittedAt: '2026-09-02T09:00:00.000Z',
            reviewedBy: 'user_reviewer',
            reviewedAt: '2026-09-03T10:00:00.000Z',
            approvedBy: 'user_reviewer',
            approvedAt: '2026-09-03T10:00:00.000Z',
          }),
        ])}
      />,
    )

    expect(screen.queryByText('Changes requested')).not.toBeInTheDocument()
    expect(screen.queryByText('Rejected')).not.toBeInTheDocument()
    expect(screen.getAllByTestId('document-version-row')[0]).toHaveTextContent('Approved')
  })
})

describe('DocumentVersionList — past the old 200-version page', () => {
  // The repository page used to end at 200 rows, and the diff base was found
  // by scanning that page — past 200 versions the predecessor named was the
  // top of the window, not the true one. The cap is raised since, but the
  // component's half of the contract stands on its own: whatever page arrives
  // renders newest-first, and every compare pairs a version with its TRUE
  // predecessor, at any depth.
  const many = (count: number): DocumentVersionView[] =>
    Array.from({ length: count }, (_, index) =>
      makeVersion(index + 1, index === count - 1 ? 'published' : 'superseded'),
    )

  it('renders every row newest-first past 200, each compare naming the true predecessor', async () => {
    const onCompare = vi.fn(() => Promise.reject(new Error('not stubbed')))
    // Fed ascending, like the repository page — the list still leads newest.
    render(<DocumentVersionList {...propsOf(many(250), { onCompare })} />)

    const rows = screen.getAllByTestId('document-version-row')
    expect(rows).toHaveLength(250)
    expect(rows[0]).toHaveAttribute('data-version', '250')
    expect(rows[rows.length - 1]).toHaveAttribute('data-version', '1')

    // The newest row compares against 249 — not against the top of a window.
    const newestCompare = within(rows[0]).getByTestId('document-version-compare')
    expect(newestCompare).toHaveTextContent('Compare with 249')
    fireEvent.click(newestCompare)
    await screen.findByTestId('document-version-compare-failed')
    expect(onCompare).toHaveBeenCalledWith('ver_249', 'ver_250')

    // The oldest row has no predecessor, so no compare affordance.
    expect(
      within(rows[rows.length - 1]).queryByTestId('document-version-compare'),
    ).toBeNull()
  })
})
