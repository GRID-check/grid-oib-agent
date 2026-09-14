/**
 * @vitest-environment node
 */
/**
 * The lifecycle routes, driven through the TYPED CLIENT rather than through
 * hand-built `Request`s.
 *
 * That is ADR-0055's claim under test, not a convenience: "the UI, the agent's
 * tools, the task runner and any later integration are equal clients of one
 * HTTP API with a typed client". A spec that posted its own JSON would assert
 * the handlers work and prove nothing about the client every other consumer
 * uses — and the two would be free to disagree about a path or a field name
 * with nothing to notice.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'a@grid.test',
    role: 'admin',
    permissions: [],
  }),
}))

vi.mock('@/lib/documents/lifecycle', () => ({
  listDocumentVersionViews: vi.fn(),
  getDocumentVersionView: vi.fn(),
  forkDraftVersion: vi.fn(),
  replaceVersionContent: vi.fn(),
  transitionDocumentVersion: vi.fn(),
  toDocumentVersionView: (value: unknown) => value,
}))
// The byte half of the lifecycle lives next door (`version-content`).
vi.mock('@/lib/documents/version-content', () => ({
  archiveDocument: vi.fn(),
  readVersionContent: vi.fn(),
}))

import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import {
  forkDraftVersion,
  getDocumentVersionView,
  listDocumentVersionViews,
  replaceVersionContent,
  transitionDocumentVersion,
} from '@/lib/documents/lifecycle'
import { archiveDocument, readVersionContent } from '@/lib/documents/version-content'
import { createDocumentLifecycleClient, DocumentLifecycleError } from '@/lib/documents/lifecycle-client'
import type { DocumentVersionView } from '@/lib/documents/lifecycle-types'

import { GET as listVersions, POST as forkDraft } from './route'
import { GET as getVersion } from './[versionId]/route'
import { PUT as putContent } from './[versionId]/content/route'
import { POST as submit } from './[versionId]/submit/route'
import { POST as approve } from './[versionId]/approve/route'
import { POST as requestChanges } from './[versionId]/changes/route'
import { POST as reject } from './[versionId]/reject/route'
import { POST as publish } from './[versionId]/publish/route'
import { GET as diff } from './diff/route'
import { POST as archive } from '../archive/route'

type Handler = (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>

/**
 * The routing table this suite stands in for Next.js with. Written out because
 * a spec that guessed which handler a path belongs to would pass while the app
 * mounted it somewhere else.
 */
const ROUTES: Array<{ pattern: RegExp; method: string; handler: Handler; params: string[] }> = [
  { pattern: /^\/api\/documents\/([^/]+)\/versions$/, method: 'GET', handler: listVersions, params: ['id'] },
  { pattern: /^\/api\/documents\/([^/]+)\/versions$/, method: 'POST', handler: forkDraft, params: ['id'] },
  { pattern: /^\/api\/documents\/([^/]+)\/versions\/diff$/, method: 'GET', handler: diff, params: ['id'] },
  { pattern: /^\/api\/documents\/([^/]+)\/archive$/, method: 'POST', handler: archive, params: ['id'] },
  { pattern: /^\/api\/documents\/([^/]+)\/versions\/([^/]+)$/, method: 'GET', handler: getVersion, params: ['id', 'versionId'] },
  { pattern: /^\/api\/documents\/([^/]+)\/versions\/([^/]+)\/content$/, method: 'PUT', handler: putContent, params: ['id', 'versionId'] },
  { pattern: /^\/api\/documents\/([^/]+)\/versions\/([^/]+)\/submit$/, method: 'POST', handler: submit, params: ['id', 'versionId'] },
  { pattern: /^\/api\/documents\/([^/]+)\/versions\/([^/]+)\/approve$/, method: 'POST', handler: approve, params: ['id', 'versionId'] },
  { pattern: /^\/api\/documents\/([^/]+)\/versions\/([^/]+)\/changes$/, method: 'POST', handler: requestChanges, params: ['id', 'versionId'] },
  { pattern: /^\/api\/documents\/([^/]+)\/versions\/([^/]+)\/reject$/, method: 'POST', handler: reject, params: ['id', 'versionId'] },
  { pattern: /^\/api\/documents\/([^/]+)\/versions\/([^/]+)\/publish$/, method: 'POST', handler: publish, params: ['id', 'versionId'] },
]

