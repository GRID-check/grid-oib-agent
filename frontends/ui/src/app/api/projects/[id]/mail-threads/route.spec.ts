/**
 * @vitest-environment node
 */
/**
 * `/api/projects/[id]/mail-threads`: the list's query is the thread wire's.
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

vi.mock('@/lib/mail-thread/service', () => ({ listMailThreads: vi.fn().mockResolvedValue({ items: [], nextCursor: null }) }))

import { listMailThreads } from '@/lib/mail-thread/service'
import { GET } from './route'

const ctx = { params: Promise.resolve({ id: '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }) }

describe('/api/projects/[id]/mail-threads', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET lists the threads, narrowed to one document when asked', async () => {
    expect((await GET(new Request('http://localhost/x?documentId=4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b'), ctx)).status).toBe(200)
    expect(listMailThreads).toHaveBeenCalledWith(session, '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', { documentId: '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b', limit: 50 })
  })

  it('GET refuses a document id that is no id, before the service runs', async () => {
    expect((await GET(new Request('http://localhost/x?documentId=nope'), ctx)).status).toBe(400)
    expect(listMailThreads).not.toHaveBeenCalled()
  })
})
