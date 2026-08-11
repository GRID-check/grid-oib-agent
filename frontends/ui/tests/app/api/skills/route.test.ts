/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/skills/service', () => ({
  listSkills: vi.fn(),
  createSkill: vi.fn(),
}))

import { GET, POST } from '@/app/api/skills/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { listSkills, createSkill } from '@/lib/skills/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Skill } from '@/lib/db/schema'

const mockSession = vi.mocked(requireAuthorizedSession)
const mockList = vi.mocked(listSkills)
const mockCreate = vi.mocked(createSkill)

const asSkill = (row: Pick<Skill, 'id' | 'name'>): Skill => row as unknown as Skill
const validBody = { name: 'my-skill', description: 'Does things.', body: 'Body text.' }

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

function req(body?: unknown): Request {
  return new Request('http://localhost/api/skills', {
    method: body ? 'POST' : 'GET',
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSession.mockResolvedValue(session as unknown as AuthorizedSession)
})

afterEach(() => {
  delete process.env.GRID_SKILLS_ENABLED
})

describe('GET /api/skills', () => {
  it('returns 403 feature-disabled when the skills gate is off (default)', async () => {
    const res = await GET(req())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'feature-disabled', feature: 'skills' })
    expect(mockList).not.toHaveBeenCalled()
  })

  it('lists the merged toolbox when the env gate is on', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    mockList.mockResolvedValue({ skills: [asSkill({ id: 'skill-1', name: 'a' })] })
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ skills: [{ id: 'skill-1', name: 'a' }] })
    expect(mockList).toHaveBeenCalledWith(session)
  })
})

describe('POST /api/skills', () => {
  it('returns 403 feature-disabled when off, before validating the body', async () => {
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns 400 on an invalid body when the gate is on', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    const res = await POST(req({ description: 'no name or body' }))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates a skill (201) on a valid body', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    mockCreate.mockResolvedValue({ skill: asSkill({ id: 'skill-new', name: 'My skill' }) })
    const res = await POST(req(validBody))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ skill: { id: 'skill-new', name: 'My skill' } })
    expect(mockCreate).toHaveBeenCalledWith(
      session,
      expect.objectContaining({ name: 'my-skill', body: 'Body text.' })
    )
  })
})