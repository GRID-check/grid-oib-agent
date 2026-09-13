/**
 * @vitest-environment node
 */
/**
 * The draft-filing service: one normalized path in, one document out.
 *
 * Two properties the route spec cannot see, pinned here against the service
 * directly:
 *
 *   - the card's raw path is normalized ONCE and reused for the backend read,
 *     the title fallback and the idempotency reference. Fringe in any one of
 *     the three mints a different ref or misses the same-name veto — both as
 *     a duplicate document;
 *   - the same-name veto scans the WHOLE project, page by page, rather than
 *     the repository's first bounded listing. Past 500 rows a single page
 *     misses the veto and files the duplicate it exists to stop.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@/lib/db/schema'
import type { DocumentVersion } from '@/lib/db/schema'
import type { DocumentListRow } from '@/lib/documents/repository'

const requireResourceAccessMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/sharing/access', () => ({
  requireResourceAccess: requireResourceAccessMock,
}))

vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))

vi.mock('@/lib/conversations/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/conversations/repository')>()),
  findConversationInOrg: vi.fn(),
}))

vi.mock('@/lib/conversations/draft-preview', () => ({
  readConversationDraft: vi.fn(),
}))

vi.mock('@/lib/documents/repository', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/repository')>()),
  findDocumentAuthoredByRef: vi.fn(),
  listProjectDocuments: vi.fn(),
}))

vi.mock('@/lib/documents/version-repository', () => ({
  findOpenVersion: vi.fn(),
}))

vi.mock('@/lib/documents/agent-document', () => ({
  fileAgentDocumentDraft: vi.fn(),
}))

import { findConversationInOrg } from '@/lib/conversations/repository'
import { readConversationDraft } from '@/lib/conversations/draft-preview'
import {
  fileConversationDraft,
  filingReference,
  normalizeDraftPath,
} from '@/lib/conversations/draft-filing'
import { fileAgentDocumentDraft } from '@/lib/documents/agent-document'
import {
  DOCUMENT_LIST_LIMIT,
  findDocumentAuthoredByRef,
  listProjectDocuments,
} from '@/lib/documents/repository'

const PROJECT = '33333333-3333-4333-8333-333333333333'
const DOC = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'

const session = { userId: 'user_1', organizationId: 'org_1' } as never

const conversation = (overrides: Partial<Conversation> = {}): Conversation =>
  ({
    id: 'conv-1',
    organizationId: 'org_1',
    projectId: PROJECT,
    ...overrides,
  }) as Conversation

const filler = (count: number, start = 0): DocumentListRow[] =>
  Array.from(
    { length: count },
    (_, i) => ({ id: `doc-${start + i}`, filename: `f-${start + i}.md`, displayName: `Bericht ${start + i}` }) as DocumentListRow,
  )

beforeEach(() => {
  vi.clearAllMocks()
  requireResourceAccessMock.mockResolvedValue({ role: 'viewer' })
  vi.mocked(findConversationInOrg).mockResolvedValue(conversation())
  vi.mocked(readConversationDraft).mockResolvedValue({
    path: 'entwuerfe/aktenvermerk.md',
    content: '# Aktenvermerk\n',
    version: 2,
    bytes: 16,
  })
  vi.mocked(findDocumentAuthoredByRef).mockResolvedValue(null)
  vi.mocked(listProjectDocuments).mockResolvedValue([])
  vi.mocked(fileAgentDocumentDraft).mockResolvedValue({
    documentId: DOC,
    version: { id: VERSION, state: 'draft' } as DocumentVersion,
    alreadyFiled: false,
  })
})

describe('fileConversationDraft — one normalized path for read, title and ref', () => {
  it('reads, titles and refs the same normalized path, whatever fringe the card carried', async () => {
    const filed = await fileConversationDraft(session, 'conv-1', {
      path: ' /entwuerfe/Aktenvermerk.md',
      title: 'Aktenvermerk',
    })

    expect(filed.documentId).toBe(DOC)
    // The backend read door gets the normalized path — the leading space is
    // gone, so this press reads the same bytes as the preview's.
    expect(readConversationDraft).toHaveBeenCalledWith(session, 'conv-1', 'entwuerfe/Aktenvermerk.md')
    // …and the reference is the normalized one, not a second key beside the
    // agent's row for the same draft.
    expect(vi.mocked(fileAgentDocumentDraft).mock.calls[0][0]).toMatchObject({
      ref: filingReference('conv-1', '/entwuerfe/Aktenvermerk.md'),
    })
  })

  it('falls back to the normalized file name when the card carried no title', async () => {
    await fileConversationDraft(session, 'conv-1', { path: '/entwuerfe/Notiz.md' })

    expect(vi.mocked(fileAgentDocumentDraft).mock.calls[0][0]).toMatchObject({
      title: 'Notiz.md',
      ref: 'conv-1-notiz',
    })
  })

  it('normalizes the same way twice — fringe never mints a second reference', () => {
    expect(normalizeDraftPath(' /entwuerfe/Aktenvermerk.md')).toBe('entwuerfe/Aktenvermerk.md')
    expect(filingReference('conv-1', ' /entwuerfe/Aktenvermerk.md')).toBe(
      filingReference('conv-1', '/entwuerfe/Aktenvermerk.md'),
    )
  })
})

describe('fileConversationDraft — the same-name veto scans every page', () => {
  it('vetoes a clash sitting past the first page, carrying that row', async () => {
    const clash = {
      id: 'doc-9',
      filename: 'x.md',
      displayName: 'Der späte Zwilling',
    } as DocumentListRow
    vi.mocked(listProjectDocuments)
      .mockResolvedValueOnce(filler(DOCUMENT_LIST_LIMIT))
      .mockResolvedValueOnce([clash])

    const failure = await fileConversationDraft(session, 'conv-1', {
      path: '/entwuerfe/zwilling.md',
      title: 'Der späte Zwilling',
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      status: 409,
      details: { reason: 'same-name', documentId: 'doc-9', displayName: 'Der späte Zwilling' },
    })

    // Two pages walked: the full first one, then the short one holding the row.
    expect(listProjectDocuments).toHaveBeenCalledTimes(2)
    expect(vi.mocked(listProjectDocuments).mock.calls[1][2]).toMatchObject({
      offset: DOCUMENT_LIST_LIMIT,
    })
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })

  it('files once the scan ends on a short page with no clash', async () => {
    vi.mocked(listProjectDocuments)
      .mockResolvedValueOnce(filler(DOCUMENT_LIST_LIMIT))
      .mockResolvedValueOnce(filler(3, DOCUMENT_LIST_LIMIT))

    const filed = await fileConversationDraft(session, 'conv-1', {
      path: '/entwuerfe/neu.md',
      title: 'Ganz neu',
    })

    expect(filed.documentId).toBe(DOC)
    expect(listProjectDocuments).toHaveBeenCalledTimes(2)
    expect(fileAgentDocumentDraft).toHaveBeenCalled()
  })

  it('reads a single page when the project fits in one', async () => {
    await fileConversationDraft(session, 'conv-1', {
      path: '/entwuerfe/neu.md',
      title: 'Ganz neu',
    })

    expect(listProjectDocuments).toHaveBeenCalledTimes(1)
    expect(fileAgentDocumentDraft).toHaveBeenCalled()
  })
})
