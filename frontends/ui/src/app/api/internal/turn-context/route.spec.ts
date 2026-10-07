/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ findConversationTenancy: vi.fn() }))
vi.mock('@/lib/project-profile/prompt-view', () => ({ loadProjectPromptView: vi.fn() }))
vi.mock('@/lib/org-instructions/service', () => ({ resolveOrgInstructions: vi.fn() }))
vi.mock('@/lib/projects/memory-service', () => ({ buildProjectMemoryDigest: vi.fn() }))
vi.mock('@/lib/projects/proposal-decisions', async (original) => ({
  ...(await original<typeof import('@/lib/projects/proposal-decisions')>()),
  buildProposalDecisionsBlock: vi.fn(),
}))
vi.mock('@/lib/documents/review-decisions', () => ({ buildReviewDecisionsBlock: vi.fn() }))
vi.mock('@/lib/conversations/cross-project-use', () => ({ drewOnOtherProjects: vi.fn(async () => false) }))
vi.mock('@/lib/db/tenant-context', async (original) => ({
  ...(await original<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
  withPlatformAccess: vi.fn(async (_reason: string, run: () => Promise<unknown>) => run()),
}))

import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { requireProjectAccess } from '@/lib/authz/projects'
import { CHAT_PERMISSIONS } from '@/lib/authz/chat'
import { requireResourceAccess } from '@/lib/sharing/access'
import { findConversationTenancy } from '@/lib/conversations/repository'
import { withTenant, withPlatformAccess } from '@/lib/db/tenant-context'
import { loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { resolveOrgInstructions } from '@/lib/org-instructions/service'
import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { buildProposalDecisionsBlock } from '@/lib/projects/proposal-decisions'
import { buildReviewDecisionsBlock } from '@/lib/documents/review-decisions'
import { drewOnOtherProjects } from '@/lib/conversations/cross-project-use'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import {
  buildGridRequestContextEnvelopeHeaders, GRID_REQUEST_CONTEXT_MAX_AGE_MS,
  type GridRequestContextInput,
} from '@/lib/request-context'
import { turnContextResponseSchema } from '@/lib/turn-context/wire'
import { POST } from './route'

const SECRET = 'turn-context-test-token' // pragma: allowlist secret
const SESSION = {
  userId: 'user_1', organizationId: 'org_1', email: 'requester@grid.test', name: null,
  organizationMembershipId: 'om_1', role: 'member', permissions: [],
  accessToken: '', featureFlags: null,
}
const LARGE_PROFILE = 'PROJECT_CONTEXT v1\n' + 'ä'.repeat(4000)

function signedHeaders(overrides: GridRequestContextInput = {}) {
  return buildGridRequestContextEnvelopeHeaders({
    organizationId: 'org_1', userId: 'user_1', projectId: 'proj_1',
    conversationId: 's_text-conversation', issuedAt: Date.now(), contextTransport: 'bff',
    ...overrides,
  }, SECRET)
}

function call(body: unknown = {}, headers: Record<string, string> = signedHeaders()) {
  return POST(new Request('https://grid.test/api/internal/turn-context', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-grid-internal-token': SECRET, ...headers },
    body: JSON.stringify(body),
  }))
}

beforeEach(() => {
  vi.resetAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(SESSION)
  vi.mocked(withTenant).mockImplementation(async (_scope, run) => run())
  vi.mocked(withPlatformAccess).mockImplementation(async (_reason, run) => run())
  vi.mocked(findConversationTenancy).mockResolvedValue({
    organizationId: 'org_1', projectId: 'proj_1', visibility: 'private',
    createdBy: 'user_1', deletedAt: null,
  })
  vi.mocked(loadProjectPromptView).mockResolvedValue(LARGE_PROFILE)
  vi.mocked(resolveOrgInstructions).mockResolvedValue('Standing instructions')
  vi.mocked(buildProjectMemoryDigest).mockResolvedValue('Digest')
  vi.mocked(buildProposalDecisionsBlock).mockResolvedValue('Proposal decisions')
  vi.mocked(buildReviewDecisionsBlock).mockResolvedValue('Review decisions')
})

describe('POST /api/internal/turn-context', () => {
  it('says when the conversation drew on another project (ADR-0093), so the turn starts with its doors shut', async () => {
    vi.mocked(drewOnOtherProjects).mockResolvedValueOnce(true)

    const { data } = await (await call()).json()

    expect(data.drewOnOtherProjects).toBe(true)
    expect(drewOnOtherProjects).toHaveBeenCalledWith('s_text-conversation', 'org_1')
  })

  it('returns the complete >6200-byte profile through a body, with current memory and instructions', async () => {
    const response = await call({ query: '  fire safety  ' })
    expect(response.status).toBe(200)
    const { data } = await response.json()
    expect(turnContextResponseSchema.parse(data)).toEqual({
      projectContext: LARGE_PROFILE,
      projectMemory: 'Digest\n\nProposal decisions\n\nReview decisions',
      orgInstructions: 'Standing instructions',
      drewOnOtherProjects: false,
    })
    expect(Buffer.byteLength(data.projectContext)).toBeGreaterThan(6200)
    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith({
      userId: 'user_1', organizationId: 'org_1', email: null,
    })
    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_1', userId: 'user_1' }, expect.any(Function))
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, 'proj_1', CHAT_PERMISSIONS)
    expect(requireResourceAccess).toHaveBeenCalledWith(SESSION, 'conversation', 's_text-conversation', 'viewer')
    expect(withPlatformAccess).toHaveBeenCalledWith(expect.stringContaining('existence probe'), expect.any(Function))
    expect(loadProjectPromptView).toHaveBeenCalledWith('proj_1', 'org_1')
    expect(buildProjectMemoryDigest).toHaveBeenCalledWith('proj_1', 'org_1', { query: 'fire safety' })
    expect(buildReviewDecisionsBlock).toHaveBeenCalledWith('s_text-conversation', 'org_1')
    expect(resolveOrgInstructions).toHaveBeenCalledWith('org_1')
  })

  it.each(['organizationId', 'userId', 'projectId', 'conversationId'])('refuses a body %s override', async (field) => {
    expect((await call({ [field]: 'attacker-choice' })).status).toBe(400)
    expect(loadProjectPromptView).not.toHaveBeenCalled()
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
  })

  it('checks the service token independently of a valid signed capsule', async () => {
    expect((await call({}, { ...signedHeaders(), 'x-grid-internal-token': 'wrong' })).status).toBe(403)
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
  })

  it('fails closed without a configured token', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await call()).status).toBe(503)
    expect(loadProjectPromptView).not.toHaveBeenCalled()
  })

  it('refuses unsigned, tampered, expired and anonymous capsules', async () => {
    for (const headers of [
      {},
      { ...signedHeaders(), 'X-Grid-Request-Context-Sig': 'f'.repeat(64) },
      signedHeaders({ issuedAt: Date.now() - GRID_REQUEST_CONTEXT_MAX_AGE_MS - 1000 }),
      signedHeaders({ organizationId: null, userId: null }),
    ]) expect((await call({}, headers)).status).toBe(401)
    expect(loadProjectPromptView).not.toHaveBeenCalled()
  })

  it('checks current membership again on each turn', async () => {
    expect((await call()).status).toBe(200)
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    vi.mocked(loadProjectPromptView).mockClear()
    expect((await call()).status).toBe(403)
    expect(loadProjectPromptView).not.toHaveBeenCalled()
  })

  it('does not mistake a deleted conversation for a new initial turn', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_1', projectId: 'proj_1', visibility: 'private',
      createdBy: 'user_1', deletedAt: new Date(),
    })
    expect((await call()).status).toBe(404)
    expect(loadProjectPromptView).not.toHaveBeenCalled()
  })

  it('refuses lost project access before reading any prompt data', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    expect((await call()).status).toBe(404)
    expect(loadProjectPromptView).not.toHaveBeenCalled()
    expect(resolveOrgInstructions).not.toHaveBeenCalled()
  })

  it('refuses lost conversation access rather than treating it as a first turn', async () => {
    vi.mocked(requireResourceAccess).mockRejectedValue(new NotFoundError())
    expect((await call()).status).toBe(404)
    expect(buildReviewDecisionsBlock).not.toHaveBeenCalled()
    expect(loadProjectPromptView).not.toHaveBeenCalled()
  })

  it('refuses a foreign conversation even if the tenant-scoped lookup would hide it', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue({
      organizationId: 'org_foreign', projectId: null, visibility: 'private',
      createdBy: 'user_foreign', deletedAt: null,
    })
    expect((await call()).status).toBe(404)
    expect(loadProjectPromptView).not.toHaveBeenCalled()
  })

  it('permits a genuinely not-yet-created conversation for the initial turn', async () => {
    vi.mocked(findConversationTenancy).mockResolvedValue(null)
    expect((await call()).status).toBe(200)
    expect(requireResourceAccess).not.toHaveBeenCalled()
    expect(requireProjectAccess).toHaveBeenCalled()
  })

  it('preserves org-wide context when the capsule has no project or conversation', async () => {
    vi.mocked(buildProposalDecisionsBlock).mockClear()
    const response = await call({}, signedHeaders({ projectId: null, conversationId: null }))
    expect(response.status).toBe(200)
    expect((await response.json()).data.projectContext).toBeNull()
    expect(loadProjectPromptView).not.toHaveBeenCalled()
    expect(requireProjectAccess).not.toHaveBeenCalled()
    expect(buildProposalDecisionsBlock).not.toHaveBeenCalled()
    expect(buildProjectMemoryDigest).toHaveBeenCalledWith(undefined, 'org_1', { query: undefined })
  })

  it('rejects malformed query types and trimmed queries exceeding 2000 characters', async () => {
    expect((await call({ query: 'a'.repeat(2001) })).status).toBe(400)
    expect((await call({ query: 42 })).status).toBe(400)
    expect((await call({ query: ' ' + 'a'.repeat(2000) + ' ' })).status).toBe(200)
  })

  it('never turns prompt authorization or read failures into a success fallback', async () => {
    vi.mocked(loadProjectPromptView).mockRejectedValue(new ForbiddenError())
    expect((await call()).status).toBe(403)
    vi.mocked(loadProjectPromptView).mockRejectedValue(new Error('Database unavailable'))
    expect((await call()).status).toBe(500)
  })

  it('keeps proposal/review decisions best-effort without losing the memory digest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(buildProposalDecisionsBlock).mockRejectedValue(new Error('scan failed'))
    vi.mocked(buildReviewDecisionsBlock).mockRejectedValue(new Error('scan failed'))
    const response = await call()
    expect(response.status).toBe(200)
    expect((await response.json()).data.projectMemory).toBe('Digest')
    expect(warn.mock.calls.map(([message]) => message)).toEqual(expect.arrayContaining([
      '[Turn Context API] Failed to load proposal decisions:',
      '[Turn Context API] Failed to load review decisions:',
    ]))
    warn.mockRestore()
  })
})
