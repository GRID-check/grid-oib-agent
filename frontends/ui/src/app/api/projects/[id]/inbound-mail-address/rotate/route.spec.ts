/**
 * @vitest-environment node
 */
/**
 * `/api/projects/[id]/inbound-mail-address/rotate`: replaces the address as the caller.
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

vi.mock('@/lib/inbound-mail/address-service', () => ({
  rotateInboundMailAddress: vi.fn().mockResolvedValue({ state: 'active', address: 'haus.zyxwvuts2345@piloti.at' }),
}))

import { rotateInboundMailAddress } from '@/lib/inbound-mail/address-service'
import { POST } from './route'

describe('/api/projects/[id]/inbound-mail-address/rotate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('POST replaces the address as the caller and answers the new one', async () => {
    const res = await POST(new Request('http://localhost/x', { method: 'POST' }), { params: Promise.resolve({ id: '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }) })
    expect(res.status).toBe(200)
    expect((await res.json()).address).toBe('haus.zyxwvuts2345@piloti.at')
    expect(rotateInboundMailAddress).toHaveBeenCalledWith(session, '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')
  })
})
