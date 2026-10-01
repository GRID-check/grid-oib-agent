/**
 * @vitest-environment node
 */
/**
 * The project's address as the settings surface reads and rotates it: minted
 * on first read, one per project under a race, the organization switch, and
 * rotation. What each route asks for is `app/api/projects/[id]/inbound-address`'s
 * spec; receiving is `./receive.spec.ts`, filing `./drain.spec.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/authz/decide', () => ({ can: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({ findProjectInOrg: vi.fn() }))
vi.mock('./repository', () => ({
  findActiveAddressForProject: vi.fn(),
  insertAddress: vi.fn(),
  rotateAddress: vi.fn(),
}))

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { can } from '@/lib/authz/decide'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { InboundMailAddressRow, Project } from '@/lib/db/schema'
import { findProjectInOrg } from '@/lib/projects/repository'
import { findActiveAddressForProject, insertAddress, rotateAddress } from './repository'
import { getInboundAddress, rotateInboundAddress } from './service'

const session = {
  userId: 'user-anna',
  organizationId: 'org_A',
  organizationMembershipId: 'om-anna',
  email: 'anna@buero-a.at',
  role: 'member',
  permissions: [],
  featureFlags: null,
} as unknown as AuthorizedSession

const row = (token: string): InboundMailAddressRow => ({
  id: `addr-${token}`,
  organizationId: 'org_A',
  projectId: 'project-a',
  token,
  slug: 'wohnbau',
  createdBy: 'user-anna',
  createdAt: new Date(),
  revokedAt: null,
  revokedBy: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', 'piloti-post.at')
  vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', '')
  vi.stubEnv('GRID_PROJECT_MAIL_INBOX_ENABLED', 'true')
  vi.mocked(requireProjectAccess).mockResolvedValue({ role: 'project-editor' })
  vi.mocked(can).mockResolvedValue(false)
  vi.mocked(findProjectInOrg).mockResolvedValue({ id: 'project-a', name: 'Wohnbau' } as Project)
  vi.mocked(findActiveAddressForProject).mockResolvedValue(null)
  vi.mocked(insertAddress).mockImplementation(async (input) => ({ ok: true, row: row(input.token) }))
  vi.mocked(rotateAddress).mockImplementation(async (input) => ({ ok: true, row: row(input.token) }))
})

describe('getInboundAddress', () => {
  it('mints on first read, with the project slug and a fresh token', async () => {
    const result = await getInboundAddress(session, 'project-a')
    expect(result.enabled).toBe(true)
    expect(result.address).toMatch(/^wohnbau\.[a-z2-7]{12}@piloti-post\.at$/)
    expect(insertAddress).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_A', projectId: 'project-a', slug: 'wohnbau', createdBy: 'user-anna' })
    )
  })

  it('returns the address that exists, without minting', async () => {
    vi.mocked(findActiveAddressForProject).mockResolvedValue(row('abcdefgh2345'))
    expect((await getInboundAddress(session, 'project-a')).address).toBe('wohnbau.abcdefgh2345@piloti-post.at')
    expect(insertAddress).not.toHaveBeenCalled()
  })

  it('answers with the winner when a concurrent read minted first', async () => {
    vi.mocked(insertAddress).mockResolvedValue({ ok: false, conflict: 'active' })
    vi.mocked(findActiveAddressForProject).mockResolvedValueOnce(null).mockResolvedValueOnce(row('wwwwwwwwwwww'))
    expect((await getInboundAddress(session, 'project-a')).address).toBe('wohnbau.wwwwwwwwwwww@piloti-post.at')
  })

  it('mints another token when the first collided', async () => {
    vi.mocked(insertAddress)
      .mockResolvedValueOnce({ ok: false, conflict: 'token' })
      .mockImplementationOnce(async (input) => ({ ok: true, row: row(input.token) }))
    expect((await getInboundAddress(session, 'project-a')).enabled).toBe(true)
    expect(insertAddress).toHaveBeenCalledTimes(2)
  })

  it('asks can(project:manage) for canRotate', async () => {
    vi.mocked(can).mockResolvedValue(true)
    expect((await getInboundAddress(session, 'project-a')).canRotate).toBe(true)
    expect(can).toHaveBeenCalledWith(session, 'project:manage', { type: 'project', id: 'project-a' })
  })

  it('is disabled, and mints nothing, without a domain or with the switch off', async () => {
    vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', '')
    expect(await getInboundAddress(session, 'project-a')).toEqual({ enabled: false, address: null, canRotate: false })
    vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', 'piloti-post.at')
    vi.stubEnv('GRID_PROJECT_MAIL_INBOX_ENABLED', '')
    expect(await getInboundAddress(session, 'project-a')).toEqual({ enabled: false, address: null, canRotate: false })
    expect(insertAddress).not.toHaveBeenCalled()
  })

  it('refuses a caller without write access before anything else', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValue(new NotFoundError())
    await expect(getInboundAddress(session, 'project-a')).rejects.toMatchObject({ status: 404 })
    expect(findActiveAddressForProject).not.toHaveBeenCalled()
  })
})

describe('rotateInboundAddress', () => {
  it('requires project:manage and mints through the rotation', async () => {
    const { address } = await rotateInboundAddress(session, 'project-a')
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'project-a', 'project:manage')
    expect(address).toMatch(/^wohnbau\.[a-z2-7]{12}@piloti-post\.at$/)
    expect(rotateAddress).toHaveBeenCalledWith(expect.objectContaining({ revokedBy: 'user-anna' }))
  })

  it('answers 409 when another rotation won the race', async () => {
    vi.mocked(rotateAddress).mockResolvedValue({ ok: false, conflict: 'active' })
    await expect(rotateInboundAddress(session, 'project-a')).rejects.toMatchObject({ status: 409 })
  })

  it('is a 404 while the switch is off', async () => {
    vi.stubEnv('GRID_PROJECT_MAIL_INBOX_ENABLED', '')
    await expect(rotateInboundAddress(session, 'project-a')).rejects.toMatchObject({ status: 404 })
    expect(rotateAddress).not.toHaveBeenCalled()
  })
})
