/**
 * @vitest-environment node
 */
/**
 * One Sammlung: read, rename, delete (ADR-0054, spec GR-2).
 *
 * Thin adapter, so the assertions are the three things HTTP adds: the envelope,
 * the 204 on delete, and that the service's refusals keep their own status.
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
  getProjectSet: vi.fn(),
  updateProjectSet: vi.fn(),
  deleteProjectSet: vi.fn(),
}))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import {
  deleteProjectSet,
  getProjectSet,
  updateProjectSet,
} from '@/lib/workspace/project-sets-service'
import { DELETE, GET, PATCH } from './route'

const SET = '99999999-9999-9999-9999-999999999999'

const detail = {
  id: SET,
  name: 'Bezirk 3',
  description: null,
  createdBy: 'user_1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  projectCount: 1,
  editable: true,
  projects: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Seestadt' }],
}

const context = { params: Promise.resolve({ id: SET }) }
const url = `https://grid.test/api/workspace/project-sets/${SET}`

const get = () => GET(new Request(url), context)
const patch = (body: unknown) =>
  PATCH(
    new Request(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    context
  )
const del = () => DELETE(new Request(url, { method: 'DELETE' }), context)

beforeEach(() => {
  vi.mocked(getProjectSet).mockResolvedValue(detail)
  vi.mocked(updateProjectSet).mockResolvedValue({ ...detail, name: 'Bezirk 4' })
})

afterEach(() => vi.clearAllMocks())

describe('GET /api/workspace/project-sets/:id', () => {
  it('serves the set with the members this caller may see', async () => {
    const response = await get()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ set: detail })
    expect(getProjectSet).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1' }), SET)
  })

  it('answers a set this caller may not reach as if it did not exist', async () => {
    vi.mocked(getProjectSet).mockRejectedValue(new NotFoundError())
    expect((await get()).status).toBe(404)
  })
})

describe('PATCH /api/workspace/project-sets/:id', () => {
  it('renames it and answers with the whole set', async () => {
    const response = await patch({ name: 'Bezirk 4' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ set: { ...detail, name: 'Bezirk 4' } })
    expect(updateProjectSet).toHaveBeenCalledWith(expect.anything(), SET, { name: 'Bezirk 4' })
  })

  it('accepts clearing the description', async () => {
    await patch({ description: null })
    expect(updateProjectSet).toHaveBeenCalledWith(expect.anything(), SET, { description: null })
  })

  it('refuses a blank name at the schema, before the service', async () => {
    expect((await patch({ name: '' })).status).toBe(400)
    expect(updateProjectSet).not.toHaveBeenCalled()
  })

  it('keeps the service’s 403 for somebody else’s Sammlung', async () => {
    vi.mocked(updateProjectSet).mockRejectedValue(new ForbiddenError('not yours'))
    expect((await patch({ name: 'Bezirk 4' })).status).toBe(403)
  })
})

describe('DELETE /api/workspace/project-sets/:id', () => {
  it('answers 204 with no body', async () => {
    const response = await del()

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(deleteProjectSet).toHaveBeenCalledWith(expect.anything(), SET)
  })
})
