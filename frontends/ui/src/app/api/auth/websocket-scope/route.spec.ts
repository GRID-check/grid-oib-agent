/**
 * @vitest-environment node
 *
 * Gate-then-fanout cover for the WebSocket upgrade scope route: a blocked
 * budget must refuse BEFORE the project-expensive lookups fire, every
 * project-scoped lookup must use the effective (authorized-or-query) project,
 * and the prompt-view denial must still be a 403 without breaking the fan-out.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/tenant-context', () => ({ tenantSlotRoute: (handler: unknown) => handler }))
vi.mock('@/lib/backend-proxy', () => ({ isAuthRequired: () => true }))

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
    expect(loadProjectPromptView).toHaveBeenCalledWith('proj_implicit', 'org_1')
    expect(loadProjectBundesland).toHaveBeenCalledWith('proj_implicit', 'org_1')
    expect(buildProjectMemoryDigest).toHaveBeenCalledWith('proj_implicit', 'org_1')
    expect(buildProposalDecisionsBlock).toHaveBeenCalledWith('proj_implicit', 'org_1')
    expect(await response.json()).toMatchObject({ projectId: 'proj_implicit' })
  })

  it('falls back to the query project when the scope carries none', async () => {
    buildCollectionScopeFromRequest.mockResolvedValue(scopeReturning(undefined))

    const response = await upgrade()

    expect(response.status).toBe(200)
    expect(getBudgetStatus).toHaveBeenCalledWith('org_1', 'user_1', 'proj_q')
    expect(loadProjectPromptView).toHaveBeenCalledWith('proj_q', 'org_1')
    expect(await response.json()).toMatchObject({ projectId: 'proj_q' })
  })

  it('maps a prompt-view denial to 403 without cancelling the fan-out', async () => {
    loadProjectPromptView.mockRejectedValue(new Error('Not found'))

    const response = await upgrade()

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'Forbidden' })
    // The denial is stashed, not thrown: the sibling lookups still ran.
    expect(loadProjectBundesland).toHaveBeenCalled()
    expect(buildProjectMemoryDigest).toHaveBeenCalled()
  })

  it('keeps a non-authz prompt-view failure as a 500', async () => {
    loadProjectPromptView.mockRejectedValue(new Error('db exploded'))

    const response = await upgrade()

    expect(response.status).toBe(500)
  })
})