const client = createDocumentLifecycleClient(async (path, init) => {
  const url = new URL(path, 'https://grid.test')
  const method = init?.method ?? 'GET'
  const route = ROUTES.find((entry) => entry.pattern.test(url.pathname) && entry.method === method)
  if (!route) throw new Error(`no route for ${method} ${url.pathname}`)
  const matched = route.pattern.exec(url.pathname) as RegExpExecArray
  const params = Object.fromEntries(route.params.map((name, index) => [name, matched[index + 1]]))
  return route.handler(new Request(url, init), { params: Promise.resolve(params) })
})

const VIEW: DocumentVersionView = {
  id: 'ver_1',
  documentId: 'doc_1',
  versionNumber: 2,
  state: 'in_review',
  contentType: 'text/markdown',
  fileSize: 12,
  contentHash: 'sha256:abc',
  submittedBy: 'user_author',
  submittedAt: '2026-09-01T00:00:00.000Z',
  reviewedBy: null,
  reviewedAt: null,
  approvedBy: null,
  approvedAt: null,
  publishedBy: null,
  publishedAt: null,
  reviewComment: null,
  createdBy: 'user_author',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(transitionDocumentVersion).mockResolvedValue(VIEW as never)
  vi.mocked(forkDraftVersion).mockResolvedValue(VIEW as never)
  vi.mocked(replaceVersionContent).mockResolvedValue(VIEW as never)
  vi.mocked(getDocumentVersionView).mockResolvedValue(VIEW)
})

describe('GET /api/documents/[id]/versions', () => {
  it('returns the list the service resolved, with the item’s lifecycle and pointer', async () => {
    vi.mocked(listDocumentVersionViews).mockResolvedValue({
      documentId: 'doc_1',
      lifecycle: 'active',
      publishedVersionId: 'ver_0',
      versions: [VIEW],
    })

    await expect(client.listVersions('doc_1')).resolves.toEqual({
      documentId: 'doc_1',
      lifecycle: 'active',
      publishedVersionId: 'ver_0',
      versions: [VIEW],
    })
    expect(listDocumentVersionViews).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      'doc_1',
    )
  })
})

describe('POST /api/documents/[id]/versions', () => {
  it('forks a draft and answers 201', async () => {
    await expect(client.forkDraft('doc_1')).resolves.toEqual(VIEW)
    expect(forkDraftVersion).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      'doc_1',
      expect.any(Request),
    )
  })

  it('surfaces "there is already a draft" as a 409 the caller can act on', async () => {
    vi.mocked(forkDraftVersion).mockRejectedValue(
      new ConflictError('This document already has an open version', { versionId: 'ver_open' }),
    )
    await expect(client.forkDraft('doc_1')).rejects.toMatchObject({
      status: 409,
      details: { versionId: 'ver_open' },
    })
  })
})

describe('PUT …/content', () => {
  it('passes the whole body and the If-Match through', async () => {
    await client.replaceContent('doc_1', 'ver_1', '# Aktenvermerk', 'sha256:abc')
    expect(replaceVersionContent).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      'doc_1',
      'ver_1',
      '# Aktenvermerk',
      'sha256:abc',
      { request: expect.any(Request) },
    )
  })

  it('rejects a body with no If-Match without reaching the service', async () => {
    const response = await putContent(
      new Request('https://grid.test/api/documents/doc_1/versions/ver_1/content', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'x' }),
      }),
      { params: Promise.resolve({ id: 'doc_1', versionId: 'ver_1' }) },
    )
    expect(response.status).toBe(400)
    expect(replaceVersionContent).not.toHaveBeenCalled()
  })
})

