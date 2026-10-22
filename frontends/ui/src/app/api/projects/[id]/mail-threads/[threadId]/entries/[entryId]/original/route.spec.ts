/**
 * @vitest-environment node
 */
/**
 * A filed message's original `.eml`: the service's response (scanned whole on
 * the request, never sniffed) is passed through unchanged, and a refusal is the
 * service's 409.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictError } from '@/lib/api/errors'

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

vi.mock('@/lib/mail-thread/originals', () => ({
  readEntryOriginal: vi
    .fn()
    .mockImplementation(
      async () =>
        new Response('bytes', {
          status: 200,
          headers: { 'Content-Type': 'message/rfc822', 'X-Content-Type-Options': 'nosniff' },
        })
    ),
}))

import { readEntryOriginal } from '@/lib/mail-thread/originals'
import { GET } from './route'

const PROJECT = '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const THREAD = '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b'
const ENTRY = '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const call = () =>
  GET(new Request('http://localhost/x'), {
    params: Promise.resolve({ id: PROJECT, threadId: THREAD, entryId: ENTRY }),
  })

describe('/api/projects/[id]/mail-threads/[threadId]/entries/[entryId]/original', () => {
  beforeEach(() => vi.clearAllMocks())

  it('GET hands the session and the path’s ids to the service, which authorizes and scans', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('message/rfc822')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await res.text()).toBe('bytes')
    expect(readEntryOriginal).toHaveBeenCalledWith(session, PROJECT, THREAD, ENTRY)
  })

  it('answers 409 with the reason when the original is not clean', async () => {
    vi.mocked(readEntryOriginal).mockRejectedValueOnce(
      new ConflictError('not clean', { reason: 'original_not_clean', scan: 'infected' })
    )
    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).details).toMatchObject({ reason: 'original_not_clean' })
  })
})
