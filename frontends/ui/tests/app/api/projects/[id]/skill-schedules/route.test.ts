/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/skills/service', () => ({
  listSkillSchedules: vi.fn(),
  createSkillSchedule: vi.fn(),
}))

import { GET, POST } from '@/app/api/projects/[id]/skill-schedules/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { listSkillSchedules, createSkillSchedule } from '@/lib/skills/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { SkillSchedule } from '@/lib/db/schema'

const mockSession = vi.mocked(requireAuthorizedSession)
const mockList = vi.mocked(listSkillSchedules)
const mockCreate = vi.mocked(createSkillSchedule)

const asSchedule = (row: Pick<SkillSchedule, 'id' | 'name'>): SkillSchedule =>
  row as unknown as SkillSchedule

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

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

const validBody = { name: 'Weekly', skillName: 'data-table-analysis' }

function req(body?: unknown): Request {
  return new Request('http://localhost/api/projects/proj_1/skill-schedules', {
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

describe('GET /api/projects/[id]/skill-schedules', () => {
  it('returns 403 feature-disabled when the skills gate is off (default)', async () => {
    const res = await GET(req(), makeParams('proj_1'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'feature-disabled', feature: 'skills' })
    expect(mockList).not.toHaveBeenCalled()
  })

  it('lists schedules when the env gate is on', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    mockList.mockResolvedValue({ schedules: [asSchedule({ id: 'sch-1', name: 'Weekly' })] })
    const res = await GET(req(), makeParams('proj_1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ schedules: [{ id: 'sch-1', name: 'Weekly' }] })
    expect(mockList).toHaveBeenCalledWith(session, 'proj_1')
  })
})

describe('POST /api/projects/[id]/skill-schedules', () => {
  it('returns 403 feature-disabled when off, before validating the body', async () => {
    const res = await POST(req(validBody), makeParams('proj_1'))
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns 400 on an invalid body when the gate is on', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    const res = await POST(req({ name: 'no skill' }), makeParams('proj_1'))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates a schedule (201) on a valid body', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    mockCreate.mockResolvedValue(asSchedule({ id: 'sch-new', name: 'Weekly' }))
    const res = await POST(req(validBody), makeParams('proj_1'))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ schedule: { id: 'sch-new', name: 'Weekly' } })
    expect(mockCreate).toHaveBeenCalledWith(
      session,
      'proj_1',
      expect.objectContaining({ name: 'Weekly', skillName: 'data-table-analysis' })
    )
  })
})