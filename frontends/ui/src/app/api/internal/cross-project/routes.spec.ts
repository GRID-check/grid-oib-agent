/**
 * @vitest-environment node
 */
/**
 * The three agent routes of the cross-project lookups (ADR-0094) are thin
 * adapters, and what is theirs to hold is the identity: the acting person is
 * the signed envelope's (a pinned session), never anything the body says; a
 * request without an envelope gets nothing; the conversation and the project
 * are the envelope's; the tenant is the envelope's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
}))
vi.mock('@/lib/cross-project/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/cross-project/service')>()),
  searchAcrossProjects: vi.fn(async () => ({ hits: [], projectsInScope: 0, projectsSearched: 0, nextOffset: null })),
  listLookupProjects: vi.fn(async () => ({ projects: [], total: 0 })),
  readProjectBrief: vi.fn(async () => ({ summary: null, facts: '' })),
}))

import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { listLookupProjects, readProjectBrief, searchAcrossProjects } from '@/lib/cross-project/service'
import { withTenant } from '@/lib/db/tenant-context'
import { buildGridRequestContextEnvelope, GRID_HEADER_NAMES } from '@/lib/request-context'
import { POST as brief } from './brief/route'
import { POST as projects } from './projects/route'
import { POST as search } from './search/route'

const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const PROJECT = '33333333-3333-4333-8333-333333333333'
const CONV = 's_conv_1'

const session = {
  userId: 'user_requester',
  email: 'r@grid.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member' as const,
  permissions: [],
  featureFlags: null,
}

function envelopeHeaders(overrides: { conversationId?: string | null; projectId?: string | null } = {}) {
  const { header, signature } = buildGridRequestContextEnvelope(
    {
      organizationId: 'org_1',
      userId: 'user_requester',
      ...(overrides.projectId === null ? {} : { projectId: overrides.projectId ?? PROJECT }),
      ...(overrides.conversationId === null ? {} : { conversationId: overrides.conversationId ?? CONV }),
      issuedAt: Date.now(),
    },
    SECRET
  )
  return { [GRID_HEADER_NAMES.REQUEST_CONTEXT]: header, [GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG]: signature ?? '' }
}

function request(path: string, body: unknown, headers: Record<string, string> = envelopeHeaders()) {
  return new Request(`https://grid.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-grid-internal-token': SECRET, ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', SECRET)
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(session)
})

describe('the lookups act as the envelope’s person, in the envelope’s conversation', () => {
  it('searches as the pinned session, in the envelope’s tenant, conversation and project', async () => {
    const response = await search(request('/api/internal/cross-project/search', { query: 'Dachdetail', userId: 'user_evil' }))

    expect(response.status).toBe(200)
    expect(vi.mocked(searchAcrossProjects)).toHaveBeenCalledWith(
      { session, conversationId: CONV, currentProjectId: PROJECT, answerMessageId: null },
      expect.objectContaining({ query: 'Dachdetail', scope: 'similar' })
    )
    expect(vi.mocked(withTenant)).toHaveBeenCalledWith({ organizationId: 'org_1' }, expect.any(Function))
  })

  it('lists and reads a brief the same way, a chat outside every project included', async () => {
    expect((await projects(request('/api/internal/cross-project/projects', {}))).status).toBe(200)
    expect(vi.mocked(listLookupProjects).mock.calls[0][0]).toMatchObject({ conversationId: CONV })

    const outside = envelopeHeaders({ projectId: null })
    expect((await brief(request('/api/internal/cross-project/brief', { projectId: PROJECT }, outside))).status).toBe(200)
    expect(vi.mocked(readProjectBrief).mock.calls[0][0]).toMatchObject({ currentProjectId: null })
  })

  it('carries the answer the turn is writing to the hand-out record, and nothing that is not a uuid', async () => {
    const answer = '5a5a5a5a-0000-4000-8000-000000000001'
    await search(request('/api/internal/cross-project/search', { query: 'Dachdetail', answerMessageId: answer }))
    await projects(request('/api/internal/cross-project/projects', { answerMessageId: answer }))
    await brief(request('/api/internal/cross-project/brief', { projectId: PROJECT, answerMessageId: answer }))

    expect(vi.mocked(searchAcrossProjects).mock.calls[0][0]).toMatchObject({ answerMessageId: answer })
    expect(vi.mocked(listLookupProjects).mock.calls[0][0]).toMatchObject({ answerMessageId: answer })
    expect(vi.mocked(readProjectBrief).mock.calls[0][0]).toMatchObject({ answerMessageId: answer })
    const bad = { query: 'Dach', answerMessageId: 'not-a-uuid' }
    expect((await search(request('/api/internal/cross-project/search', bad))).status).toBe(400)
  })

  it('refuses a request with no envelope, and one whose turn has no conversation', async () => {
    expect((await search(request('/api/internal/cross-project/search', { query: 'Dach' }, {}))).status).toBe(401)
    const noConversation = envelopeHeaders({ conversationId: null })
    expect((await search(request('/api/internal/cross-project/search', { query: 'Dach' }, noConversation))).status).toBe(400)
    expect(vi.mocked(searchAcrossProjects)).not.toHaveBeenCalled()
  })

  it('refuses a person who is no longer a member', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)

    expect((await projects(request('/api/internal/cross-project/projects', {}))).status).toBe(403)
  })
})
