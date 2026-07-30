import { describe, expect, it, vi } from 'vitest'

import { ProjectProfileSchema } from '@/lib/project-profile/types'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'test@grid.com',
    role: 'admin',
  }),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('@/lib/projects/repository', () => ({
  findProjectProfileInOrg: vi.fn(),
  updateProjectProfileIfVersion: vi.fn(),
  setProjectProfileSummaryInOrg: vi.fn(),
}))

import { POST } from './route'
import {
  findProjectProfileInOrg,
  updateProjectProfileIfVersion,
} from '@/lib/projects/repository'

const currentState = {
  profile: ProjectProfileSchema.parse({}),
  profileVersion: 1,
  profilePromptView: null,
  profileDisplay: { title: '', summary: '', keyFacts: [], missingInfo: [] },
  profileUpdatedAt: new Date('2026-01-01'),
}

function postRequest(body: unknown): [Request, { params: Promise<{ id: string }> }] {
  return [
    new Request('https://grid.test/api/projects/proj-1/profile/patches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'proj-1' }) },
  ]
}

describe('POST /api/projects/[id]/profile/patches', () => {
  it('rejects a value outside the intake vocabulary with a 400', async () => {
    vi.mocked(findProjectProfileInOrg).mockResolvedValue(currentState)

    const response = await POST(
      ...postRequest({ patch: [{ op: 'add', path: '/facts/bauwerkstyp', value: 'nope' }] }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toMatch(/Bauwerkstyp/)
    // The bad patch never reached the persistence layer.
    expect(updateProjectProfileIfVersion).not.toHaveBeenCalled()
  })

  it('applies a valid patch and returns 200', async () => {
    vi.mocked(findProjectProfileInOrg).mockResolvedValue(currentState)
    vi.mocked(updateProjectProfileIfVersion).mockResolvedValue({
      ...currentState,
      profileVersion: 2,
    })

    const response = await POST(
      ...postRequest({ patch: [{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK4' }] }),
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.profileVersion).toBe(2)
    expect(updateProjectProfileIfVersion).toHaveBeenCalledTimes(1)
  })

  /**
   * `updateProjectProfileIfVersion` only compares `profileVersion`, so the refusal
   * it returns is a GENERIC optimistic-lock failure. Which of the two conflicts it
   * is decides whether the caller may report success, and only the profile the
   * winner left behind can say.
   */
  it('reports an idempotent success when the winner already applied this patch', async () => {
    const applied = ProjectProfileSchema.parse({
      facts: {
        gebaeudeklasse: {
          value: 'GK4',
          confidence: 'confirmed',
          source: 'user_confirmed',
          updatedAt: '2026-07-30T08:00:00.000Z',
        },
      },
    })
    vi.mocked(findProjectProfileInOrg)
      .mockResolvedValueOnce(currentState)
      .mockResolvedValueOnce({ ...currentState, profile: applied, profileVersion: 2 })
    vi.mocked(updateProjectProfileIfVersion).mockResolvedValue(null)

    const response = await POST(
      ...postRequest({ patch: [{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK4' }] }),
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.alreadyApplied).toBe(true)
  })

  it('still returns 409 when the concurrent write was somebody else’s change', async () => {
    // The winner set a DIFFERENT fact, so these operations were dropped. Reporting
    // this as applied would lose the change behind a card that cannot be retried.
    const other = ProjectProfileSchema.parse({
      facts: {
        bauwerkstyp: {
          value: 'wohngebaeude',
          confidence: 'confirmed',
          source: 'user_confirmed',
          updatedAt: '2026-07-30T08:00:00.000Z',
        },
      },
    })
    vi.mocked(findProjectProfileInOrg)
      .mockResolvedValueOnce(currentState)
      .mockResolvedValueOnce({ ...currentState, profile: other, profileVersion: 2 })
    vi.mocked(updateProjectProfileIfVersion).mockResolvedValue(null)

    const response = await POST(
      ...postRequest({ patch: [{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK4' }] }),
    )

    expect(response.status).toBe(409)
  })
})
