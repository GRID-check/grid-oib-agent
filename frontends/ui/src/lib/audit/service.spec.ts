import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const createEvent = vi.fn()
const generateLink = vi.fn()

vi.mock('@/lib/workos/client', () => ({
  getWorkOS: () => ({
    auditLogs: { createEvent },
    adminPortal: { generateLink },
  }),
}))

import { generateAuditPortalLink, recordAuditEvent } from './service'

describe('recordAuditEvent (WorkOS-native audit trail)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createEvent.mockResolvedValue(undefined)
  })

  it('emits an org-scoped WorkOS audit event with actor, target and context', async () => {
    const request = new Request('https://grid.example/api/organization/budgets', {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'vitest' },
    })
    await recordAuditEvent({
      organizationId: 'org_1',
      actor: { userId: 'user_1', email: 'admin@acme.at' },
      action: 'budget.policy.set',
      targetType: 'budget_policy',
      targetId: 'policy_1',
      metadata: { scope: 'organization', subjectId: null, dailyLimitEur: 10 },
      request,
    })

    expect(createEvent).toHaveBeenCalledTimes(1)
    const [orgId, event] = createEvent.mock.calls[0]
    expect(orgId).toBe('org_1')
    expect(event.action).toBe('budget.policy.set')
    expect(event.actor).toEqual({ type: 'user', id: 'user_1', name: 'admin@acme.at' })
    expect(event.targets).toEqual([{ type: 'budget_policy', id: 'policy_1' }])
    // First x-forwarded-for hop is the client.
    expect(event.context).toEqual({ location: '203.0.113.7', userAgent: 'vitest' })
    // Nulls are stripped — WorkOS metadata allows flat primitives only.
    expect(event.metadata).toEqual({ scope: 'organization', dailyLimitEur: 10 })
    expect(event.occurredAt).toBeInstanceOf(Date)
  })

  it('falls back to the org id as target and "unknown" location without a request', async () => {
    await recordAuditEvent({
      organizationId: 'org_1',
      actor: { userId: 'user_1' },
      action: 'org.settings.updated',
      targetType: 'organization',
    })
    const [, event] = createEvent.mock.calls[0]
    expect(event.targets).toEqual([{ type: 'organization', id: 'org_1' }])
    expect(event.context.location).toBe('unknown')
    expect(event.metadata).toBeUndefined()
  })

  it('never throws — a WorkOS failure is logged, not propagated', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    createEvent.mockRejectedValue(new Error('422 unknown action'))
    await expect(
      recordAuditEvent({
        organizationId: 'org_1',
        actor: { userId: 'user_1' },
        action: 'org.created',
        targetType: 'organization',
      }),
    ).resolves.toBeUndefined()
    expect(consoleError).toHaveBeenCalled()
    consoleError.mockRestore()
  })
})

describe('generateAuditPortalLink', () => {
  it('requests a native Admin Portal audit-logs link for the org', async () => {
    generateLink.mockResolvedValue({ link: 'https://portal.workos.com/x' })
    const link = await generateAuditPortalLink('org_1', 'https://grid.example/app/organization')
    expect(link).toBe('https://portal.workos.com/x')
    expect(generateLink).toHaveBeenCalledWith({
      intent: 'audit_logs',
      organization: 'org_1',
      returnUrl: 'https://grid.example/app/organization',
    })
  })
})
