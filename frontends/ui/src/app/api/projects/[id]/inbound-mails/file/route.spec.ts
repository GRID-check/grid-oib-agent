/**
 * @vitest-environment node
 */
/**
 * `/api/projects/[id]/inbound-mails/file`: the decision body is the wire's, parsed here; every
 * rule of C2 is the service's (`decision.spec.ts`). Answers 202: the job files.
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

vi.mock('@/lib/inbound-mail/service', async () => {
  const { ConflictError } = await import('@/lib/api/errors')
  return {
    fileInboundMails: vi.fn().mockImplementation(async (_s: unknown, _p: string, body: { mails: Array<{ ifMatch: string }> }) => {
      if (body.mails[0]?.ifMatch === 'old') throw new ConflictError('changed', { reason: 'stale', mailId: 'm' })
      return { mails: [], filingJobId: 'job-1' }
    }),
  }
})

import { fileInboundMails } from '@/lib/inbound-mail/service'
import { POST } from './route'

const post = (payload: unknown) =>
  POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    { params: Promise.resolve({ id: '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' }) },
  )
const valid = {
  mails: [
    {
      mailId: '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
      ifMatch: 'tok',
      parts: [{ partId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', folderId: null, newFolderPath: 'Statik', name: 'S-101_C.pdf' }],
      message: null,
    },
  ],
}

describe('/api/projects/[id]/inbound-mails/file', () => {
  beforeEach(() => vi.clearAllMocks())

  it('answers 202 once the decisions are written, and the job id', async () => {
    const res = await post(valid)
    expect(res.status).toBe(202)
    expect((await res.json()).filingJobId).toBe('job-1')
    expect(fileInboundMails).toHaveBeenCalledWith(session, '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', valid)
  })

  it('refuses a body the wire does not accept, before any decision is checked', async () => {
    expect((await post({ mails: [] })).status).toBe(400)
    expect((await post({ mails: [valid.mails[0], valid.mails[0]] })).status).toBe(400)
    const both = { ...valid.mails[0], parts: [{ ...valid.mails[0]!.parts[0], folderId: '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b' }] }
    expect((await post({ mails: [both] })).status).toBe(400)
    expect((await post({ mails: [{ ...valid.mails[0], acknowledgeSender: false }] })).status).toBe(400)
    expect(fileInboundMails).not.toHaveBeenCalled()
  })

  it('passes a refusal through with its code, so the caller knows what to change', async () => {
    const res = await post({ mails: [{ ...valid.mails[0], ifMatch: 'old' }] })
    expect(res.status).toBe(409)
    expect((await res.json()).details).toMatchObject({ reason: 'stale' })
  })
})
