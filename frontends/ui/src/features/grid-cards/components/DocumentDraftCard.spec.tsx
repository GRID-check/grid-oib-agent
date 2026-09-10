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
 * The unfiled action is asserted to write NOTHING: it prefills the composer, the
 * way a follow-up chip does. The card's header says why filing cannot happen in
 * the browser at all, and this spec is the guard on that decision — a future
 * change that gives the button a `fetch` fails here.
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

const setComposerPrefill = vi.fn()
const setCardDecision = vi.fn()

const storeState = () => ({
  projectId: 'proj-1',
  setComposerPrefill,
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

  it('reports the draft: title, path, version and a human size', () => {
    render(<DocumentDraftCard {...DRAFT} />)

    expect(screen.getByText(DRAFT.title)).toBeInTheDocument()
    expect(screen.getByText(DRAFT.path)).toBeInTheDocument()
    expect(screen.getByText('v3')).toBeInTheDocument()
    // Decimal units, from the one byte formatter — never a raw 4820, and no
    // decimal below MB (`lib/format.ts`: "1.4 kB" is noise).
    expect(screen.getByText('5 kB')).toBeInTheDocument()
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

  it('asks Piloti to file it, and writes nothing itself', async () => {
    // The whole decision the card's header argues: the bytes are in the agent's
    // working directory, so the browser has nothing to file and no route to
    // file it through. The click queues the request; the person sends it.
    const user = userEvent.setup()
    render(<DocumentDraftCard {...DRAFT} />)

    await user.click(screen.getByRole('button', { name: 'Add to the project' }))

    expect(setComposerPrefill).toHaveBeenCalledWith('File this draft into the project.')
    expect(fetch).not.toHaveBeenCalled()
    expect(setCardDecision).not.toHaveBeenCalled()
  })

  it('renders a first version and a zero-byte draft without inventing anything', () => {
    // The leanest draft the schema allows: `bytes: 0` (an empty file was still
    // written) and `version: 1`. A card that only paints on rich values is a
    // card that paints nothing the day the tool writes an empty stub.
    render(
      <DocumentDraftCard title="Notiz.md" path="/entwuerfe/Notiz.md" bytes={0} version={1} cardKey="k" />,
    )

    expect(screen.getByText('v1')).toBeInTheDocument()
    expect(screen.getByText('0 B')).toBeInTheDocument()
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

  it('offers the send again after a reviewer asked for changes', () => {
    render(<DocumentDraftCard {...FILED} versionState="changes_requested" />)
    expect(screen.getByRole('button', { name: 'Send for approval' })).toBeInTheDocument()
  })
})
