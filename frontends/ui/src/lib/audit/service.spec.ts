/**
 * @vitest-environment node
 */
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

import {
  AuditEmitError,
  generateAuditPortalLink,
  recordAuditEvent,
  recordAuditEventOrThrow,
  trustedAppOrigin,
} from './service'
import { AUDIT_SCHEMAS } from './schemas.mjs'

/** The parts of the WorkOS event this file asserts on. */
interface EmittedEvent {
  action: string
  actor: { type: string; id: string; name?: string; metadata: Record<string, unknown> }
  targets: { type: string; id: string }[]
  context: { location: string; userAgent?: string }
  metadata: Record<string, string | number | boolean>
  occurredAt: Date
}

/**
 * The one place the untyped mock is given a shape. `vi.fn()` records its calls
 * as `any[]`, so reading `.mock.calls` inline would spread that `any` through
 * every assertion below; naming the boundary once keeps the rest typed.
 */
const lastEvent = (): EmittedEvent => createEvent.mock.calls[0][1] as unknown as EmittedEvent

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
    expect(event.actor).toEqual({ type: 'user', id: 'user_1', name: 'admin@acme.at', metadata: {} })
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
    expect(event.metadata).toEqual({})
  })

  // Issues #274/#277. WorkOS derives the validator from the registered schema
  // and marks BOTH `metadata` and `actor.metadata` required for every action
  // that registers a metadata map — so an omitted key is a 400, not a smaller
  // event, and the emitter swallows that 400 by design. Both keys must
  // therefore be present on every emit, whatever the caller passed.
  it.each([
    ['no metadata at all', undefined],
    ['metadata that is entirely null', { subject: null, role: undefined }],
  ])('always sends actor.metadata and metadata — %s', async (_case, metadata) => {
    await recordAuditEvent({
      organizationId: 'org_1',
      actor: { userId: 'user_1' },
      action: 'resource.shared',
      targetType: 'conversation',
      targetId: 'conv_1',
      metadata: metadata as Record<string, string | number | boolean | null | undefined> | undefined,
    })
    const [, event] = createEvent.mock.calls[0]
    expect(event.actor.metadata).toEqual({})
    expect(event.metadata).toEqual({})
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

describe('agent-authored events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createEvent.mockResolvedValue(undefined)
  })

  // The enterprise question is "who authorized the creation of this
  // AI-generated document", so the actor slot has to keep answering it. The
  // run is the second fact, not a replacement for the first.
  it('keeps the authorizing human as the actor and names the run as a second target', async () => {
    await recordAuditEvent({
      organizationId: 'org_1',
      actor: {
        type: 'agent',
        userId: 'user_1',
        email: 'architect@acme.at',
        ref: { kind: 'agent_run', id: 'run_7' },
      },
      action: 'document.generated',
      targetType: 'document',
      targetId: 'doc_9',
      metadata: { projectId: 'proj_1', filename: 'Bericht.docx', fileSize: 4096 },
    })

    const event = lastEvent()
    expect(event.actor).toEqual({ type: 'user', id: 'user_1', name: 'architect@acme.at', metadata: {} })
    expect(event.targets).toEqual([
      { type: 'document', id: 'doc_9' },
      { type: 'agent_run', id: 'run_7' },
    ])
  })

  // The target TYPE is the reference's kind, not a constant. A diagram's
  // reference is `{chat answer}-{hash of its source}` and was emitted as
  // `agent_run` until migration 0066, so an auditor filtering the export for
  // that run found a job that does not exist — and got the same empty answer a
  // real but unvisited run gives, which is why nobody noticed.
  it('names the second target for what the reference actually is', async () => {
    await recordAuditEvent({
      organizationId: 'org_1',
      actor: {
        type: 'agent',
        userId: 'user_1',
        ref: { kind: 'answer_artifact', id: 'msg_42-1a2b3c4d' },
      },
      action: 'document.generated',
      targetType: 'document',
      targetId: 'doc_9',
    })
    expect(lastEvent().targets).toEqual([
      { type: 'document', id: 'doc_9' },
      { type: 'answer_artifact', id: 'msg_42-1a2b3c4d' },
    ])
  })

  it('adds no run target when the author is human — the default is unchanged', async () => {
    await recordAuditEvent({
      organizationId: 'org_1',
      actor: { userId: 'user_1' },
      action: 'document.uploaded',
      targetType: 'document',
      targetId: 'doc_9',
      metadata: { projectId: 'proj_1', filename: 'plan.pdf', fileSize: 12 },
    })
    expect(lastEvent().targets).toEqual([{ type: 'document', id: 'doc_9' }])
  })

  // A target type the action does not register is rejected exactly like an
  // unregistered action (issues #255/#256) — and this emit path is the one that
  // must not fail, so the two files are checked against each other here.
  it('emits only target types the action registers a schema for', async () => {
    await recordAuditEvent({
      organizationId: 'org_1',
      actor: { type: 'agent', userId: 'user_1', ref: { kind: 'agent_run', id: 'run_7' } },
      action: 'document.generated',
      targetType: 'document',
      targetId: 'doc_9',
    })
    const registered = AUDIT_SCHEMAS['document.generated'].targets.map((target) => target.type)
    for (const target of lastEvent().targets) expect(registered).toContain(target.type)
  })
})

describe('recordAuditEventOrThrow (the events whose absence is the failure)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createEvent.mockResolvedValue(undefined)
  })

  it('emits the same event as the swallowing path', async () => {
    await recordAuditEventOrThrow({
      organizationId: 'org_1',
      actor: { type: 'agent', userId: 'user_1', ref: { kind: 'agent_run', id: 'run_7' } },
      action: 'document.generated',
      targetType: 'document',
      targetId: 'doc_9',
    })
    expect(createEvent).toHaveBeenCalledTimes(1)
    expect(lastEvent().targets).toContainEqual({ type: 'agent_run', id: 'run_7' })
  })

  // The whole point of the opt-in: a record that silently does not exist is
  // worse than none, because its absence is indistinguishable from the document
  // never having been generated. The caller is expected to fail the write.
  it('throws AuditEmitError, carrying the WorkOS failure as the cause', async () => {
    const rejection = new Error('422 unknown action')
    createEvent.mockRejectedValue(rejection)

    const thrown = await recordAuditEventOrThrow({
      organizationId: 'org_1',
      actor: { type: 'agent', userId: 'user_1', ref: { kind: 'agent_run', id: 'run_7' } },
      action: 'document.generated',
      targetType: 'document',
      targetId: 'doc_9',
    }).then(
      () => null,
      (error: unknown) => error,
    )

    expect(thrown).toBeInstanceOf(AuditEmitError)
    const failure = thrown as AuditEmitError
    expect(failure.action).toBe('document.generated')
    expect(failure.organizationId).toBe('org_1')
    expect(failure.cause).toBe(rejection)
  })
})

describe('trustedAppOrigin', () => {
  it('prefers the configured origin over the (spoofable) request Host', () => {
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI = 'https://grid.bigls.net/api/auth/callback'
    try {
      expect(trustedAppOrigin(new Request('https://evil.example/api/x'))).toBe('https://grid.bigls.net')
    } finally {
      delete process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI
    }
  })

  it('falls back to the request origin when unconfigured', () => {
    delete process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI
    expect(trustedAppOrigin(new Request('https://grid.example/api/x'))).toBe('https://grid.example')
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