describe('the review verbs', () => {
  it('submit carries the reviewers', async () => {
    await client.submit('doc_1', 'ver_1', ['user_a'])
    expect(transitionDocumentVersion).toHaveBeenCalledWith(
      expect.anything(),
      'doc_1',
      'ver_1',
      'submit',
      expect.objectContaining({ reviewerUserIds: ['user_a'] }),
    )
  })

  it('submit carries the order and Frist through to the round', async () => {
    await client.submit('doc_1', 'ver_1', ['user_a'], {
      orderMessage: 'Bitte die Fluchtweglänge prüfen.',
      dueAt: '2026-09-20',
    })
    expect(transitionDocumentVersion).toHaveBeenCalledWith(
      expect.anything(),
      'doc_1',
      'ver_1',
      'submit',
      expect.objectContaining({
        reviewerUserIds: ['user_a'],
        orderMessage: 'Bitte die Fluchtweglänge prüfen.',
        dueAt: '2026-09-20',
      }),
    )
  })

  it.each([
    ['empty order', { reviewerUserIds: [], orderMessage: '   ' }],
    ['overlong order', { reviewerUserIds: [], orderMessage: 'x'.repeat(501) }],
    ['rolled-over date', { reviewerUserIds: [], dueAt: '2026-02-30' }],
    ['malformed date', { reviewerUserIds: [], dueAt: 'next Friday' }],
  ])('submit refuses %s at the schema, before the service', async (_label, body) => {
    const response = await submit(
      new Request('https://grid.test/api/documents/doc_1/versions/ver_1/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: 'doc_1', versionId: 'ver_1' }) },
    )
    expect(response.status).toBe(400)
    expect(transitionDocumentVersion).not.toHaveBeenCalled()
  })

  it('approve takes an optional comment', async () => {
    await client.approve('doc_1', 'ver_1')
    expect(transitionDocumentVersion).toHaveBeenCalledWith(
      expect.anything(),
      'doc_1',
      'ver_1',
      'approve',
      expect.objectContaining({ comment: undefined }),
    )
  })

  it.each([
    ['changes', 'request_changes', (comment: string) => client.requestChanges('doc_1', 'ver_1', comment)],
    ['reject', 'reject', (comment: string) => client.reject('doc_1', 'ver_1', comment)],
  ])('%s requires words and passes them to op %s', async (_route, op, call) => {
    await call('Der Atrium-Fall ist OIB 2.3')
    expect(transitionDocumentVersion).toHaveBeenCalledWith(
      expect.anything(),
      'doc_1',
      'ver_1',
      op,
      expect.objectContaining({ comment: 'Der Atrium-Fall ist OIB 2.3' }),
    )
  })

  it.each([
    ['changes', requestChanges],
    ['reject', reject],
  ])('%s refuses an empty comment at the schema, before the service', async (route, handler) => {
    const response = await handler(
      new Request(`https://grid.test/api/documents/doc_1/versions/ver_1/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: '   ' }),
      }),
      { params: Promise.resolve({ id: 'doc_1', versionId: 'ver_1' }) },
    )
    expect(response.status).toBe(400)
    expect(transitionDocumentVersion).not.toHaveBeenCalled()
  })

  it('publish asks for the publish op and nothing else', async () => {
    await client.publish('doc_1', 'ver_1')
    expect(transitionDocumentVersion).toHaveBeenCalledWith(
      expect.anything(),
      'doc_1',
      'ver_1',
      'publish',
      expect.objectContaining({ request: expect.any(Request) }),
    )
  })

  it('maps a service refusal to 403 and keeps its code', async () => {
    vi.mocked(transitionDocumentVersion).mockRejectedValue(
      new ForbiddenError('The submitter cannot approve their own version'),
    )
    await expect(client.approve('doc_1', 'ver_1')).rejects.toBeInstanceOf(DocumentLifecycleError)
    await expect(client.approve('doc_1', 'ver_1')).rejects.toMatchObject({ status: 403 })
  })
})

describe('GET …/versions/diff', () => {
  it('returns both contents and lets the client render', async () => {
    vi.mocked(readVersionContent)
      .mockResolvedValueOnce('alt')
      .mockResolvedValueOnce('neu')

    const result = await client.diff('doc_1', 'ver_1', 'ver_2')

    expect(result.from.content).toBe('alt')
    expect(result.to.content).toBe('neu')
  })

  it('refuses a request that names only one side', async () => {
    const response = await diff(
      new Request('https://grid.test/api/documents/doc_1/versions/diff?from=ver_1'),
      { params: Promise.resolve({ id: 'doc_1' }) },
    )
    expect(response.status).toBe(400)
  })
})

describe('POST /api/documents/[id]/archive', () => {
  it('returns the item’s new lifecycle', async () => {
    vi.mocked(archiveDocument).mockResolvedValue({ documentId: 'doc_1', lifecycle: 'archived' })
    await expect(client.archive('doc_1')).resolves.toEqual({
      documentId: 'doc_1',
      lifecycle: 'archived',
    })
  })

  it('maps a missing document to 404', async () => {
    vi.mocked(archiveDocument).mockRejectedValue(new NotFoundError())
    await expect(client.archive('doc_1')).rejects.toMatchObject({ status: 404 })
  })
})
