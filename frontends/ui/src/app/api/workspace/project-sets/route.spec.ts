/**
 * @vitest-environment node
 */
/**
 * The Sammlungen collection route (ADR-0054, spec GR-2).
 *
 * A thin adapter, so what is worth asserting is what HTTP adds: the envelope
 * the list is wrapped in, the body `POST` accepts, and the 201. The decisions —
 * `org:chat`, the per-caller readability, the unique name — belong to
 * `project-sets-service.spec.ts`; asserting them here would be asserting the mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: ['org:chat'],
  }),
  authzErrorResponse: () => null,
}))

vi.mock('@/lib/workspace/project-sets-service', () => ({
  listProjectSets: vi.fn(),
  createProjectSet: vi.fn(),
}))

import { ConflictError, ForbiddenError } from '@/lib/api/errors'
import { createProjectSet, listProjectSets } from '@/lib/workspace/project-sets-service'
import { GET, POST } from './route'

const summary = {
  id: '99999999-9999-9999-9999-999999999999',
  name: 'Bezirk 3',
  description: null,
  createdBy: 'user_1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  projectCount: 2,
  editable: true,
}

const get = () => GET(new Request('https://grid.test/api/workspace/project-sets'), undefined)

const post = (body: unknown) =>
  POST(
    new Request('https://grid.test/api/workspace/project-sets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    undefined
  )

beforeEach(() => {
  vi.mocked(listProjectSets).mockResolvedValue([summary])
  vi.mocked(createProjectSet).mockResolvedValue({ ...summary, projectCount: 0, projects: [] })
})

afterEach(() => vi.clearAllMocks())

describe('GET /api/workspace/project-sets', () => {
  it('serves the organization’s Sammlungen under a named key', async () => {
    const response = await get()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sets: [summary] })
  })

  it('passes a refusal from the service through as its own status', async () => {
    vi.mocked(listProjectSets).mockRejectedValue(new ForbiddenError('Missing permission: org:chat'))
    expect((await get()).status).toBe(403)
  })
})

describe('POST /api/workspace/project-sets', () => {
  it('creates one and answers 201 with the whole set', async () => {
    const response = await post({ name: 'Bezirk 3' })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      set: { ...summary, projectCount: 0, projects: [] },
    })
    expect(createProjectSet).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1' }), {
      name: 'Bezirk 3',
    })
  })

  it('refuses a body with no name', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ name: '' })).status).toBe(400)
    expect(createProjectSet).not.toHaveBeenCalled()
  })

  it('surfaces the duplicate name as a 409', async () => {
    vi.mocked(createProjectSet).mockRejectedValue(new ConflictError('already exists'))
    expect((await post({ name: 'Bezirk 3' })).status).toBe(409)
  })
})
