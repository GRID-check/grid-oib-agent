/**
 * The platform reasoning-effort endpoint. The contract worth pinning down: only
 * the platform owner may write it, only the unified vocabulary is accepted, an
 * omitted group is a *clear* (that is how a group goes back to the workflow
 * config), and — unlike the model defaults — no upstream catalog is consulted,
 * so an OpenRouter outage can never block turning reasoning spend DOWN.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'owner-1',
  organizationId: 'org_platform',
  email: 'owner@grid.com',
  role: 'org-platform-owner',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/session', () => ({ getGridSession: async () => session }))
const requirePlatformPermission = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/authz/platform')>()
  return {
    ...original,
    requirePlatformPermission: (s: unknown) => requirePlatformPermission(s),
    getPlatformOrganizationId: vi.fn().mockResolvedValue('org_platform'),
  }
})

const recordAuditEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (e: unknown) => recordAuditEvent(e) }))

vi.mock('@/lib/model-config/backend-defaults', () => ({
  getWorkflowGroupReasoningEfforts: vi
    .fn()
    .mockResolvedValue({ intent: 'none', deep_research: 'medium' }),
}))

const listPlatformReasoningEfforts = vi.fn()
const savePlatformReasoningEfforts = vi.fn()
vi.mock('@/lib/reasoning-settings/service', () => ({
  listPlatformReasoningEfforts: () => listPlatformReasoningEfforts(),
  savePlatformReasoningEfforts: (input: unknown) => savePlatformReasoningEfforts(input),
}))

const put = (body: unknown): Request =>
  new Request('http://localhost/api/platform/reasoning-efforts', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })

describe('/api/platform/reasoning-efforts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requirePlatformPermission.mockResolvedValue(undefined)
    listPlatformReasoningEfforts.mockResolvedValue([
      {
        agentGroup: 'deep_research',
        effort: 'low',
        note: 'cheaper pilot',
        updatedBy: 'owner-1',
        updatedByEmail: 'owner@grid.com',
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
    ])
    savePlatformReasoningEfforts.mockImplementation(
      async (input: { efforts: Record<string, string> }) =>
        Object.entries(input.efforts).map(([agentGroup, effort]) => ({
          agentGroup,
          effort,
          note: null,
          updatedBy: 'owner-1',
          updatedByEmail: 'owner@grid.com',
          updatedAt: new Date('2026-08-01T00:00:00Z'),
        }))
    )
  })

  it('GET returns the registry, the pinned efforts and the workflow fallback', async () => {
    const { GET } = await import('./route')
    const res = await GET(new Request('http://localhost/api/platform/reasoning-efforts'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.efforts.deep_research).toMatchObject({ effort: 'low', note: 'cheaper pilot' })
    // Naming what a clear returns to is the whole point of showing this.
    expect(body.workflowEfforts).toEqual({ intent: 'none', deep_research: 'medium' })
    expect(body.agentGroups.length).toBeGreaterThan(0)
  })

  it('GET is refused for a non-platform-owner', async () => {
    const { PlatformAccessDeniedError } = await import('@/lib/authz/platform')
    requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())
    const { GET } = await import('./route')

    expect((await GET(new Request('http://localhost/api/platform/reasoning-efforts'))).status).toBe(
      403
    )
  })

  it('PUT saves a valid effort set', async () => {
    const { PUT } = await import('./route')
    const res = await PUT(
      put({ efforts: { intent: 'none', deep_research: 'xhigh' }, note: 'tuning' })
    )

    expect(res.status).toBe(200)
    expect(savePlatformReasoningEfforts).toHaveBeenCalledWith(
      expect.objectContaining({
        efforts: { intent: 'none', deep_research: 'xhigh' },
        note: 'tuning',
        actorUserId: 'owner-1',
      })
    )
    expect((await res.json()).efforts.deep_research.effort).toBe('xhigh')
  })

  it('PUT rejects a provider-native tier name', async () => {
    // DeepSeek's "max" — OpenRouter rejects it, so it must never be stored.
    const { PUT } = await import('./route')
    const res = await PUT(put({ efforts: { deep_research: 'max' } }))

    expect(res.status).toBe(400)
    expect(savePlatformReasoningEfforts).not.toHaveBeenCalled()
  })

  it('PUT rejects an unknown agent group', async () => {
    const { PUT } = await import('./route')
    const res = await PUT(put({ efforts: { not_a_group: 'low' } }))

    expect(res.status).toBe(400)
    expect(savePlatformReasoningEfforts).not.toHaveBeenCalled()
  })

  it('PUT treats an empty set as a clear, not a no-op', async () => {
    const { PUT } = await import('./route')
    const res = await PUT(put({ efforts: {} }))

    expect(res.status).toBe(200)
    expect(savePlatformReasoningEfforts).toHaveBeenCalledWith(
      expect.objectContaining({ efforts: {} })
    )
  })

  it('PUT audits the fleet-wide change', async () => {
    const { PUT } = await import('./route')
    await PUT(put({ efforts: { intent: 'minimal' } }))

    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.reasoning_efforts.updated',
        organizationId: 'org_platform',
        metadata: { intent: 'minimal' },
      })
    )
  })

  it('PUT is refused for a non-platform-owner', async () => {
    const { PlatformAccessDeniedError } = await import('@/lib/authz/platform')
    requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())
    const { PUT } = await import('./route')

    expect((await PUT(put({ efforts: { intent: 'low' } }))).status).toBe(403)
    expect(savePlatformReasoningEfforts).not.toHaveBeenCalled()
  })
})
