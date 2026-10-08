/**
 * @vitest-environment node
 *
 * The compact handshake keeps scope/budget gates but does not load prompt blocks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/tenant-context', () => ({ tenantSlotRoute: (handler: unknown) => handler }))
const isAuthRequired = vi.fn()
vi.mock('@/lib/backend-proxy', () => ({ isAuthRequired: () => isAuthRequired() }))

const getGridSession = vi.fn()
vi.mock('@/lib/auth/session', () => ({
  getGridSession: (...args: unknown[]) => getGridSession(...args),
}))

const buildCollectionScopeFromRequest = vi.fn()
vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: (...args: unknown[]) => buildCollectionScopeFromRequest(...args),
}))

const loadProjectPromptView = vi.fn()
const loadProjectBundesland = vi.fn()
vi.mock('@/lib/project-profile/prompt-view', () => ({
  loadProjectPromptView: (...args: unknown[]) => loadProjectPromptView(...args),
  loadProjectBundesland: (...args: unknown[]) => loadProjectBundesland(...args),
}))

const buildProposalDecisionsBlock = vi.fn()
vi.mock('@/lib/projects/proposal-decisions', () => ({
  buildProposalDecisionsBlock: (...args: unknown[]) => buildProposalDecisionsBlock(...args),
  composeMemoryContext: (digest: string | null, decisions: string | null) =>
    [digest, decisions].filter((part): part is string => Boolean(part)).join('\n\n') || null,
}))

const buildProjectMemoryDigest = vi.fn()
vi.mock('@/lib/projects/memory-service', () => ({
  buildProjectMemoryDigest: (...args: unknown[]) => buildProjectMemoryDigest(...args),
}))

const isMemoryReflectionEnabled = vi.fn()
vi.mock('@/lib/workos/feature-flags', () => ({
  isMemoryReflectionEnabled: (...args: unknown[]) => isMemoryReflectionEnabled(...args),
}))

const isWebSearchEnabledForOrg = vi.fn()
vi.mock('@/lib/organizations/service', () => ({
  isWebSearchEnabledForOrg: (...args: unknown[]) => isWebSearchEnabledForOrg(...args),
}))

const getEffectiveModelOverrides = vi.fn()
vi.mock('@/lib/model-config/service', () => ({
  getEffectiveModelOverrides: (...args: unknown[]) => getEffectiveModelOverrides(...args),
}))

const resolveOrgInstructions = vi.fn()
vi.mock('@/lib/org-instructions/service', () => ({
  resolveOrgInstructions: (...args: unknown[]) => resolveOrgInstructions(...args),
}))

const getBudgetStatus = vi.fn()
vi.mock('@/lib/budgets/service', () => ({
  getBudgetStatus: (...args: unknown[]) => getBudgetStatus(...args),
}))

const { GET } = await import('./route')

const SESSION = {
  userId: 'user_1',
  email: 'someone@grid.com',
  name: 'Someone',
  accessToken: 'token',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

const OPEN_BUDGET = {
  blocked: false,
  blockedScope: null,
  remainingOrgUsd: 10,
  remainingUserUsd: 5,
  remainingProjectUsd: 2,
  remainingOrgTokens: 1000,
  remainingUserTokens: 500,
  remainingProjectTokens: 200,
}

function scopeReturning(projectId: string | undefined) {
  return {
    scope: ['base'],
    scopedCollections: [{ collection: 'base', shelf: 'base' }],
    headerValue: 'aGVsbG8',
    projectId,
    projectCollectionName: projectId ? `proj_${projectId}` : undefined,
    conversationId: undefined,
  }
}

const upgrade = (query = '?projectId=proj_q') =>
  GET(new Request(`http://localhost/api/auth/websocket-scope${query}`))

describe('GET /api/auth/websocket-scope gate-then-fanout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthRequired.mockReturnValue(true)
    getGridSession.mockResolvedValue(SESSION)
    buildCollectionScopeFromRequest.mockResolvedValue(scopeReturning('proj_q'))
    isMemoryReflectionEnabled.mockResolvedValue(true)
    getBudgetStatus.mockResolvedValue({ ...OPEN_BUDGET })
    isWebSearchEnabledForOrg.mockResolvedValue(true)
    getEffectiveModelOverrides.mockResolvedValue(null)
    loadProjectPromptView.mockResolvedValue('prompt-view')
    loadProjectBundesland.mockResolvedValue('bayern')
    buildProjectMemoryDigest.mockResolvedValue('digest')
    buildProposalDecisionsBlock.mockResolvedValue('decisions')
  })

  it('asks for an INTERACTIVE CHAT scope, the only one that may carry restricted folders (ADR-0086)', async () => {
    await upgrade('?projectId=proj_q&conversationId=s_mine')

    expect(buildCollectionScopeFromRequest).toHaveBeenCalledWith(SESSION, {
      projectId: 'proj_q',
      conversationId: 's_mine',
      interactiveChat: true,
    })
  })

  it('names no document of a restricted folder in the legacy inline project context and serves open memory only, whatever the scope carries (ADR-0084, ADR-0085)', async () => {
    // Listing is not use: the shared, cached prompt view names no restricted
    // document for anyone, and restricted memory reaches a turn only through
    // the live per-turn digest, which admits its folders for the conversation.
    // The authenticated handshake loads no prompt block at all, so the only
    // inline copy left is the anonymous legacy one.
    isAuthRequired.mockReturnValue(false)
    getGridSession.mockResolvedValue(null)
    const restricted = 'proj_proj_q_r0123456789ab'
    buildCollectionScopeFromRequest.mockResolvedValue({
      ...scopeReturning('proj_q'),
      scope: ['base', 'proj_proj_q', restricted],
    })

    await upgrade('?projectId=proj_q&conversationId=s_mine')
    expect(loadProjectPromptView).toHaveBeenCalledWith('proj_q', undefined)
    expect(buildProjectMemoryDigest).toHaveBeenCalledWith('proj_q', undefined)
  })

  it('returns 403 without firing the project lookups when the budget is blocked', async () => {
    getBudgetStatus.mockResolvedValue({ ...OPEN_BUDGET, blocked: true, blockedScope: 'org' })

    const response = await upgrade()

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'Budget exhausted' })
    expect(loadProjectPromptView).not.toHaveBeenCalled()
    expect(loadProjectBundesland).not.toHaveBeenCalled()
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
    expect(buildProposalDecisionsBlock).not.toHaveBeenCalled()
  })

  it('fails OPEN when the budget lookup itself errors', async () => {
    getBudgetStatus.mockRejectedValue(new Error('budgets down'))

    const response = await upgrade()

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ scope: ['base'] })
  })

  it('scopes every lookup to the implicit project when the query names none', async () => {
    buildCollectionScopeFromRequest.mockResolvedValue(scopeReturning('proj_implicit'))

    const response = await upgrade('')

    expect(response.status).toBe(200)
    // Before the effective-project fix every call below received `undefined`
    // here and silently missed the implicit project.
    expect(getBudgetStatus).toHaveBeenCalledWith('org_1', 'user_1', 'proj_implicit')
    expect(loadProjectBundesland).toHaveBeenCalledWith('proj_implicit', 'org_1')
    expect(await response.json()).toMatchObject({ projectId: 'proj_implicit' })
  })

  it('falls back to the query project when the scope carries none', async () => {
    buildCollectionScopeFromRequest.mockResolvedValue(scopeReturning(undefined))

    const response = await upgrade()

    expect(response.status).toBe(200)
    expect(getBudgetStatus).toHaveBeenCalledWith('org_1', 'user_1', 'proj_q')
    expect(await response.json()).toMatchObject({ projectId: 'proj_q' })
  })

  it('preserves the scope authorization gate', async () => {
    buildCollectionScopeFromRequest.mockRejectedValue(new Error('Not found'))

    const response = await upgrade()

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'Forbidden' })
    expect(loadProjectBundesland).not.toHaveBeenCalled()
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
  })

  it('never loads or emits large prompt blocks during the handshake', async () => {
    loadProjectPromptView.mockResolvedValue('ä'.repeat(3101))
    const response = await upgrade()
    expect(response.status).toBe(200)
    const body = await response.json()
    for (const field of ['projectContext', 'projectMemory', 'orgInstructions']) {
      expect(body).not.toHaveProperty(field)
    }
    expect(loadProjectPromptView).not.toHaveBeenCalled()
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
    expect(buildProposalDecisionsBlock).not.toHaveBeenCalled()
    expect(resolveOrgInstructions).not.toHaveBeenCalled()
  })

  it('preserves anonymous development with its legacy inline profile and memory', async () => {
    isAuthRequired.mockReturnValue(false)
    getGridSession.mockResolvedValue(null)
    const response = await upgrade()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ projectContext: 'prompt-view', projectMemory: 'digest' })
    expect(loadProjectPromptView).toHaveBeenCalledWith('proj_q', undefined)
    expect(buildProjectMemoryDigest).toHaveBeenCalledWith('proj_q', undefined)
    expect(resolveOrgInstructions).not.toHaveBeenCalled()
  })

  it('still uses compact context for a real session when REQUIRE_AUTH is disabled in development', async () => {
    isAuthRequired.mockReturnValue(false)
    expect((await upgrade()).status).toBe(200)
    expect(loadProjectPromptView).not.toHaveBeenCalled()
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
    expect(resolveOrgInstructions).not.toHaveBeenCalled()
  })

  it('preserves prompt access refusals in anonymous legacy mode', async () => {
    isAuthRequired.mockReturnValue(false)
    getGridSession.mockResolvedValue(null)
    loadProjectPromptView.mockRejectedValueOnce(new Error('Not found'))
    expect((await upgrade()).status).toBe(403)
  })
})
