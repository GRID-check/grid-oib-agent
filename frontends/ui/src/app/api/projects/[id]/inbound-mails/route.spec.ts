/**
 * @vitest-environment node
 */
/**
 * `/api/projects/[id]/inbound-mails`: the list's query is parsed here, from the wire's schema.
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

vi.mock('@/lib/inbound-mail/service', () => ({
  listInboundMails: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
}))

import { listInboundMails } from '@/lib/inbound-mail/service'
import { GET } from './route'

const ctx = { params: Promise.resolve({ id: '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }) }

describe('/api/projects/[id]/inbound-mails', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET lists the waiting mail by default, a page of 25', async () => {
    const res = await GET(new Request('http://localhost/api/projects/3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d/inbound-mails'), ctx)
    expect(res.status).toBe(200)
    expect(listInboundMails).toHaveBeenCalledWith(session, '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', { status: 'waiting', limit: 25 })
  })

  it('GET passes the handled list, its outcome and the cursor through', async () => {
    await GET(new Request('http://localhost/x?status=handled&outcome=dismissed&limit=5&cursor=abc'), ctx)
    expect(listInboundMails).toHaveBeenCalledWith(session, '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', { status: 'handled', outcome: 'dismissed', limit: 5, cursor: 'abc' })
  })

  it('GET refuses a status or a page size it does not know, before the service runs', async () => {
    expect((await GET(new Request('http://localhost/x?status=all'), ctx)).status).toBe(400)
    expect((await GET(new Request('http://localhost/x?limit=500'), ctx)).status).toBe(400)
    expect(listInboundMails).not.toHaveBeenCalled()
  })
})
