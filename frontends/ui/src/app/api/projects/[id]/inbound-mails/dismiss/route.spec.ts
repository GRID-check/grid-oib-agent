/**
 * @vitest-environment node
 */
/**
 * `/api/projects/[id]/inbound-mails/dismiss`: up to 20 mails, each named once.
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

vi.mock('@/lib/inbound-mail/service', () => ({ dismissInboundMails: vi.fn().mockResolvedValue({ mails: [] }) }))

import { dismissInboundMails } from '@/lib/inbound-mail/service'
import { POST } from './route'

const post = (payload: unknown) =>
  POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    { params: Promise.resolve({ id: '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }) },
  )

describe('/api/projects/[id]/inbound-mails/dismiss', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dismisses the named mails as the caller', async () => {
    expect((await post({ mailIds: ['7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'] })).status).toBe(200)
    expect(dismissInboundMails).toHaveBeenCalledWith(session, '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', { mailIds: ['7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'] })
  })

  it('refuses no mail, a mail twice, or more than twenty', async () => {
    expect((await post({ mailIds: [] })).status).toBe(400)
    expect((await post({ mailIds: ['7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f', '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'] })).status).toBe(400)
    const many = Array.from({ length: 21 }, (_, index) => `7c1d2e3f-4a5b-4c6d-8e7f-${String(index).padStart(12, '0')}`)
    expect((await post({ mailIds: many })).status).toBe(400)
    expect(dismissInboundMails).not.toHaveBeenCalled()
  })
})
