/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/platform', () => ({ getPlatformOrganizationId: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn().mockResolvedValue(1) }))
vi.mock('@/lib/organizations/service', () => ({ listOrganizationMembersWithRoles: vi.fn() }))
const scopes: string[] = []
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (scope: { organizationId: string }, fn: () => unknown) => {
    scopes.push(scope.organizationId)
    return await fn()
  }),
}))

import { getPlatformOrganizationId } from '@/lib/authz/platform'
import type { ProductFeedback } from '@/lib/db/schema'
import { emitInboxItems } from '@/lib/inbox/service'
import {
  listOrganizationMembersWithRoles,
  type OrganizationMemberWithRole,
} from '@/lib/organizations/service'
import {
  announceProductFeedback,
  feedbackEmissions,
  findFeedbackRecipients,
} from './announce'

function member(overrides: Partial<OrganizationMemberWithRole> = {}): OrganizationMemberWithRole {
  return {
    id: 'user_owner',
    email: 'owner@platform.test',
    name: 'Olga Owner',
    roleSlug: 'org-platform-owner',
    status: 'active',
    ...overrides,
  }
}

function report(overrides: Partial<ProductFeedback> = {}): ProductFeedback {
  const at = new Date('2026-09-29T08:00:00Z')
  return {
    id: '7b6a2c1e-0000-4000-8000-000000000001',
    organizationId: 'org_tenant',
    userId: 'user_reporter',
    userName: 'Maria Huber',
    userEmail: 'maria@buero.test',
    kind: 'bug',
    message: 'Der Upload bleibt bei 99 % stehen.',
    pagePath: '/app/projects',
    context: {},
    allowContact: true,
    status: 'new',
    triagedBy: null,
    triagedAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  scopes.length = 0
  vi.mocked(getPlatformOrganizationId).mockResolvedValue('org_platform')
  vi.mocked(listOrganizationMembersWithRoles).mockResolvedValue([member()])
})

describe('findFeedbackRecipients — derived from the triage permission', () => {
  it('addresses active members whose role may triage, and nobody else', async () => {
    vi.mocked(listOrganizationMembersWithRoles).mockResolvedValue([
      member({ id: 'user_owner' }),
      // Support reads the page but holds no manage permission: not paged.
      member({ id: 'user_support', roleSlug: 'org-platform-support' }),
      member({ id: 'user_invited', status: 'pending' }),
      // A role this build does not know is not assumed to hold anything.
      member({ id: 'user_custom', roleSlug: 'custom-role-nobody-knows' }),
      member({ id: 'user_none', roleSlug: null }),
    ])

    expect(await findFeedbackRecipients('org_platform')).toEqual(['user_owner'])
  })
})

describe('feedbackEmissions', () => {
  it('writes one platform-organization row per owner, collapsed on the report', () => {
    const rows = feedbackEmissions(report(), 'Büro Nord', 'org_platform', ['user_a', 'user_b'])

    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.organizationId).toBe('org_platform')
      expect(row.type).toBe('feedback.submitted')
      expect(row.resourceType).toBe('product_feedback')
      expect(row.resourceId).toBe(report().id)
      expect(row.actorUserId).toBe('user_reporter')
      expect(row.groupKey).toBe(`feedback.submitted:product_feedback:${report().id}`)
      expect(row.payload).toMatchObject({
        subject: 'Büro Nord',
        excerpt: 'Der Upload bleibt bei 99 % stehen.',
        actorName: 'Maria Huber',
        kind: 'bug',
      })
    }
  })

  it('bounds the excerpt the row carries', () => {
    const [row] = feedbackEmissions(report({ message: 'x'.repeat(2000) }), null, 'org_platform', ['u'])
    expect(String(row!.payload!.excerpt).length).toBeLessThanOrEqual(501)
  })
})

describe('announceProductFeedback', () => {
  it('emits into the platform organization, as the platform organization', async () => {
    const outcome = await announceProductFeedback(report(), 'Büro Nord')

    expect(outcome).toEqual({ status: 'announced', recipients: 1 })
    expect(scopes).toEqual(['org_platform'])
    expect(vi.mocked(emitInboxItems).mock.calls[0]![0]).toHaveLength(1)
  })

  it('stores-and-carries-on when no platform organization exists', async () => {
    vi.mocked(getPlatformOrganizationId).mockResolvedValue(null)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await announceProductFeedback(report(), null)).toEqual({ status: 'no-platform-organization' })
    expect(emitInboxItems).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('never throws — a roster failure must not cost the reporter their thank-you', async () => {
    vi.mocked(listOrganizationMembersWithRoles).mockRejectedValue(new Error('WorkOS 503'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(announceProductFeedback(report(), null)).resolves.toEqual({ status: 'failed' })
    error.mockRestore()
  })
})
