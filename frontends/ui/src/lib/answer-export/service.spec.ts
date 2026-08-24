/**
 * @vitest-environment node
 */
/**
 * Who may download an answer.
 *
 * This endpoint hands out a FILE — the answer, its project name, its citations
 * and its building's dimensions — so the access rules are exercised through the
 * REAL `@/lib/sharing/access`, exactly as `conversations/service.spec.ts` does.
 * Only the registry's probe, the container check and the grant lookup are
 * mocked. A spec that mocked `requireResourceAccess` would assert that the
 * export calls a function, not that anything is enforced.
 *
 * The three ways this could leak, each a test below: another organization's
 * answer, a colleague's private thread, and a project the caller cannot reach.
 * All three must be indistinguishable from "no such answer" (spec SH-6).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({
  conversationIdsExisting: vi.fn(),
  findConversationInOrg: vi.fn(),
  findConversationTenancy: vi.fn(),
  listConversationIdsForProject: vi.fn(),
  listMessagesForConversation: vi.fn(),
  updateConversationVisibilityInOrg: vi.fn(),
}))
vi.mock('@/lib/documents/repository', () => ({
  documentIdsExisting: vi.fn(),
  findDocumentTenancy: vi.fn(),
  listDocumentIdsForProject: vi.fn(),
  updateDocumentVisibilityInOrg: vi.fn(),
}))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('@/lib/sharing/repository', () => ({ findGrantForSubject: vi.fn() }))

// The request-scoped locale helpers need a Next.js request context, which a
// service spec has no business standing up. Bound to the REAL dictionaries so
// the document still fails here if a key is missing.
vi.mock('@/i18n/server', async () => {
  const { createTranslator } = await import('@/i18n/translate')
  const { de } = await import('@/i18n/dictionaries')
  return {
    getTranslations: vi.fn(async () => createTranslator(de, 'answerExport')),
    getLocale: vi.fn(async () => 'de'),
  }
})

import { NotFoundError, UnprocessableError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess, type ProjectRole } from '@/lib/authz/projects'
import {
  findConversationInOrg,
  findConversationTenancy,
  listMessagesForConversation,
} from '@/lib/conversations/repository'
import type { Conversation, Message, ResourceVisibility } from '@/lib/db/schema'
import { findProjectInOrg } from '@/lib/projects/repository'
import { findGrantForSubject } from '@/lib/sharing/repository'
import { exportAnswerDocument } from './service'

const CONVERSATION_ID = 'conv_1'
const PROJECT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
const ANSWER_ID = '11111111-2222-4333-8444-555555555555'
const QUESTION_ID = '99999999-2222-4333-8444-555555555555'

const session = {
  userId: 'user_me',
  organizationId: 'org_1',
  email: 'me@grid.test',
} as unknown as AuthorizedSession

function stubConversation(
  overrides: Partial<{
    organizationId: string
    projectId: string | null
    visibility: ResourceVisibility
    createdBy: string
  }> = {}
): void {
  const tenancy = {
    organizationId: 'org_1',
    projectId: PROJECT_ID,
    visibility: 'private' as ResourceVisibility,
    createdBy: 'user_me',
    deletedAt: null,
    ...overrides,
  }
  vi.mocked(findConversationTenancy).mockResolvedValue(tenancy)
  vi.mocked(findConversationInOrg).mockResolvedValue({
    id: CONVERSATION_ID,
    title: 'Fluchtwege Bauteil B',
    ...tenancy,
  } as unknown as Conversation)
}

function stubContainer(role: ProjectRole | 'denied'): void {
  if (role === 'denied') {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    return
  }
  vi.mocked(requireProjectAccess).mockResolvedValue({ role } as never)
}

const message = (overrides: Partial<Message> = {}): Message =>
  ({
    id: ANSWER_ID,
    conversationId: CONVERSATION_ID,
    organizationId: 'org_1',
    role: 'assistant',
    authorUserId: null,
    content: 'Die Gehweglänge darf 40 m nicht überschreiten [1].',
    metadata: {},
    createdAt: new Date('2026-05-04T09:30:00Z'),
    ...overrides,
  }) as Message

/** The bytes are a real .docx, so the XML is readable straight out of the zip. */
const documentXml = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

beforeEach(() => {
  vi.clearAllMocks()
  stubConversation()
  stubContainer('project-editor')
  vi.mocked(findGrantForSubject).mockResolvedValue(null)
  vi.mocked(findProjectInOrg).mockResolvedValue({ name: 'Wohnhaus Seestadt' } as never)
  vi.mocked(listMessagesForConversation).mockResolvedValue([
    message({ id: QUESTION_ID, role: 'user', content: 'Wie lang darf der Fluchtweg sein?' }),
    message(),
  ])
})

