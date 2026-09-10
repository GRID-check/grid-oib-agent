/**
 * The `file_operation_proposal` card: what it shows, what Accept calls, and
 * what it says when only part of it worked.
 *
 * Three properties are the reason this file exists.
 *
 * 1. **The card proposes.** Until Accept is pressed, no route is called at all
 *    — the backend never wrote anything, so a card that fetched on mount would
 *    be the only writer in the chain and nobody would have consented to it.
 * 2. **Accept calls the routes a PERSON calls.** The same
 *    `PATCH /api/documents/[id]/folder`, `PATCH /api/documents/[id]`,
 *    `POST /api/projects/[id]/folders` and `POST /api/assignments/document/[id]`
 *    the Files pane uses, with the file resolved by NAME in this reader's own
 *    session. No route exists for the agent's benefit.
 * 3. **Partial failure is said out loud.** Four moves of which three land is
 *    neither „übernommen" nor „fehlgeschlagen", and the decision recorded on
 *    the message is `partiallyApplied` so a reload keeps saying so.
 *
 * Rendered without an `I18nProvider`, so the dictionary falls back to `en`.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CardInteractions } from '../card-decision'
import { FileOperationProposalCard } from './FileOperationProposalCard'

let mockProjectId: string | null = 'proj-1'
let mockCardInteractions: CardInteractions | undefined
const setCardDecision = vi.fn()

const mockStoreState = () => ({
  projectId: mockProjectId,
  currentConversation: {
    id: 'conv-1',
    messages: [{ id: 'msg-1', cardInteractions: mockCardInteractions }],
  },
  conversations: [],
  setCardDecision,
})

vi.mock('@/features/chat/store', () => {
  const useChatStore = (selector: (s: ReturnType<typeof mockStoreState>) => unknown) =>
    selector(mockStoreState())
  useChatStore.getState = () => mockStoreState()
  return { useChatStore }
})

vi.mock('@/features/documents/hooks/use-surfaced-documents', () => ({
  resolveStoredDocument: vi.fn(async (_projectId: string, fileName: string) =>
    fileName === 'Fehlt.pdf' ? null : { id: `doc-${fileName}` },
  ),
}))

interface Call {
  url: string
  method: string
  body: unknown
}

let calls: Call[] = []

const FOLDERS = [
  { id: 'f-einreichung', name: 'Einreichung', path: 'Einreichung', parentId: null },
  { id: 'f-plaene', name: 'Pläne', path: 'Einreichung/Pläne', parentId: 'f-einreichung' },
]

const CANDIDATES = [
  { userId: 'u-anna', name: 'Anna Berger', email: 'anna@example.com' },
  { userId: 'u-ben', name: 'Ben Gruber', email: 'ben@example.com' },
]

function stubFetch(overrides: (url: string) => { ok: boolean; status: number } | null = () => null) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const override = overrides(url)
    if (override) return Promise.resolve({ ...override, json: async () => ({}) })
    if (url.endsWith('/folders')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ folders: FOLDERS }) })
    }
    if (url.endsWith('/candidates')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ candidates: CANDIDATES }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const moveCard = {
  title: 'Move two files',
  operation: 'move' as const,
  operations: [
    {
      document: 'Grundriss EG.pdf',
      source: 'projekt' as const,
      current: 'Nachweise',
      target_folder: 'Einreichung/Pläne',
    },
    {
      document: 'Grundriss OG.pdf',
      source: 'projekt' as const,
      current: '',
      target_folder: 'Einreichung/Pläne',
    },
  ],
}

beforeEach(() => {
  calls = []
  mockProjectId = 'proj-1'
  mockCardInteractions = undefined
  vi.clearAllMocks()
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FileOperationProposalCard — what it shows', () => {
  it('renders every proposed operation and calls nothing until asked', () => {
    render(<FileOperationProposalCard {...moveCard} cardKey="file_operation_proposal-0" />)

    expect(screen.getByText('Grundriss EG.pdf')).toBeInTheDocument()
    expect(screen.getByText('Grundriss OG.pdf')).toBeInTheDocument()
    // The current folder is on the row, because a move the reader cannot place
    // is a move they cannot judge. An empty `current` is the project root.
    expect(screen.getByText(/Nachweise/)).toBeInTheDocument()
    expect(screen.getByText(/Top level/)).toBeInTheDocument()
    expect(calls).toEqual([])
  })

  it.each([
    ['rename', { document: 'a.pdf', source: 'projekt' as const, new_display_name: 'Grundriss Erdgeschoss' }, 'Grundriss Erdgeschoss'],
    ['create_folder', { folder_name: 'Fotos', parent_folder: 'Einreichung' }, 'Fotos'],
    // The label, not the key: `gesetz` is what travels, „Gesetz / Bauordnung"
    // is what the reader is deciding about.
    [
      'set_doc_class',
      { document: 'a.pdf', source: 'projekt' as const, doc_class: 'gesetz' },
      'Gesetz / Bauordnung',
    ],
    ['assign', { document: 'a.pdf', source: 'projekt' as const, member: 'Anna Berger' }, 'Anna Berger'],
  ])('renders the %s operation in its own words', (operation, item, expected) => {
    render(
      <FileOperationProposalCard
        title="Proposal"
        operation={operation as 'rename'}
        operations={[item]}
        cardKey="file_operation_proposal-0"
      />,
    )
    expect(screen.getByText(expected)).toBeInTheDocument()
  })

  it('offers nothing for an operation with no route behind it', () => {
    render(
      <FileOperationProposalCard
        title="Dokumentart"
        operation="set_doc_class"
        operations={[{ document: 'a.pdf', source: 'projekt', doc_class: 'gesetz' }]}
        cardKey="file_operation_proposal-0"
      />,
    )
    // The proposal still reads — and says why it cannot be applied.
    expect(screen.getByTestId('file-operation-unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('offers nothing without a project, because every route behind it is project-scoped', () => {
    mockProjectId = null
    render(<FileOperationProposalCard {...moveCard} cardKey="file_operation_proposal-0" />)
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })
})

describe('FileOperationProposalCard — what Accept calls', () => {
  it('moves each file through the folder route, with the folder resolved by path', async () => {
    const user = userEvent.setup()
    render(
      <FileOperationProposalCard {...moveCard} messageId="msg-1" cardKey="file_operation_proposal-0" />,
    )

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'file_operation_proposal-0', 'accepted'))
    const patches = calls.filter((call) => call.method === 'PATCH')
    expect(patches).toEqual([
      { url: '/api/documents/doc-Grundriss%20EG.pdf/folder', method: 'PATCH', body: { folderId: 'f-plaene' } },
      { url: '/api/documents/doc-Grundriss%20OG.pdf/folder', method: 'PATCH', body: { folderId: 'f-plaene' } },
    ])
    // The folder list is fetched once for the whole card, not once per row.
    expect(calls.filter((call) => call.url.endsWith('/folders'))).toHaveLength(1)
  })

  it('renames through the document route', async () => {
    const user = userEvent.setup()
    render(
      <FileOperationProposalCard
        title="Rename"
        operation="rename"
        operations={[{ document: 'a.pdf', source: 'projekt', new_display_name: 'Grundriss EG' }]}
        messageId="msg-1"
        cardKey="file_operation_proposal-0"
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(setCardDecision).toHaveBeenCalled())
    expect(calls).toContainEqual({
      url: '/api/documents/doc-a.pdf',
      method: 'PATCH',
      body: { displayName: 'Grundriss EG' },
    })
  })

  it('creates a folder under the parent it names', async () => {
    const user = userEvent.setup()
    render(
      <FileOperationProposalCard
        title="New folder"
        operation="create_folder"
        operations={[{ folder_name: 'Fotos', parent_folder: 'Einreichung' }]}
        messageId="msg-1"
        cardKey="file_operation_proposal-0"
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(setCardDecision).toHaveBeenCalled())
    expect(calls).toContainEqual({
      url: '/api/projects/proj-1/folders',
      method: 'POST',
      body: { name: 'Fotos', parentId: 'f-einreichung' },
    })
  })

  it('assigns the person the project actually has, resolved by name', async () => {
    const user = userEvent.setup()
    render(
      <FileOperationProposalCard
        title="Assign"
        operation="assign"
        operations={[{ document: 'a.pdf', source: 'projekt', member: 'Anna Berger' }]}
        messageId="msg-1"
        cardKey="file_operation_proposal-0"
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(setCardDecision).toHaveBeenCalled())
    expect(calls).toContainEqual({
      url: '/api/assignments/document/doc-a.pdf',
      method: 'POST',
      body: { userId: 'u-anna' },
    })
  })

  it('refuses to assign a person the project does not have, rather than pick one', async () => {
    const user = userEvent.setup()
    render(
      <FileOperationProposalCard
        title="Assign"
        operation="assign"
        operations={[{ document: 'a.pdf', source: 'projekt', member: 'Carla Huber' }]}
        messageId="msg-1"
        cardKey="file_operation_proposal-0"
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Apply' }))

    // Nothing was assigned and the card did not settle: every row failed.
    await screen.findByText('Could not be applied.')
    expect(calls.some((call) => call.method === 'POST' && call.url.includes('/assignments/'))).toBe(false)
    expect(setCardDecision).not.toHaveBeenCalled()
  })
})

describe('FileOperationProposalCard — partial failure', () => {
  it('reports what landed and what did not, and records it as partial', async () => {
    const user = userEvent.setup()
    stubFetch((url) => (url.includes('doc-Grundriss%20OG.pdf') ? { ok: false, status: 409 } : null))

    render(
      <FileOperationProposalCard {...moveCard} messageId="msg-1" cardKey="file_operation_proposal-0" />,
    )
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() =>
      expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'file_operation_proposal-0', 'partiallyApplied'),
    )
  })

  it('shows the decided state after a reload, without re-offering the write', () => {
    mockCardInteractions = {
      'file_operation_proposal-0': { decision: 'accepted', decidedAt: '2026-09-10T09:00:00Z' },
    }
    render(
      <FileOperationProposalCard {...moveCard} messageId="msg-1" cardKey="file_operation_proposal-0" />,
    )

    expect(screen.getByText('2 files moved.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull()
  })

  it('says only what it still knows after a reload of a partial accept', () => {
    mockCardInteractions = {
      'file_operation_proposal-0': { decision: 'partiallyApplied', decidedAt: '2026-09-10T09:00:00Z' },
    }
    render(
      <FileOperationProposalCard {...moveCard} messageId="msg-1" cardKey="file_operation_proposal-0" />,
    )

    expect(screen.getByText(/Applied in part/)).toBeInTheDocument()
  })

  it('discards without calling anything', async () => {
    const user = userEvent.setup()
    render(
      <FileOperationProposalCard {...moveCard} messageId="msg-1" cardKey="file_operation_proposal-0" />,
    )

    await user.click(screen.getByRole('button', { name: 'Discard' }))

    expect(setCardDecision).toHaveBeenCalledWith('msg-1', 'file_operation_proposal-0', 'rejected')
    expect(calls).toEqual([])
  })
})
