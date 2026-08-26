/**
 * @vitest-environment node
 */
/**
 * The Policy Decision Point's own spec.
 *
 * `decide.ts` shipped with ADR-0038 as the front door across all four tiers and
 * had no test of any kind — 298 lines of security-critical dispatch, including
 * the only implementation of the skill tier, resting on review alone. These are
 * the properties the module claims in its own header, asserted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const requireProjectAccess = vi.fn()
vi.mock('./projects', () => ({
  requireProjectAccess: (...args: unknown[]) => requireProjectAccess(...args),
}))

const hasPlatformPermission = vi.fn()
vi.mock('./platform', () => ({
  hasPlatformPermission: (...args: unknown[]) => hasPlatformPermission(...args),
}))

const findJob = vi.fn()
vi.mock('@/lib/jobs/repository', () => ({ findJob: (...args: unknown[]) => findJob(...args) }))

const findProjectTenancy = vi.fn()
vi.mock('@/lib/projects/repository', () => ({
  findProjectTenancy: (...args: unknown[]) => findProjectTenancy(...args),
}))

const checkResourcePermission = vi.fn()
vi.mock('./resource-check', () => ({
  checkResourcePermission: (...args: unknown[]) => checkResourcePermission(...args),
}))

import { authorize, can, decide } from './decide'
import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { GridSession } from '@/lib/auth/types'

const session = (overrides: Partial<GridSession> = {}): GridSession =>
  ({
    userId: 'user_1',
    email: 'a@b.c',
    name: 'A',
    accessToken: 'token',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
    featureFlags: null,
    ...overrides,
  }) as GridSession

const PROJECT = { type: 'project', id: 'proj_1' } as const
const SKILL = { type: 'skill', id: 'job_1' } as const

beforeEach(() => {
  vi.clearAllMocks()
  requireProjectAccess.mockResolvedValue({ role: 'project-viewer' })
  hasPlatformPermission.mockResolvedValue(false)
  findProjectTenancy.mockResolvedValue({ organizationId: 'org_1', deletedAt: null })
  findJob.mockResolvedValue({ projectId: 'proj_1' })
  checkResourcePermission.mockResolvedValue(false)
})

describe('rule 1 — no session, no decision', () => {
  it('never falls through to allow, on any tier', async () => {
    for (const [permission, resource] of [
      ['org:settings:manage', undefined],
      ['platform:settings:manage', undefined],
      ['project:view', PROJECT],
      ['skill:run', SKILL],
    ] as const) {
      const decision = await decide(null, permission, resource)
      expect(decision.allowed).toBe(false)
      expect(decision.rule).toBe('no-session')
    }
  })
})

describe('unknown permissions fail closed', () => {
  it('throws rather than guessing a tier from the slug prefix', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decide(session(), 'project:invented' as any, PROJECT)
    ).rejects.toThrow(/not in the catalog/)
  })

  it('refuses a resource tier called without a resource', async () => {
    await expect(decide(session(), 'project:view')).rejects.toThrow(/requires a resource/)
  })

  it('refuses a resource of the wrong type for the tier', async () => {
    await expect(decide(session(), 'project:view', SKILL)).rejects.toThrow(
      /project-tier but was given a skill resource/
    )
  })
})

describe('claims tiers', () => {
  it('allows from the JWT claim, naming the rule', async () => {
    const decision = await decide(
      session({ permissions: ['org:models:manage'] }),
      'org:models:manage'
    )
    expect(decision).toMatchObject({ allowed: true, rule: 'jwt-permission', tier: 'org' })
  })

  it('allows from the bounded catalog implication when the claim is absent', async () => {
    const decision = await decide(session({ role: 'admin' }), 'org:models:manage')
    expect(decision).toMatchObject({ allowed: true, rule: 'legacy-role-implication' })
  })

  it('denies a permission the role does not hold', async () => {
    const decision = await decide(session({ role: 'org-auditor' }), 'org:models:manage')
    expect(decision).toMatchObject({ allowed: false, rule: 'no-grant' })
  })

  it('routes the platform tier through the PER-PERMISSION check', async () => {
    // Not a binary "is this platform staff": the read-only support role must be
    // able to hold the view permission and not the manage one.
    hasPlatformPermission.mockImplementation(
      async (_s: unknown, permission: string) => permission === 'platform:organizations:view'
    )
    await expect(can(session(), 'platform:organizations:view')).resolves.toBe(true)
    await expect(can(session(), 'platform:settings:manage')).resolves.toBe(false)
    // The permission the route asked for is the one that reaches the check —
    // it is not collapsed into a single "is this platform staff" question.
    expect(hasPlatformPermission).toHaveBeenCalledWith(
      expect.anything(),
      'platform:settings:manage'
    )
  })

  it('never implies a platform permission from an org role', async () => {
    // `hasPermission`'s table holds environment-scoped ORG roles only, so no
    // tenant role can reach the platform tier by implication.
    hasPlatformPermission.mockResolvedValue(false)
    await expect(can(session({ role: 'admin' }), 'platform:settings:manage')).resolves.toBe(false)
  })
})

describe('project tier', () => {
  it('delegates to requireProjectAccess rather than reimplementing it', async () => {
    const decision = await decide(session(), 'project:view', PROJECT)
    expect(requireProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      'proj_1',
      'project:view'
    )
    expect(decision).toMatchObject({ allowed: true, rule: 'resource-role', tier: 'project' })
  })

  it('names the bypass by PERMISSION, not by the role slug', async () => {
    const decision = await decide(
      session({ role: 'custom-owner', permissions: ['org:projects:administer'] }),
      'project:manage',
      PROJECT
    )
    expect(decision).toMatchObject({ allowed: true, rule: 'org-admin-bypass' })
  })

  it('distinguishes a tenancy mismatch from a missing grant', async () => {
    requireProjectAccess.mockRejectedValue(new NotFoundError())

    findProjectTenancy.mockResolvedValue({ organizationId: 'org_other', deletedAt: null })
    expect((await decide(session(), 'project:view', PROJECT)).rule).toBe('tenancy-mismatch')

    findProjectTenancy.mockResolvedValue({ organizationId: 'org_1', deletedAt: null })
    expect((await decide(session(), 'project:view', PROJECT)).rule).toBe('no-grant')
  })

  it('denies a session with no active organization', async () => {
    const decision = await decide(
      session({ organizationId: null } as Partial<GridSession>),
      'project:view',
      PROJECT
    )
    expect(decision).toMatchObject({ allowed: false, rule: 'no-organization' })
  })

  it('propagates a non-authorization error instead of swallowing it as a denial', async () => {
    requireProjectAccess.mockRejectedValue(new Error('database down'))
    await expect(decide(session(), 'project:view', PROJECT)).rejects.toThrow('database down')
  })
})

describe('skill tier', () => {
  it('checks tenancy from the job row first, and never bypasses it', async () => {
    findJob.mockResolvedValue(null)
    const decision = await decide(session(), 'skill:run', SKILL)
    expect(decision).toMatchObject({ allowed: false, rule: 'tenancy-mismatch' })
    expect(requireProjectAccess).not.toHaveBeenCalled()
  })

  it('inherits from the parent project via the documented fallback map', async () => {
    const decision = await decide(session(), 'skill:run', SKILL)
    // skill:run falls back to project:skills:manage, NOT to project:view.
    expect(requireProjectAccess).toHaveBeenCalledWith(
      expect.anything(),
      'proj_1',
      'project:skills:manage'
    )
    expect(decision).toMatchObject({ allowed: true, rule: 'project-inherited' })
  })

  it('maps skill:view onto project:view, so any project viewer sees the schedule', async () => {
    await decide(session(), 'skill:view', SKILL)
    expect(requireProjectAccess).toHaveBeenCalledWith(expect.anything(), 'proj_1', 'project:view')
  })

  it('does not ask WorkOS about a resource type nothing provisions', async () => {
    await decide(session(), 'skill:manage', SKILL)
    expect(checkResourcePermission).not.toHaveBeenCalled()
  })

  it('denies when the parent project denies', async () => {
    requireProjectAccess.mockRejectedValue(new NotFoundError())
    const decision = await decide(session(), 'skill:manage', SKILL)
    expect(decision).toMatchObject({ allowed: false, rule: 'no-grant' })
  })
})

describe('authorize() denial shapes', () => {
  it('throws 403 for claims tiers and 404 for resource tiers', async () => {
    await expect(authorize(session(), 'org:models:manage')).rejects.toBeInstanceOf(ForbiddenError)
    await expect(authorize(session(), 'platform:settings:manage')).rejects.toBeInstanceOf(
      ForbiddenError
    )
    requireProjectAccess.mockRejectedValue(new NotFoundError())
    await expect(authorize(session(), 'project:view', PROJECT)).rejects.toBeInstanceOf(
      NotFoundError
    )
    await expect(authorize(session(), 'skill:manage', SKILL)).rejects.toBeInstanceOf(NotFoundError)
  })

  it('returns the decision when allowed, so callers can log the rule', async () => {
    const decision = await authorize(
      session({ permissions: ['org:models:manage'] }),
      'org:models:manage'
    )
    expect(decision).toMatchObject({ allowed: true, rule: 'jwt-permission' })
  })
})
