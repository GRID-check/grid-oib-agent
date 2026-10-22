/**
 * @vitest-environment node
 */
/**
 * One mail thread, as readable as its document.
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

vi.mock('@/lib/mail-thread/service', () => ({ getMailThread: vi.fn().mockResolvedValue({ id: 'x' }) }))

import { getMailThread } from '@/lib/mail-thread/service'
import { GET } from './route'

describe('/api/projects/[id]/mail-threads/[threadId]', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET hands the session and the path’s ids to the service, which authorizes', async () => {
    const res = await GET(new Request('http://localhost/x'), { params: Promise.resolve({ id: '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', threadId: '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b' }) })
    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe('x')
    expect(getMailThread).toHaveBeenCalledWith(session, '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b')
  })
})
