/**
 * @vitest-environment node
 */
/**
 * Restore a held mail's dismissed or expired parts.
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

vi.mock('@/lib/inbound-mail/service', () => ({ restoreInboundMail: vi.fn().mockResolvedValue({ id: 'x' }) }))

import { restoreInboundMail } from '@/lib/inbound-mail/service'
import { POST } from './route'

describe('/api/projects/[id]/inbound-mails/[mailId]/restore', () => {
  beforeEach(() => vi.clearAllMocks())

  it('POST hands the session and the path’s ids to the service, which authorizes', async () => {
    const res = await POST(new Request('http://localhost/x', { method: 'POST' }), { params: Promise.resolve({ id: '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', mailId: '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' }) })
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('x')
    expect(restoreInboundMail).toHaveBeenCalledWith(session, '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f')
  })
})
