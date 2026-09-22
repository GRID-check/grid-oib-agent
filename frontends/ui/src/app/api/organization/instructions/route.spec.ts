/**
 * @vitest-environment node
 */
/**
 * `/api/organization/instructions` — who may read the block and who may write it.
 *
 * The gate is the interesting half. Writing the instruction block changes what
 * Piloti says to everyone in the organization, so it takes
 * `org:settings:manage` — the permission ADR-0016's registry already defines for
 * settings that shape how the organization behaves for everyone in it, and the
 * same one `/api/organization/settings` uses for the web-search toggle beside
 * it. Reading takes only a session: the block shapes every answer a member
 * gets, so it is not a secret from them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'admin@example.test',
  role: 'member',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
  authzErrorResponse: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/org-instructions/service', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/org-instructions/service')>()
  return {
    ...original,
    getOrgInstructions: vi.fn().mockResolvedValue({
      instructions: 'Assume Vienna.',
      updatedBy: 'user-1',
      updatedByEmail: 'admin@example.test',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    saveOrgInstructions: vi
      .fn()
      .mockImplementation(async (_s: unknown, input: { instructions: string }) => ({
        instructions: input.instructions.trim() || null,
        updatedBy: 'user-1',
        updatedByEmail: 'admin@example.test',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
  }
})

import { ORG_INSTRUCTIONS_MAX_CHARS } from '@/lib/org-instructions/constants'
import { getOrgInstructions, saveOrgInstructions } from '@/lib/org-instructions/service'
import { GET, PUT } from './route'

const get = (): Request => new Request('http://localhost/api/organization/instructions')

const put = (body: unknown): Request =>
  new Request('http://localhost/api/organization/instructions', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('/api/organization/instructions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    session.role = 'member'
    session.permissions = []
  })

  it('GET lets any member read their own organization’s block', async () => {
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect((await res.json()).instructions.instructions).toBe('Assume Vienna.')
    // Keyed by the session, never by a caller-supplied organization id.
    expect(getOrgInstructions).toHaveBeenCalledWith('org-1')
  })

  it('PUT refuses a member without org:settings:manage, before anything is written', async () => {
    const res = await PUT(put({ instructions: 'Answer in one paragraph.' }))
    expect(res.status).toBe(403)
    expect(saveOrgInstructions).not.toHaveBeenCalled()
  })

  it('PUT accepts an org:settings:manage holder', async () => {
    session.permissions = ['org:settings:manage']
    const res = await PUT(put({ instructions: 'Answer in one paragraph.' }))
    expect(res.status).toBe(200)
    expect(saveOrgInstructions).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
      { instructions: 'Answer in one paragraph.' },
      expect.any(Request)
    )
  })

  it('PUT refuses a block over the cap with a 400, rather than truncating it', async () => {
    session.permissions = ['org:settings:manage']
    const res = await PUT(put({ instructions: 'a'.repeat(ORG_INSTRUCTIONS_MAX_CHARS + 1) }))
    expect(res.status).toBe(400)
    expect(saveOrgInstructions).not.toHaveBeenCalled()
  })

  it('PUT takes an empty block as the clear it is', async () => {
    session.permissions = ['org:settings:manage']
    const res = await PUT(put({ instructions: '' }))
    expect(res.status).toBe(200)
    expect((await res.json()).instructions.instructions).toBeNull()
  })
})
