/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('server-only', () => ({}))
const { hasWrittenInOrganization, getUserPreferences } = vi.hoisted(() => ({
  hasWrittenInOrganization: vi.fn(),
  getUserPreferences: vi.fn(),
}))
vi.mock('@/lib/conversations/repository', () => ({ hasWrittenInOrganization }))
vi.mock('@/lib/user-preferences/service', () => ({ getUserPreferences }))

const { resolveTourEligibility } = await import('./tour-eligibility')

const session = { userId: 'user_1', organizationId: 'org_1' } as AuthorizedSession

describe('resolveTourEligibility', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks about this person in this organization', async () => {
    hasWrittenInOrganization.mockResolvedValue(false)
    getUserPreferences.mockResolvedValue({})
    expect(await resolveTourEligibility(session)).toEqual({ welcome: true, project: true })
    expect(hasWrittenInOrganization).toHaveBeenCalledWith('org_1', 'user_1')
  })

  it('reads the seen record from the preferences', async () => {
    hasWrittenInOrganization.mockResolvedValue(false)
    getUserPreferences.mockResolvedValue({ tourWelcomeSeenAt: '2026-09-23T10:00:00.000Z' })
    expect(await resolveTourEligibility(session)).toEqual({ welcome: false, project: true })
  })

  it('fails to no tour, never to a broken frame', async () => {
    hasWrittenInOrganization.mockRejectedValue(new Error('db down'))
    getUserPreferences.mockResolvedValue({})
    expect(await resolveTourEligibility(session)).toEqual({ welcome: false, project: false })
  })
})
