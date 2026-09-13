/**
 * Freigabe und Fassungen, as the reader meets it.
 *
 * The controls' visibility per state and permission is proved in
 * `../lib/document-lifecycle.spec.ts`, over the transition table itself. What is
 * asserted here is the part only a mounted panel can show: that the pane renders
 * those controls, that a refusal cannot be sent without words, that a lost race
 * says so and re-reads, that the history is legible — and that a lone version
 * collapses to its stand rather than a one-row list.
 */

import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test-utils'
import { DocumentLifecycleError } from '@/lib/documents/lifecycle-client'
import type { DocumentLifecycleClient } from '@/lib/documents/lifecycle-client'
import type {
  DocumentVersionListResponse,
  DocumentVersionState,
  DocumentVersionView,
} from '@/lib/documents/lifecycle-types'
import { DocumentLifecyclePanel } from './document-lifecycle-panel'

const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

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

function listing(
  versions: readonly DocumentVersionView[],
  overrides: Partial<DocumentVersionListResponse> = {},
): DocumentVersionListResponse {
  return {
    documentId: 'doc_1',
    lifecycle: 'active',
    publishedVersionId: versions.find((v) => v.state === 'published')?.id ?? null,
    versions: [...versions],
    ...overrides,
  }
}

/** A client double: every method present, only the ones a test needs behaving. */
function fakeClient(overrides: Partial<DocumentLifecycleClient> = {}): DocumentLifecycleClient {
  const unexpected = () => Promise.reject(new Error('not stubbed'))
  return {
    listVersions: unexpected,
    getVersion: unexpected,
    forkDraft: unexpected,
    replaceContent: unexpected,
    submit: unexpected,
    approve: unexpected,
    requestChanges: unexpected,
    reject: unexpected,
    publish: unexpected,
    archive: unexpected,
    diff: unexpected,
    ...overrides,
  } as DocumentLifecycleClient
}

const reviewer = {
  permissions: ['project:view', 'project:edit'] as const,
  userId: 'user_reviewer',
}

