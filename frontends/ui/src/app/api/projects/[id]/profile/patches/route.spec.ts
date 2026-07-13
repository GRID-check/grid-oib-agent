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
      ...postRequest({ patch: [{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK9' }] }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toMatch(/Building class/)
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
})
