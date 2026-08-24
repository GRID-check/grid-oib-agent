/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/jobs/service', () => ({
  listAttachableSkills: vi.fn(),
}))

import { GET } from '@/app/api/skills/attachable/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { listAttachableSkills } from '@/lib/jobs/service'
import type { AuthorizedSession } from '@/lib/auth/types'

const mockSession = vi.mocked(requireAuthorizedSession)
const mockList = vi.mocked(listAttachableSkills)

const session: Omit<AuthorizedSession, 'featureFlags'> & { featureFlags: null } = {
  userId: 'user_1',
  email: 'user@example.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

function req(query: string): Request {
  return new Request(`http://localhost/api/skills/attachable${query}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSession.mockResolvedValue(session as unknown as AuthorizedSession)
  mockList.mockResolvedValue({ skills: [] })
})

afterEach(() => {
  delete process.env.GRID_SKILLS_ENABLED
})

describe('GET /api/skills/attachable', () => {
  it('returns 403 feature-disabled when the gate is off (default)', async () => {
    const res = await GET(req('?output=chat'))
    expect(res.status).toBe(403)
    expect(mockList).not.toHaveBeenCalled()
  })

  it('400s without an output kind, and on an unknown one', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    expect((await GET(req(''))).status).toBe(400)
    expect((await GET(req('?output=report'))).status).toBe(400)
    expect(mockList).not.toHaveBeenCalled()
  })

  it('passes the output kind through — it is what picks the agent', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    mockList.mockResolvedValue({
      skills: [
        {
          name: 'data-table-analysis',
          description: 'Analyze tables.',
          body: '# body',
          metadata: {},
          origin: 'platform',
        },
      ],
    })
    const res = await GET(req('?output=deep-research'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      skills: [
        {
          name: 'data-table-analysis',
          description: 'Analyze tables.',
          body: '# body',
          metadata: {},
          origin: 'platform',
        },
      ],
    })
    expect(mockList).toHaveBeenCalledWith(session, 'deep-research')
  })
})