describe('tenancy', () => {
  it('404s an answer in ANOTHER organization', async () => {
    stubConversation({ organizationId: 'org_2' })

    await expect(exportAnswerDocument(session, CONVERSATION_ID, ANSWER_ID)).rejects.toThrow(
      NotFoundError
    )
    // Nothing was read, so nothing could have been written into a file.
    expect(listMessagesForConversation).not.toHaveBeenCalled()
  })

  it('404s a colleague’s PRIVATE thread, even inside a project the caller reaches', async () => {
    stubConversation({ createdBy: 'user_someone_else', visibility: 'private' })

    await expect(exportAnswerDocument(session, CONVERSATION_ID, ANSWER_ID)).rejects.toThrow(
      NotFoundError
    )
  })

  it('404s when the container project is unreachable, whatever the visibility says', async () => {
    stubConversation({ createdBy: 'user_someone_else', visibility: 'project' })
    stubContainer('denied')

    await expect(exportAnswerDocument(session, CONVERSATION_ID, ANSWER_ID)).rejects.toThrow(
      NotFoundError
    )
  })

  it('serves a colleague’s thread once a grant names the caller', async () => {
    stubConversation({ createdBy: 'user_someone_else', visibility: 'private' })
    vi.mocked(findGrantForSubject).mockResolvedValue({ role: 'viewer' } as never)

    const exported = await exportAnswerDocument(session, CONVERSATION_ID, ANSWER_ID)

    expect(exported.bytes.byteLength).toBeGreaterThan(0)
  })

  it('404s a message id that belongs to a DIFFERENT conversation', async () => {
    // The history is this conversation's, resolved through the access check
    // above — an id that is not in it never resolves, so a guessed message id
    // cannot pull an answer out of another thread.
    vi.mocked(listMessagesForConversation).mockResolvedValue([message({ id: QUESTION_ID })])

    await expect(exportAnswerDocument(session, CONVERSATION_ID, ANSWER_ID)).rejects.toThrow(
      NotFoundError
    )
  })

  it('refuses to export a message that is not an answer', async () => {
    vi.mocked(listMessagesForConversation).mockResolvedValue([
      message({ id: ANSWER_ID, role: 'user', content: 'Wie lang darf der Fluchtweg sein?' }),
    ])

    await expect(exportAnswerDocument(session, CONVERSATION_ID, ANSWER_ID)).rejects.toThrow(
      UnprocessableError
    )
  })
})

describe('the exported file', () => {
  it('carries the question, the project and the answer, named after the thread', async () => {
    const exported = await exportAnswerDocument(session, CONVERSATION_ID, ANSWER_ID)
    const xml = documentXml(exported.bytes)

    expect(exported.filename).toBe('fluchtwege-bauteil-b-2026-05-04.docx')
    expect(exported.mediaType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    expect(xml).toContain('Wie lang darf der Fluchtweg sein?')
    expect(xml).toContain('Wohnhaus Seestadt')
    expect(xml).toContain('40 m nicht überschreiten')
  })

  it('reads the confidence off the stored provenance, and skips it when absent', async () => {
    vi.mocked(listMessagesForConversation).mockResolvedValue([
      message({
        metadata: {
          provenance: {
            answerConfidence: 'medium',
            answerConfidenceReason: 'Die Quelle nennt die Länge.',
          },
        },
      }),
    ])
    const withConfidence = documentXml(
      (await exportAnswerDocument(session, CONVERSATION_ID, ANSWER_ID)).bytes
    )
    expect(withConfidence).toContain('Verl')
    expect(withConfidence).toContain('Die Quelle nennt die L')

    vi.mocked(listMessagesForConversation).mockResolvedValue([message({ metadata: {} })])
    const without = documentXml(
      (await exportAnswerDocument(session, CONVERSATION_ID, ANSWER_ID)).bytes
    )
    expect(without).not.toContain('Begr')
  })

  it('leaves the project out when the chat hangs off no project', async () => {
    stubConversation({ projectId: null })

    const xml = documentXml((await exportAnswerDocument(session, CONVERSATION_ID, ANSWER_ID)).bytes)

    expect(findProjectInOrg).not.toHaveBeenCalled()
    expect(xml).not.toContain('Projekt')
  })
})
