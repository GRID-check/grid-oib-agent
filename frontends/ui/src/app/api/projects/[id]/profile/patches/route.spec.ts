/**
 * @vitest-environment node
 */
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

// A card's patch names its conversation; the restricted-folder refusal reads
// what the conversation recorded it drew on (ADR-0087). The access check is the
// sharing layer's.
vi.mock('@/lib/sharing/access', () => ({ requireResourceAccess: vi.fn() }))
vi.mock('@/lib/conversations/restricted-use', () => ({
  recordedRestrictedFolders: vi.fn(async () => []),
  recordedSourceProjects: vi.fn(async () => []),
}))

import { POST } from './route'
import { findProjectProfileInOrg, updateProjectProfileIfVersion } from '@/lib/projects/repository'
import { requireResourceAccess } from '@/lib/sharing/access'
import { recordedRestrictedFolders } from '@/lib/conversations/restricted-use'

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
      ...postRequest({ patch: [{ op: 'add', path: '/facts/bauwerkstyp', value: 'nope' }] })
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
      ...postRequest({ patch: [{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK4' }] })
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
      ...postRequest({ patch: [{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK4' }] })
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
      ...postRequest({ patch: [{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK4' }] })
    )

    expect(response.status).toBe(409)
  })
})

describe('a patch proposed in a conversation that drew on a restricted folder (ADR-0087)', () => {
  const GK4 = [{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK4' }]

  it('is refused with a typed 403 and writes nothing: the profile is read by the whole project', async () => {
    vi.mocked(updateProjectProfileIfVersion).mockClear()
    vi.mocked(findProjectProfileInOrg).mockResolvedValue(currentState)
    vi.mocked(recordedRestrictedFolders).mockResolvedValueOnce(['22222222-aaaa-4bbb-8ccc-000000000002'])

    const response = await POST(...postRequest({ patch: GK4, conversationId: 's_conv_1' }))

    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.code).toBe('CONVERSATION_CONFINED')
    expect(body.details).toEqual({ action: 'profilePatch' })
    expect(body.error).toMatch(/project context|Projektkontext/)
    expect(requireResourceAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'conversation',
      's_conv_1',
      'viewer'
    )
    expect(recordedRestrictedFolders).toHaveBeenCalledWith('s_conv_1', 'org-1')
    expect(updateProjectProfileIfVersion).not.toHaveBeenCalled()
  })

  it('goes through from an open conversation', async () => {
    vi.mocked(findProjectProfileInOrg).mockResolvedValue(currentState)
    vi.mocked(updateProjectProfileIfVersion).mockResolvedValue({ ...currentState, profileVersion: 2 })

    const response = await POST(...postRequest({ patch: GK4, conversationId: 's_conv_open' }))

    expect(response.status).toBe(200)
  })

  it('asks nothing for the brief’s own editor, which names no conversation', async () => {
    vi.mocked(recordedRestrictedFolders).mockClear()
    vi.mocked(findProjectProfileInOrg).mockResolvedValue(currentState)
    vi.mocked(updateProjectProfileIfVersion).mockResolvedValue({ ...currentState, profileVersion: 2 })

    const response = await POST(...postRequest({ patch: GK4 }))

    expect(response.status).toBe(200)
    expect(recordedRestrictedFolders).not.toHaveBeenCalled()
  })
})