describe('DocumentLifecyclePanel — what the state allows', () => {
  it('offers the three decisions on a version in review', async () => {
    const client = fakeClient({
      listVersions: () => Promise.resolve(listing([makeVersion(1, 'in_review')])),
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument()
  })

  it('shows a reader with only project:view the wait instead of no controls at all', async () => {
    const client = fakeClient({
      listVersions: () =>
        Promise.resolve(
          listing([makeVersion(1, 'in_review', { submittedBy: 'user_author' })]),
        ),
    })
    render(
      <DocumentLifecyclePanel
        documentId="doc_1"
        viewer={{ permissions: ['project:view'], userId: 'user_x' }}
        names={{ user_author: 'Anna Berger' }}
        client={client}
      />,
    )

    expect(await screen.findByTestId('document-lifecycle-panel')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    // No gesture for this reader is a muted line, never nothing: what the
    // version waits for, and who submitted it.
    const waiting = screen.getByTestId('document-review-waiting')
    expect(waiting).toHaveTextContent('In review')
    expect(waiting).toHaveTextContent('Anna Berger')
  })

  it('shows the state as a badge even for a document whose card carries none', async () => {
    // The pane is the surface whose subject IS the state, so a single published
    // upload gets the word here and stays quiet in the listing.
    const client = fakeClient({
      listVersions: () => Promise.resolve(listing([makeVersion(1, 'published')])),
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    expect(await screen.findByTestId('document-lifecycle-state')).toHaveTextContent('Published')
  })
})

describe('DocumentLifecyclePanel — a refusal carries words', () => {
  it('will not send Änderungen anfordern until something is typed', async () => {
    const requestChanges = vi.fn().mockResolvedValue(makeVersion(1, 'changes_requested'))
    const client = fakeClient({
      listVersions: () => Promise.resolve(listing([makeVersion(1, 'in_review')])),
      requestChanges,
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Request changes' }))
    const send = screen.getByTestId('document-review-comment-send')
    expect(send).toBeDisabled()
    expect(requestChanges).not.toHaveBeenCalled()

    await userEvent.type(screen.getByRole('textbox'), 'Die Fluchtweglänge fehlt.')
    expect(send).toBeEnabled()
    await userEvent.click(send)

    await waitFor(() =>
      expect(requestChanges).toHaveBeenCalledWith('doc_1', 'ver_1', 'Die Fluchtweglänge fehlt.'),
    )
  })

  it('offers „Piloti überarbeiten lassen" wherever Änderungen anfordern is offered', async () => {
    // Same transition, so same condition: there is no second permission and no
    // fourth op — the button beside it either both appear or neither does.
    const client = fakeClient({
      listVersions: () => Promise.resolve(listing([makeVersion(1, 'in_review')])),
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    expect(await screen.findByRole('button', { name: 'Request changes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Have Piloti revise it' })).toBeInTheDocument()
  })

  it('will not delegate the revision until something is typed either', async () => {
    const requestChanges = vi.fn().mockResolvedValue(makeVersion(1, 'changes_requested'))
    const client = fakeClient({
      listVersions: () => Promise.resolve(listing([makeVersion(1, 'in_review')])),
      requestChanges,
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Have Piloti revise it' }))
    // What the extra button DOES, said where the reviewer is deciding.
    expect(screen.getByTestId('document-review-delegate-note')).toBeInTheDocument()
    const send = screen.getByTestId('document-review-comment-send')
    expect(send).toBeDisabled()
    expect(requestChanges).not.toHaveBeenCalled()

    await userEvent.type(screen.getByRole('textbox'), 'Bitte Tabelle 3 neu rechnen.')
    await userEvent.click(send)

    // The same route as „Änderungen anfordern", with the one field that asks
    // Piloti to write the next draft (ADR-0054).
    await waitFor(() =>
      expect(requestChanges).toHaveBeenCalledWith(
        'doc_1',
        'ver_1',
        'Bitte Tabelle 3 neu rechnen.',
        true,
      ),
    )
  })

  it('releases Freigeben only once the stand is signed', async () => {
    const approve = vi.fn().mockResolvedValue(makeVersion(1, 'approved'))
    const client = fakeClient({
      listVersions: () => Promise.resolve(listing([makeVersion(1, 'in_review')])),
      approve,
    })
    render(
      <DocumentLifecyclePanel
        documentId="doc_1"
        viewer={reviewer}
        names={{ user_reviewer: 'DI Huber' }}
        client={client}
      />,
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    // Never one click: the press opens the signature, it does not release.
    expect(approve).not.toHaveBeenCalled()
    expect(screen.getByTestId('document-review-approve-stand')).toHaveTextContent('Version 1')
    expect(screen.getByTestId('document-review-approve-acting')).toHaveTextContent('DI Huber')
    const send = screen.getByTestId('document-review-approve-send')
    expect(send).toBeDisabled()

    await userEvent.click(screen.getByRole('checkbox', { name: 'I release this version' }))
    await userEvent.click(send)

    await waitFor(() => expect(approve).toHaveBeenCalledWith('doc_1', 'ver_1', undefined))
    expect(screen.queryByTestId('document-review-comment')).not.toBeInTheDocument()
  })
})

describe('DocumentLifecyclePanel — the compare-and-swap lost', () => {
  it('says the stand has moved and re-reads it', async () => {
    const approve = vi
      .fn()
      .mockRejectedValue(new DocumentLifecycleError(409, 'CONFLICT', 'state changed'))
    const listVersions = vi
      .fn()
      .mockResolvedValueOnce(listing([makeVersion(1, 'in_review')]))
      .mockResolvedValue(listing([makeVersion(1, 'approved', { approvedBy: 'user_other' })]))
    const client = fakeClient({ listVersions, approve })

    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'I release this version' }))
    await userEvent.click(screen.getByTestId('document-review-approve-send'))

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('This has moved on — reloading the current state.'),
    )
    // Re-read, not patched: what the reader sees next is the server's answer.
    await waitFor(() => expect(listVersions).toHaveBeenCalledTimes(2))
    expect(await screen.findByTestId('document-lifecycle-state')).toHaveTextContent('Approved')
  })

  it('puts the row back when the request fails for any other reason', async () => {
    const client = fakeClient({
      listVersions: () => Promise.resolve(listing([makeVersion(1, 'in_review')])),
      approve: () => Promise.reject(new DocumentLifecycleError(500, 'INTERNAL', 'boom')),
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'I release this version' }))
    await userEvent.click(screen.getByTestId('document-review-approve-send'))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // The optimistic „Freigegeben" is gone again; the version is where it was.
    expect(await screen.findByTestId('document-lifecycle-state')).toHaveTextContent('In review')
  })
})

describe('DocumentLifecyclePanel — submitting states its order', () => {
  it('keeps Einreichen shut until the order is stated', async () => {
    const submit = vi.fn().mockResolvedValue(makeVersion(1, 'in_review'))
    const client = fakeClient({
      listVersions: () => Promise.resolve(listing([makeVersion(1, 'draft')])),
      submit,
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    const send = await screen.findByTestId('document-lifecycle-submit')
    expect(send).toBeDisabled()
    expect(submit).not.toHaveBeenCalled()

    await userEvent.type(screen.getByTestId('document-review-order'), 'Bitte prüfen.')
    expect(send).toBeEnabled()
    await userEvent.click(send)

    // No candidates in this tree, so the round falls back to the wire's own
    // waiver rather than reaching nobody — and the stated order rides the call
    // into the round's inbox payload.
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith('doc_1', 'ver_1', undefined, {
        orderMessage: 'Bitte prüfen.',
        dueAt: undefined,
      }),
    )
  })
})

describe('DocumentLifecyclePanel — publishing is its own act', () => {
  it('publishes from its own section, never beside approval', async () => {
    const publish = vi.fn().mockResolvedValue(makeVersion(1, 'published'))
    const client = fakeClient({
      listVersions: () => Promise.resolve(listing([makeVersion(1, 'approved')])),
      publish,
    })
    render(
      <DocumentLifecyclePanel
        documentId="doc_1"
        viewer={{ permissions: ['project:view', 'project:documents:write'], userId: 'user_x' }}
        client={client}
      />,
    )

    const section = await screen.findByTestId('document-review-publish')
    expect(section).toHaveTextContent('submission set / authority')
    await userEvent.click(screen.getByTestId('document-lifecycle-publish'))

    await waitFor(() => expect(publish).toHaveBeenCalledWith('doc_1', 'ver_1'))
  })
})

describe('DocumentLifecyclePanel — the version list', () => {
  it('names every version, who acted and when, and the reviewer’s words', async () => {
    const client = fakeClient({
      listVersions: () =>
        Promise.resolve(
          listing([
            makeVersion(1, 'superseded'),
            makeVersion(2, 'changes_requested', {
              submittedBy: 'user_author',
              submittedAt: '2026-09-02T09:00:00.000Z',
              reviewComment: 'Bitte die Fluchtweglänge ergänzen.',
            }),
          ]),
        ),
    })
    render(
      <DocumentLifecyclePanel
        documentId="doc_1"
        viewer={reviewer}
        names={{ user_author: 'Anna Berger' }}
        client={client}
      />,
    )

    const rows = await screen.findAllByTestId('document-version-row')
    // Newest first: „was ist gerade los" is the question a version list is
    // opened with.
    expect(rows.map((row) => row.dataset.version)).toEqual(['2', '1'])
    expect(screen.getByTestId('document-version-comment')).toHaveTextContent(
      'Bitte die Fluchtweglänge ergänzen.',
    )
    expect(rows[0]).toHaveTextContent('Anna Berger')
    expect(screen.getAllByTestId('document-version-open')[0]).toHaveAttribute(
      'href',
      '/api/documents/doc_1/versions/ver_2/content',
    )
  })

  it('opens the published version through the document’s own file route', async () => {
    // Its bytes ARE the document's bytes — the item mirrors them — so the route
    // that knows the content type serves it.
    const client = fakeClient({
      listVersions: () =>
        Promise.resolve(listing([makeVersion(1, 'superseded'), makeVersion(2, 'published')])),
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    // Newest first, so the published row stands above the superseded one.
    const opens = await screen.findAllByTestId('document-version-open')
    expect(opens).toHaveLength(2)
    expect(opens[0]).toHaveAttribute('href', '/api/documents/doc_1/file')
    expect(opens[1]).toHaveAttribute('href', '/api/documents/doc_1/versions/ver_1/content')
  })

  it('marks what changed between the two versions', async () => {
    const diff = vi.fn().mockResolvedValue({
      from: { version: makeVersion(1, 'superseded'), content: 'alte Fassung' },
      to: { version: makeVersion(2, 'published'), content: 'neue Fassung' },
    })
    const client = fakeClient({
      listVersions: () =>
        Promise.resolve(listing([makeVersion(1, 'superseded'), makeVersion(2, 'published')])),
      diff,
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    await userEvent.click((await screen.findAllByTestId('document-version-compare'))[0])

    await waitFor(() => expect(diff).toHaveBeenCalledWith('doc_1', 'ver_1', 'ver_2'))
    const comparison = await screen.findByTestId('document-version-comparison')
    expect(comparison).toHaveTextContent('alte Fassung')
    expect(comparison).toHaveTextContent('neue Fassung')
    // A real diff now, not two texts beside each other: the old line is marked
    // removed, the new one added, and the count says so.
    expect(comparison).toHaveTextContent('1 line added')
    expect(comparison).toHaveTextContent('1 line removed')
    const kinds = within(comparison)
      .getAllByTestId('document-version-diff-row')
      .map((row) => row.getAttribute('data-kind'))
    expect(kinds).toEqual(['removed', 'added'])
  })

  it('keeps the list when a comparison fails', async () => {
    const client = fakeClient({
      listVersions: () =>
        Promise.resolve(listing([makeVersion(1, 'superseded'), makeVersion(2, 'published')])),
      diff: () => Promise.reject(new Error('nope')),
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    await userEvent.click((await screen.findAllByTestId('document-version-compare'))[0])

    expect(await screen.findByTestId('document-version-compare-failed')).toBeInTheDocument()
    expect(screen.getAllByTestId('document-version-row')).toHaveLength(2)
  })
})

describe('DocumentLifecyclePanel — a lone version is a state line, not a list', () => {
  it('collapses one version to its stand: no header, no row, no counter', async () => {
    const client = fakeClient({
      listVersions: () =>
        Promise.resolve(
          listing([
            makeVersion(1, 'in_review', {
              submittedBy: 'user_author',
              submittedAt: '2026-09-02T09:00:00.000Z',
            }),
          ]),
        ),
    })
    render(
      <DocumentLifecyclePanel
        documentId="doc_1"
        viewer={reviewer}
        names={{ user_author: 'Anna Berger' }}
        client={client}
      />,
    )

    expect(await screen.findByTestId('document-version-state-line')).toBeInTheDocument()
    // No „Versionen" header and no one-row list around it.
    expect(screen.queryByText('Versions')).not.toBeInTheDocument()
    expect(screen.queryByTestId('document-version-row')).not.toBeInTheDocument()
    // The stand: the state, who moved it and when — never a „Version 1".
    const line = screen.getByTestId('document-version-state-line')
    expect(line).toHaveTextContent('In review')
    expect(line).toHaveTextContent('Anna Berger')
    expect(line).not.toHaveTextContent('Version 1')
    // Nothing to compare against and nowhere to open from: the document the
    // rail hangs off is already open beside it.
    expect(screen.queryByTestId('document-version-open')).not.toBeInTheDocument()
    expect(screen.queryByTestId('document-version-compare')).not.toBeInTheDocument()
  })

  it('marks the lone version current when it is the published one', async () => {
    const client = fakeClient({
      listVersions: () => Promise.resolve(listing([makeVersion(1, 'published')])),
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    const line = await screen.findByTestId('document-version-state-line')
    expect(line).toHaveTextContent('Published')
    expect(line).toHaveTextContent('Current')
  })

  it('keeps the reviewer’s words on the lone version they are about', async () => {
    const client = fakeClient({
      listVersions: () =>
        Promise.resolve(
          listing([
            makeVersion(1, 'changes_requested', {
              reviewComment: 'Bitte die Fluchtweglänge ergänzen.',
            }),
          ]),
        ),
    })
    render(<DocumentLifecyclePanel documentId="doc_1" viewer={reviewer} client={client} />)

    expect(await screen.findByTestId('document-version-comment')).toHaveTextContent(
      'Bitte die Fluchtweglänge ergänzen.',
    )
  })
})

describe('DocumentLifecyclePanel — archive', () => {
  it('archives the item and tells the listing behind it', async () => {
    const archive = vi.fn().mockResolvedValue({ documentId: 'doc_1', lifecycle: 'archived' })
    const client = fakeClient({
      listVersions: vi
        .fn()
        .mockResolvedValueOnce(listing([makeVersion(1, 'published')]))
        .mockResolvedValue(listing([makeVersion(1, 'published')], { lifecycle: 'archived' })),
      archive,
    })
    const onChanged = vi.fn()
    render(
      <DocumentLifecyclePanel
        documentId="doc_1"
        viewer={{ permissions: ['project:view', 'project:documents:write'], userId: 'user_x' }}
        client={client}
        onChanged={onChanged}
      />,
    )

    await userEvent.click(await screen.findByTestId('document-lifecycle-archive'))

    await waitFor(() => expect(archive).toHaveBeenCalledWith('doc_1'))
    await waitFor(() =>
      expect(onChanged).toHaveBeenCalledWith(
        expect.objectContaining({ documentId: 'doc_1', lifecycle: 'archived' }),
      ),
    )
  })
})
