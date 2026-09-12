/**
 * The `document_draft` card — what it reports, and which of its two states it is in.
 *
 * The card has one job that is easy to get wrong in either direction: an unfiled
 * draft must not look like a project document, and a filed one must not look
 * like it is still only in the chat. So the three states are pinned separately —
 * unfiled, filed and submittable, filed and already in review — together with
 * the one claim that must never appear at any of them: that somebody approved
 * this.
 *
 * Versioning is demoted throughout: a single write is no history, so the card
 * never numbers it — the stand word stands in the counter's place — and the
 * size lives in the preview beside the words it measures, never on the card.
 *
 * The unfiled FILE action files the draft DIRECTLY through the BFF's
 * draft-file door, in the reader's own session — no prompt, no second turn.
 * The tests below pin that the button POSTs to that door (never a prefill),
 * that a same-name 409 parks for an explicit confirmation rather than a
 * silent copy, and that every refusal stays actionable. The card's OTHER
 * unfiled control, the preview, is a read: it fetches the draft's content
 * through the BFF preview door into a dialog, and its own tests below pin
 * that it does so only when opened, and only for this conversation.
 *
 * The byline is asserted by its WORDS rather than by the component being
 * imported, because the words are the point: a file says who wrote it the same
 * way here as it does in the Files grid (`documents/components/authorship-line`).
 *
 * Renders without an `I18nProvider`, so the dictionary falls back to `en`
 * (`src/i18n/context.tsx`) and the strings asserted below are the English ones.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { DocumentDraftCard } from './DocumentDraftCard'

const setCardDecision = vi.fn()

const storeState = () => ({
  projectId: 'proj-1',
  setCardDecision,
  currentConversation: { id: 'conv-1', messages: [{ id: 'msg-1', cardInteractions: undefined }] },
  conversations: [],
})

vi.mock('@/features/chat/store', () => {
  const useChatStore = (selector: (s: unknown) => unknown) => selector(storeState())
  useChatStore.getState = () => storeState()
  return { useChatStore }
})

const openFiledDocument = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))
vi.mock('@/features/documents/lib/open-filed-document', () => ({ openFiledDocument }))

const DRAFT = {
  title: 'Aktenvermerk – Abweichung Fluchtweglänge',
  path: '/entwuerfe/aktenvermerk-fluchtweg.md',
  bytes: 4820,
  version: 3,
  cardKey: 'document_draft-0',
  messageId: 'msg-1',
}

const FILED = {
  ...DRAFT,
  documentId: 'doc-1',
  versionId: 'ver-1',
  versionState: 'draft' as const,
}

describe('DocumentDraftCard — the draft, before it is filed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reports the draft: title, path, stand and — past the first write — the version', () => {
    render(<DocumentDraftCard {...DRAFT} />)

    expect(screen.getByText(DRAFT.title)).toBeInTheDocument()
    expect(screen.getByText(DRAFT.path)).toBeInTheDocument()
    // The stand, in words: an unfiled draft is a draft by definition.
    expect(screen.getByTestId('document-draft-state')).toHaveTextContent('Draft')
    // Past the first write the counter stays — a single write is the only
    // count that never renders.
    expect(screen.getByText('v3')).toBeInTheDocument()
    // The size lives in the preview beside the words it measures, never on
    // the card — so neither the human size nor the raw bytes stand here.
    expect(screen.queryByText('5 kB')).not.toBeInTheDocument()
    expect(screen.queryByText(String(DRAFT.bytes))).not.toBeInTheDocument()
  })

  it('says who wrote it, in the Files feature’s own words', () => {
    render(<DocumentDraftCard {...DRAFT} />)
    expect(screen.getByText('Created by Piloti')).toBeInTheDocument()
  })

  it('does not claim the draft is in the project', () => {
    render(<DocumentDraftCard {...DRAFT} />)

    expect(screen.queryByText('Filed in the project as a draft')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Open in the project' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send for approval' })).not.toBeInTheDocument()
  })

  it('files the draft into the project on one press, and remembers that it did', async () => {
    // The whole decision the card's header argues: the bytes are reachable
    // through the BFF's read doors, so the button files directly — in the
    // reader's own session, through the existing filing op — rather than
    // asking Piloti for a second turn.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ documentId: 'doc-1', versionId: 'ver-1', state: 'draft', alreadyFiled: false }),
        }),
      ),
    )
    const user = userEvent.setup()
    render(<DocumentDraftCard {...DRAFT} />)

    await user.click(screen.getByRole('button', { name: 'File into the project' }))

    // This conversation's draft, through the BFF file door — never the agent tier.
    expect(fetch).toHaveBeenCalledWith(
      '/api/conversations/conv-1/draft/file',
      expect.objectContaining({ method: 'POST' }),
    )
    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      path: DRAFT.path,
      title: DRAFT.title,
      force: false,
    })
    // The filed state shows the open link, and the outcome persists.
    expect(await screen.findByRole('link', { name: 'Open in the project' })).toHaveAttribute(
      'href',
      expect.stringContaining('doc-1'),
    )
    await waitFor(() => expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'document_draft-0', 'filed'))
  })

  it('says it is filing while the request is in flight', async () => {
    let resolveFile!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => { resolveFile = resolve })),
    )
    const user = userEvent.setup()
    render(<DocumentDraftCard {...DRAFT} />)

    await user.click(screen.getByRole('button', { name: 'File into the project' }))

    expect(await screen.findByRole('button', { name: 'Filing …' })).toBeDisabled()
    resolveFile({
      ok: true,
      status: 201,
      json: async () => ({ documentId: 'doc-1', versionId: 'ver-1', state: 'draft', alreadyFiled: false }),
    } as Response)
    expect(await screen.findByRole('link', { name: 'Open in the project' })).toBeInTheDocument()
  })

  it('parks a same-name collision for an explicit confirmation, never a silent copy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            error: 'A document with this title is already in the project.',
            code: 'CONFLICT',
            details: { reason: 'same-name', documentId: 'doc-9', displayName: 'Bestehender Bericht' },
          }),
        }),
      ),
    )
    const user = userEvent.setup()
    render(<DocumentDraftCard {...DRAFT} />)

    await user.click(screen.getByRole('button', { name: 'File into the project' }))

    // The veto, the row it names, and the confirmation — and nothing filed.
    expect(await screen.findByTestId('document-draft-conflict')).toBeInTheDocument()
    expect(screen.getByText('A document with this name is already in the project.')).toBeInTheDocument()
    expect(screen.getByTestId('document-draft-conflict-open')).toHaveTextContent('Bestehender Bericht')
    expect(setCardDecision).not.toHaveBeenCalled()

    // The confirmation files beside the existing document.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ documentId: 'doc-2', versionId: 'ver-2', state: 'draft', alreadyFiled: false }),
        }),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'File anyway' }))

    const [, init] = vi.mocked(fetch).mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ force: true })
    expect(await screen.findByRole('link', { name: 'Open in the project' })).toHaveAttribute(
      'href',
      expect.stringContaining('doc-2'),
    )
    await waitFor(() => expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'document_draft-0', 'filed'))
  })

  it('names the Files pane when the reference filed and moved on', async () => {
    // Not a veto and not a retry: the reference this path files under already
    // became a document and left the writing states, so there is nothing to
    // confirm and nothing a second press could change.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            error: 'This draft has already been filed and is no longer a draft',
            code: 'CONFLICT',
            details: { reason: 'already-submitted' },
          }),
        }),
      ),
    )
    const user = userEvent.setup()
    render(<DocumentDraftCard {...DRAFT} />)

    await user.click(screen.getByRole('button', { name: 'File into the project' }))

    await waitFor(() => expect(screen.getByTestId('document-draft-error')).toBeInTheDocument())
    expect(screen.getByText('This draft has already been filed. Continue in the Files pane.')).toBeInTheDocument()
    expect(screen.queryByTestId('document-draft-conflict')).not.toBeInTheDocument()
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('keeps the card pending when filing fails, with the retry still offered', async () => {    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 502,
          json: async () => ({ error: 'Upstream service error', code: 'UPSTREAM_ERROR' }),
        }),
      ),
    )
    const user = userEvent.setup()
    render(<DocumentDraftCard {...DRAFT} />)

    await user.click(screen.getByRole('button', { name: 'File into the project' }))

    // An actionable message, never bare red text — and the cause may be gone
    // by the time the reader presses again.
    await waitFor(() => expect(screen.getByTestId('document-draft-error')).toBeInTheDocument())
    expect(screen.getByText('Filing failed. Please try again.')).toBeInTheDocument()
    expect(setCardDecision).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'File into the project' })).toBeInTheDocument()

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ documentId: 'doc-1', versionId: 'ver-1', state: 'draft', alreadyFiled: false }),
        }),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'File into the project' }))

    expect(await screen.findByRole('link', { name: 'Open in the project' })).toBeInTheDocument()
    await waitFor(() => expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'document_draft-0', 'filed'))
  })

  it('takes no filing it could not keep', () => {
    // The deep-research report tab: the cards come from a job output whose
    // owning message may not be loaded, so an unpersistable decision must not
    // be offered at all (`card-owner.ts`). Reading stays — it decides nothing.
    render(<DocumentDraftCard {...DRAFT} messageId={undefined} decisionsMustPersist />)

    expect(screen.queryByRole('button', { name: 'File into the project' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View draft' })).toBeInTheDocument()
  })

  it('names the stand instead of numbering a first write', () => {
    // The leanest draft the schema allows: `bytes: 0` (an empty file was still
    // written) and `version: 1`. One write is no history, so the card carries
    // neither a counter nor a size — the state word stands in the counter's
    // place, and the size waits in the preview.
    render(
      <DocumentDraftCard title="Notiz.md" path="/entwuerfe/Notiz.md" bytes={0} version={1} cardKey="k" />,
    )

    expect(screen.getByTestId('document-draft-state')).toHaveTextContent('Draft')
    expect(screen.queryByText('v1')).not.toBeInTheDocument()
    expect(screen.queryByText('0 B')).not.toBeInTheDocument()
  })

  it('offers the draft for reading beside the file action, and fetches nothing until asked', () => {
    render(<DocumentDraftCard {...DRAFT} />)

    expect(screen.getByRole('button', { name: 'View draft' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'File into the project' })).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('opens the reading surface with the fetched markdown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            path: DRAFT.path,
            content: '# Aktenvermerk\n\nDer Text.',
            version: 3,
            bytes: 30,
          }),
        }),
      ),
    )
    const user = userEvent.setup()
    render(<DocumentDraftCard {...DRAFT} />)

    await user.click(screen.getByRole('button', { name: 'View draft' }))

    // The surface: the draft's own facts in the chrome, its words below.
    expect(await screen.findByTestId('document-draft-preview')).toBeInTheDocument()
    expect(screen.getByTestId('document-draft-preview-meta')).toHaveTextContent(DRAFT.path)
    expect(screen.getByTestId('document-draft-preview-meta')).toHaveTextContent('v3')
    expect(screen.getByTestId('document-draft-preview-meta')).toHaveTextContent('5 kB')
    expect(screen.getByTestId('document-draft-preview-content')).toHaveTextContent('Der Text.')
    // This conversation's draft, through the BFF door — never the agent tier.
    expect(fetch).toHaveBeenCalledWith(
      '/api/conversations/conv-1/draft?path=%2Fentwuerfe%2Faktenvermerk-fluchtweg.md',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('numbers nothing in the reading surface of a first write either — but keeps its size', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            path: '/entwuerfe/Notiz.md',
            content: '# Notiz\n\nDer Text.',
            version: 1,
            bytes: 0,
          }),
        }),
      ),
    )
    const user = userEvent.setup()
    render(
      <DocumentDraftCard title="Notiz.md" path="/entwuerfe/Notiz.md" bytes={0} version={1} cardKey="k" />,
    )

    await user.click(screen.getByRole('button', { name: 'View draft' }))

    expect(await screen.findByTestId('document-draft-preview')).toBeInTheDocument()
    const meta = screen.getByTestId('document-draft-preview-meta')
    expect(meta).toHaveTextContent('/entwuerfe/Notiz.md')
    expect(meta).not.toHaveTextContent('v1')
    // …while the size stays: this is the surface that shows the words it measures.
    expect(meta).toHaveTextContent('0 B')
    expect(screen.getByTestId('document-draft-preview-content')).toHaveTextContent('Der Text.')
  })

  it('retries a failed load from the surface, never as a bare error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: 'Upstream service error', code: 'UPSTREAM_ERROR' }),
        }),
      ),
    )
    const user = userEvent.setup()
    render(<DocumentDraftCard {...DRAFT} />)

    await user.click(screen.getByRole('button', { name: 'View draft' }))

    // An actionable message: what failed is said AND the way back is offered.
    expect(await screen.findByTestId('document-draft-preview-error')).toBeInTheDocument()
    expect(screen.getByText('The draft could not be loaded.')).toBeInTheDocument()

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            path: DRAFT.path,
            content: '# Aktenvermerk\n\nDer Text.',
            version: 3,
            bytes: 30,
          }),
        }),
      ),
    )
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(await screen.findByTestId('document-draft-preview-content')).toHaveTextContent(
      'Der Text.',
    )
  })
})

describe('DocumentDraftCard — filed, and still the reader’s to send', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            version: {
              id: 'ver-1',
              documentId: 'doc-1',
              versionNumber: 1,
              state: 'in_review',
              contentType: 'text/markdown',
              fileSize: 10,
              contentHash: 'h1',
              submittedBy: 'user_1',
              submittedAt: '2026-09-10T00:00:00.000Z',
              reviewedBy: null,
              reviewedAt: null,
              approvedBy: null,
              approvedAt: null,
              publishedBy: null,
              publishedAt: null,
              reviewComment: null,
              createdBy: 'user_1',
              createdAt: '2026-09-10T00:00:00.000Z',
              updatedAt: '2026-09-10T00:00:00.000Z',
            },
          }),
        }),
      ),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('says the document is in the project, as a draft', () => {
    render(<DocumentDraftCard {...FILED} />)
    expect(screen.getByTestId('document-draft-state')).toHaveTextContent('Filed in the project as a draft')
    // Written three times, so the counter stands beside the stand.
    expect(screen.getByText('v3')).toBeInTheDocument()
  })

  it('a filed card offers no draft preview — there is nothing unfiled left to read', () => {
    render(<DocumentDraftCard {...FILED} />)

    expect(screen.queryByRole('button', { name: 'View draft' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in the project' })).toBeInTheDocument()
  })

  it('offers the document beside the conversation rather than instead of it', async () => {
    const user = userEvent.setup()
    render(<DocumentDraftCard {...FILED} />)

    const open = screen.getByRole('link', { name: 'Open in the project' })
    // A real link first: middle click and „copy link address" still reach the
    // Files route, which is why this is an anchor and not a button.
    expect(open).toHaveAttribute('href', expect.stringContaining('doc-1'))
    await user.click(open)
    expect(openFiledDocument).toHaveBeenCalledWith({ documentId: 'doc-1', projectId: 'proj-1' })
  })

  it('sends it for approval through the lifecycle client, and remembers that it did', async () => {
    const user = userEvent.setup()
    render(<DocumentDraftCard {...FILED} />)

    await user.click(screen.getByRole('button', { name: 'Send for approval' }))

    await waitFor(() => expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'document_draft-0', 'submitted'))
    // The client's own path and verb — asserted here so a card that hand-rolled
    // a second fetch would fail rather than drift (ADR-0055).
    expect(fetch).toHaveBeenCalledWith(
      '/api/documents/doc-1/versions/ver-1/submit',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('keeps the card pending when the submit fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'conflict', code: 'CONFLICT' }) }),
      ),
    )
    const user = userEvent.setup()
    render(<DocumentDraftCard {...FILED} />)

    await user.click(screen.getByRole('button', { name: 'Send for approval' }))

    await waitFor(() => expect(screen.getByTestId('document-draft-error')).toBeInTheDocument())
    expect(setCardDecision).not.toHaveBeenCalled()
    // Still offered: the cause may be gone by the time the reader presses again.
    expect(screen.getByRole('button', { name: 'Send for approval' })).toBeInTheDocument()
  })

  it('takes no answer it could not keep', () => {
    // The deep-research report tab: the cards come from a job output whose
    // owning message may not be loaded, so an unpersistable decision must not
    // be offered at all (`card-owner.ts`).
    render(<DocumentDraftCard {...FILED} messageId={undefined} decisionsMustPersist />)

    expect(screen.queryByRole('button', { name: 'Send for approval' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open in the project' })).toBeInTheDocument()
  })
})

describe('DocumentDraftCard — already with a reviewer', () => {
  it('reports the state instead of offering a control that would be refused', () => {
    render(<DocumentDraftCard {...FILED} versionState="in_review" />)

    expect(screen.getByTestId('document-draft-state')).toHaveTextContent('Awaiting approval')
    expect(screen.queryByRole('button', { name: 'Send for approval' })).not.toBeInTheDocument()
  })

  it('never says a Piloti draft is approved just because a version state is', () => {
    // `approved` and `published` are states a PERSON set. The card may report
    // them — it must not imply the agent reached them.
    render(<DocumentDraftCard {...FILED} versionState="approved" />)
    expect(screen.getByTestId('document-draft-state')).toHaveTextContent('Approved')
    expect(screen.queryByRole('button', { name: 'Send for approval' })).not.toBeInTheDocument()
  })

  it('names a superseded version replaced, never published', () => {
    // A version a newer one overtook is read, but it is no longer the stand —
    // sharing `published` claimed it still was.
    render(<DocumentDraftCard {...FILED} versionState="superseded" />)
    expect(screen.getByTestId('document-draft-state')).toHaveTextContent('Superseded')
    expect(screen.queryByRole('button', { name: 'Send for approval' })).not.toBeInTheDocument()
  })

  it('offers the send again after a reviewer asked for changes', () => {
    render(<DocumentDraftCard {...FILED} versionState="changes_requested" />)
    expect(screen.getByRole('button', { name: 'Send for approval' })).toBeInTheDocument()
  })
})
