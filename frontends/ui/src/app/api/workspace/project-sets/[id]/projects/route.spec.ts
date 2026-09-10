/**
 * @vitest-environment node
 */
/**
 * What a Sammlung names — add and remove (ADR-0054, spec GR-2).
 *
 * Both directions answer with the WHOLE set, so a client never has to re-read
 * to render the result of its own edit. The asymmetry between them (adding
 * demands `project:view`, removing demands nothing) is the service's claim and
 * is asserted there.
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
  addProjectsToSet: vi.fn(),
  removeProjectsFromSet: vi.fn(),
}))

import { NotFoundError } from '@/lib/api/errors'
import { addProjectsToSet, removeProjectsFromSet } from '@/lib/workspace/project-sets-service'
import { DELETE, POST } from './route'

const SET = '99999999-9999-9999-9999-999999999999'
const PROJECT = '11111111-1111-1111-1111-111111111111'

const detail = {
  id: SET,
  name: 'Bezirk 3',
  description: null,
  createdBy: 'user_1',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  projectCount: 1,
  editable: true,
  projects: [{ id: PROJECT, name: 'Seestadt' }],
}

const context = { params: Promise.resolve({ id: SET }) }
const url = `https://grid.test/api/workspace/project-sets/${SET}/projects`

const call = (method: 'POST' | 'DELETE', body: unknown) => {
  const request = new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return method === 'POST' ? POST(request, context) : DELETE(request, context)
}

beforeEach(() => {
  vi.mocked(addProjectsToSet).mockResolvedValue(detail)
  vi.mocked(removeProjectsFromSet).mockResolvedValue({ ...detail, projectCount: 0, projects: [] })
})

afterEach(() => vi.clearAllMocks())

describe('POST /api/workspace/project-sets/:id/projects', () => {
  it('adds the named projects and answers with the whole set', async () => {
    const response = await call('POST', { projectIds: [PROJECT] })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ set: detail })
    expect(addProjectsToSet).toHaveBeenCalledWith(expect.anything(), SET, [PROJECT])
  })

  it('refuses a body that names no project, or names one that is not an id', async () => {
    expect((await call('POST', {})).status).toBe(400)
    expect((await call('POST', { projectIds: [] })).status).toBe(400)
    expect((await call('POST', { projectIds: ['Seestadt'] })).status).toBe(400)
    expect(addProjectsToSet).not.toHaveBeenCalled()
  })

  it('answers a project this caller may not view as if it did not exist', async () => {
    // Naming nothing: adding ids to your own Sammlung must not be a way to
    // discover which project ids this organization holds (MT-4's reasoning).
    vi.mocked(addProjectsToSet).mockRejectedValue(new NotFoundError())
    const response = await call('POST', { projectIds: [PROJECT] })

    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain(PROJECT)
  })
})

describe('DELETE /api/workspace/project-sets/:id/projects', () => {
  it('removes the named projects and answers with the whole set', async () => {
    const response = await call('DELETE', { projectIds: [PROJECT] })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      set: { ...detail, projectCount: 0, projects: [] },
    })
    expect(removeProjectsFromSet).toHaveBeenCalledWith(expect.anything(), SET, [PROJECT])
  })
})
