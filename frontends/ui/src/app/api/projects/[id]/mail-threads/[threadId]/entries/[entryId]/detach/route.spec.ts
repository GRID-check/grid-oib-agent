/**
 * @vitest-environment node
 */
/**
 * Detach: the route parses the body with the wire's schema and hands it to the
 * service, which authorizes, renders both Fassungen and moves the message.
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

vi.mock('@/lib/mail-thread/detach', () => ({ detachMailThreadEntry: vi.fn() }))

import { detachMailThreadEntry } from '@/lib/mail-thread/detach'
import { POST } from './route'

const PROJECT = '3f0b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const THREAD = '4e5f6a7b-8c9d-4e0f-8a1b-2c3d4e5f6a7b'
const OTHER = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d'
const ENTRY = '7c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f'
const post = (body: unknown) =>
  POST(
    new Request('http://localhost/x', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    {
      params: Promise.resolve({ id: PROJECT, threadId: THREAD, entryId: ENTRY }),
    }
  )

describe('/api/projects/[id]/mail-threads/[threadId]/entries/[entryId]/detach', () => {
  beforeEach(() => vi.clearAllMocks())

  it('POST moves the message where the body says, and answers what each thread became', async () => {
    const result = {
      entryId: ENTRY,
      from: { threadId: THREAD, documentId: 'doc-1', versionId: 'ver-5' },
      to: { threadId: OTHER, documentId: 'doc-2', versionId: 'ver-3' },
      followsEnded: 1,
    }
    vi.mocked(detachMailThreadEntry).mockResolvedValueOnce(result)
    const res = await post({ target: { action: 'append', mailThreadId: OTHER } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(result)
    expect(detachMailThreadEntry).toHaveBeenCalledWith(
      session,
      PROJECT,
      THREAD,
      ENTRY,
      { target: { action: 'append', mailThreadId: OTHER } },
      expect.any(Request)
    )
  })

  it('refuses a body the wire does not know before the service runs', async () => {
    const res = await post({ target: { action: 'append', mailThreadId: OTHER, extra: true } })
    expect(res.status).toBe(400)
    expect(detachMailThreadEntry).not.toHaveBeenCalled()
  })

  it('answers the service’s refusal as a 409 with its reason', async () => {
    vi.mocked(detachMailThreadEntry).mockRejectedValueOnce(
      new ConflictError('only message', { reason: 'last_entry' })
    )
    const res = await post({ target: { action: 'create', name: 'Stellplatz' } })
    expect(res.status).toBe(409)
    expect((await res.json()).details).toMatchObject({ reason: 'last_entry' })
  })
})
