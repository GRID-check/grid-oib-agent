/**
 * @vitest-environment node
 */
/**
 * Who sees and decides the E-Mail-Eingang (D9, C1): the office's entitlement,
 * then document write on the project, asked so a closed project's mail can
 * still be read and dismissed; the address is the manager's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn(async () => ({ role: 'project-editor', closed: true, readsBecauseClosed: false })) }))
vi.mock('@/lib/authz/decide', () => ({ can: vi.fn(async () => true) }))
// The session's flags as WorkOS states them (outside a WorkOS deployment the default would answer).
vi.mock('@/lib/authz/feature-flags', () => ({
  isInboundMailEnabled: (session: { featureFlags: string[] }) => session.featureFlags.includes('inbound-mail'),
}))

import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import { requireAddressManager, requireMailReviewer } from './access'

const on = { userId: 'u', organizationId: 'o', featureFlags: ['inbound-mail'] } as unknown as AuthorizedSession
const off = { userId: 'u', organizationId: 'o', featureFlags: [] } as unknown as AuthorizedSession

beforeEach(() => vi.clearAllMocks())

describe('access to the E-Mail-Eingang', () => {
  it('is not found while the office’s inbound-mail entitlement is off, before any project is asked', async () => {
    await expect(requireMailReviewer(off, 'p')).rejects.toMatchObject({ status: 404 })
    await expect(requireAddressManager(off, 'p')).rejects.toMatchObject({ status: 404 })
    expect(requireProjectAccess).not.toHaveBeenCalled()
  })

  it('asks document write as if the project were open, and says when it is closed', async () => {
    expect(await requireMailReviewer(on, 'p')).toEqual({ closed: true })
    expect(requireProjectAccess).toHaveBeenCalledWith(on, 'p', ['project:documents:write', 'project:edit'], { evenWhenClosed: true })
  })

  it('leaves the address to project managers', async () => {
    await requireAddressManager(on, 'p')
    expect(requireProjectAccess).toHaveBeenCalledWith(on, 'p', 'project:manage')
  })
})
