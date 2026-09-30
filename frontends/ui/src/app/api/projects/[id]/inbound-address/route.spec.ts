/**
 * @vitest-environment node
 */
/**
 * The two project address routes, with the real service behind them: what is
 * pinned here is WHICH permission each route ends up asking for, and that a
 * refusal is the 404 a non-member gets rather than a 403 that confirms the
 * project exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    organizationMembershipId: 'om-1',
    email: 'anna@buero-a.at',
    role: 'member',
    permissions: [],
  }),
}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn().mockResolvedValue({ id: 'proj-1', name: 'Wohnbau Hietzing' }),
}))
vi.mock('@/lib/inbound-mail/repository', () => ({
  findActiveAddressForProject: vi.fn(),
  insertAddress: vi.fn(),
  rotateAddress: vi.fn(),
}))

import { NotFoundError } from '@/lib/api/errors'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { InboundMailAddressRow } from '@/lib/db/schema'
import {
  inboundAddressResponseSchema,
  rotateInboundAddressResponseSchema,
} from '@/lib/inbound-mail/contract'
import { findActiveAddressForProject, insertAddress, rotateAddress } from '@/lib/inbound-mail/repository'
import { createInProcessStore, setLimitStore } from '@/lib/limits'
import { GET } from './route'
import { POST } from './rotate/route'

const context = { params: Promise.resolve({ id: 'proj-1' }) }
const url = 'https://grid.test/api/projects/proj-1/inbound-address'

const row = (token: string): InboundMailAddressRow => ({
  id: `addr-${token}`,
  organizationId: 'org-1',
  projectId: 'proj-1',
  token,
  slug: 'wohnbau-hietzing',
  createdBy: 'user-1',
  createdAt: new Date(),
  revokedAt: null,
  revokedBy: null,
})

/** Grant exactly the permissions listed; anything else is the 404 a non-member gets. */
function grant(held: string[], role: 'project-editor' | 'project-admin' = 'project-editor') {
  vi.mocked(requireProjectAccess).mockImplementation(async (_session, _project, permission) => {
    const asked = Array.isArray(permission) ? permission : [permission]
    if (!asked.some((p) => held.includes(p))) throw new NotFoundError()
    return { role }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  setLimitStore(createInProcessStore())
  vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', 'piloti-post.at')
  vi.mocked(findActiveAddressForProject).mockResolvedValue(row('abcdefgh2345'))
  vi.mocked(insertAddress).mockImplementation(async (input) => ({ ok: true, row: row(input.token) }))
  vi.mocked(rotateAddress).mockImplementation(async (input) => ({ ok: true, row: row(input.token) }))
})

describe('GET /api/projects/[id]/inbound-address', () => {
  it('answers the contract for a member with document write access', async () => {
    grant(['project:documents:write'])
    const response = await GET(new Request(url), context)

    expect(response.status).toBe(200)
    const body = inboundAddressResponseSchema.parse(await response.json())
    expect(body).toEqual({
      enabled: true,
      address: 'wohnbau-hietzing.abcdefgh2345@piloti-post.at',
      canRotate: false,
    })
    expect(requireProjectAccess).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
      'proj-1',
      ['project:documents:write', 'project:edit']
    )
  })

  it('accepts the legacy project:edit umbrella', async () => {
    grant(['project:edit'])
    expect((await GET(new Request(url), context)).status).toBe(200)
  })

  it('is a 404 for a viewer, and mints nothing', async () => {
    grant(['project:view'])
    vi.mocked(findActiveAddressForProject).mockResolvedValue(null)

    expect((await GET(new Request(url), context)).status).toBe(404)
    expect(insertAddress).not.toHaveBeenCalled()
  })

  it('says canRotate for a project manager', async () => {
    grant(['project:documents:write', 'project:manage'], 'project-admin')
    const body = inboundAddressResponseSchema.parse(await (await GET(new Request(url), context)).json())
    expect(body.canRotate).toBe(true)
  })

  it('reports disabled without a domain', async () => {
    grant(['project:documents:write'])
    vi.stubEnv('GRID_INBOUND_MAIL_DOMAIN', '')
    const body = inboundAddressResponseSchema.parse(await (await GET(new Request(url), context)).json())
    expect(body).toEqual({ enabled: false, address: null, canRotate: false })
  })
})

describe('POST /api/projects/[id]/inbound-address/rotate', () => {
  const rotate = () => POST(new Request(`${url}/rotate`, { method: 'POST' }), context)

  it('rotates for project:manage and answers the contract', async () => {
    grant(['project:manage'], 'project-admin')
    const response = await rotate()

    expect(response.status).toBe(200)
    const body = rotateInboundAddressResponseSchema.parse(await response.json())
    expect(body.address).toMatch(/^wohnbau-hietzing\.[a-z2-7]{12}@eingang\.piloti\.at$/)
    expect(requireProjectAccess).toHaveBeenCalledWith(expect.anything(), 'proj-1', 'project:manage')
    expect(rotateAddress).toHaveBeenCalledWith(expect.objectContaining({ revokedBy: 'user-1', projectId: 'proj-1' }))
  })

  it('is a 404 for an editor without project:manage, and revokes nothing', async () => {
    grant(['project:documents:write', 'project:edit'])
    expect((await rotate()).status).toBe(404)
    expect(rotateAddress).not.toHaveBeenCalled()
  })
})
