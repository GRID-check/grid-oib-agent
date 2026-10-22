/**
 * @vitest-environment node
 */
/**
 * `/api/projects/[id]/inbound-mail-address`: a thin adapter. Reading, creating and switching off
 * the address are the address service's, which asks the entitlement and the project rights; a
 * read never mints (`address-service.spec.ts`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user_01JCX0R4D8M2W6YB3N5Q7T9V1A',
  organizationId: 'org_1',
  email: 'lena@example.test',
  role: 'member',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
  authzErrorResponse: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/inbound-mail/address-service', async () => {
  const { NotFoundError } = await import('@/lib/api/errors')
  const view = { state: 'active', address: 'haus.abcdefgh2345@piloti.at', canManage: true, lastReceivedAt: null, droppedLast30Days: 0, ownDomainVerifiedShare: null }
  return {
    getInboundMailAddress: vi.fn().mockImplementation(async (_s: unknown, projectId: string) => {
      if (projectId === 'hidden') throw new NotFoundError()
      return { ...view, state: 'none', address: null }
    }),
    createInboundMailAddress: vi.fn().mockResolvedValue(view),
    deleteInboundMailAddress: vi.fn().mockResolvedValue({ ...view, state: 'none', address: null }),
  }
})

import { createInboundMailAddress, deleteInboundMailAddress, getInboundMailAddress } from '@/lib/inbound-mail/address-service'
import { DELETE, GET, POST } from './route'

const url = 'http://localhost/api/projects/3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/inbound-mail-address'
const ctx = (id = '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d') => ({ params: Promise.resolve({ id }) })

describe('/api/projects/[id]/inbound-mail-address', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET answers the address as the session reads it, and never creates one', async () => {
    const res = await GET(new Request(url), ctx())
    expect(res.status).toBe(200)
    expect((await res.json()).state).toBe('none')
    expect(getInboundMailAddress).toHaveBeenCalledWith(session, '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')
    expect(createInboundMailAddress).not.toHaveBeenCalled()
  })

  it('GET answers 404 for a project whose mail the caller may not review', async () => {
    expect((await GET(new Request(url), ctx('hidden'))).status).toBe(404)
  })

  it('POST creates the address as the caller; DELETE switches it off', async () => {
    expect((await POST(new Request(url, { method: 'POST' }), ctx())).status).toBe(200)
    expect(createInboundMailAddress).toHaveBeenCalledWith(session, '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')
    expect((await DELETE(new Request(url, { method: 'DELETE' }), ctx())).status).toBe(200)
    expect(deleteInboundMailAddress).toHaveBeenCalledWith(session, '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')
  })
})
