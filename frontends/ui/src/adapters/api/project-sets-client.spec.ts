/**
 * @vitest-environment node
 */

/**
 * What these tests hold is the CONTRACT, not the plumbing: which status means
 * which refusal, and the two coercions that keep a wrong answer from becoming a
 * wrong control — `editable` is never inferred, and `projectCount` is the
 * server's number even when it is zero.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  projectSetsClient,
  ProjectSetRefusedError,
  type ProjectSetSummary,
} from './project-sets-client'
import { ApiRequestError } from './api-error'

const json = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

const SET = {
  id: 's1',
  name: 'Bezirk 3',
  description: 'Alles im dritten Bezirk',
  createdBy: 'user_1',
  createdAt: '2026-09-08T10:00:00.000Z',
  updatedAt: '2026-09-08T10:00:00.000Z',
  projectCount: 3,
  editable: true,
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  global.fetch = fetchMock as unknown as typeof fetch
})

describe('list', () => {
  it('returns the sets with the caller’s own readable count', async () => {
    fetchMock.mockResolvedValue(json(200, { sets: [SET] }))

    const sets = await projectSetsClient.list()

    expect(fetchMock).toHaveBeenCalledWith('/api/workspace/project-sets')
    expect(sets[0]?.projectCount).toBe(3)
    expect(sets[0]?.editable).toBe(true)
  })

  it('keeps a readable count of zero rather than rounding it away', async () => {
    fetchMock.mockResolvedValue(json(200, { sets: [{ ...SET, projectCount: 0 }] }))
    expect((await projectSetsClient.list())[0]?.projectCount).toBe(0)
  })

  it('treats a missing `editable` as NOT editable, never as permission', async () => {
    const { editable: _dropped, ...withoutEditable } = SET
    fetchMock.mockResolvedValue(json(200, { sets: [withoutEditable] }))
    expect((await projectSetsClient.list())[0]?.editable).toBe(false)
  })

  it('drops a set with no id rather than rendering a nameless row', async () => {
    fetchMock.mockResolvedValue(json(200, { sets: [{ name: 'Ghost' }] }))
    expect(await projectSetsClient.list()).toEqual<ProjectSetSummary[]>([])
  })

  it('throws with the status when the list is refused', async () => {
    fetchMock.mockResolvedValue(json(403, {}))
    await expect(projectSetsClient.list()).rejects.toBeInstanceOf(ApiRequestError)
  })
})

describe('create', () => {
  it('posts the name and the description', async () => {
    fetchMock.mockResolvedValue(json(201, { set: { ...SET, projects: [] } }))

    const set = await projectSetsClient.create({ name: 'Bezirk 3', description: 'x' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspace/project-sets',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Bezirk 3', description: 'x' }),
      })
    )
    expect(set.name).toBe('Bezirk 3')
  })

  it('names a duplicate name as its own refusal, because it has its own remedy', async () => {
    fetchMock.mockResolvedValue(json(409, { error: 'A Sammlung named “Bezirk 3” already exists' }))

    const error = await projectSetsClient.create({ name: 'Bezirk 3' }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ProjectSetRefusedError)
    expect((error as ProjectSetRefusedError).code).toBe('duplicate_name')
  })
})

describe('get, update, delete', () => {
  it('reads a set with the members this caller may see', async () => {
    fetchMock.mockResolvedValue(
      json(200, { set: { ...SET, projects: [{ id: 'p1', name: 'Seestadt Nord' }] } })
    )

    const set = await projectSetsClient.get('s1')

    expect(fetchMock).toHaveBeenCalledWith('/api/workspace/project-sets/s1')
    expect(set.projects).toEqual([{ id: 'p1', name: 'Seestadt Nord' }])
  })

  it('patches only what changed', async () => {
    fetchMock.mockResolvedValue(json(200, { set: { ...SET, name: 'Bezirk III' } }))

    await projectSetsClient.update('s1', { name: 'Bezirk III' })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspace/project-sets/s1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ name: 'Bezirk III' }) })
    )
  })

  it.each([
    [403, 'not_editable'],
    [404, 'not_found'],
    [500, 'unavailable'],
  ])('maps %i on PATCH to the %s refusal', async (status, code) => {
    fetchMock.mockResolvedValue(json(status, {}))
    const error = await projectSetsClient.update('s1', { name: 'x' }).catch((e: unknown) => e)
    expect((error as ProjectSetRefusedError).code).toBe(code)
  })

  it('deletes by id and treats a 404 as the desired end state', async () => {
    fetchMock.mockResolvedValue(json(204, {}))
    await projectSetsClient.remove('s1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workspace/project-sets/s1',
      expect.objectContaining({ method: 'DELETE' })
    )

    fetchMock.mockResolvedValue(json(404, {}))
    await expect(projectSetsClient.remove('s1')).resolves.toBeUndefined()
  })

  it('refuses a delete the server would not do, so the row does not vanish on a lie', async () => {
    fetchMock.mockResolvedValue(json(403, {}))
    await expect(projectSetsClient.remove('s1')).rejects.toBeInstanceOf(ProjectSetRefusedError)
  })
})

describe('membership', () => {
  it('adds and removes through the same path, in opposite methods', async () => {
    fetchMock.mockResolvedValue(json(200, { set: { ...SET, projects: [] } }))

    await projectSetsClient.addProjects('s1', ['p1', 'p2'])
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/workspace/project-sets/s1/projects',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectIds: ['p1', 'p2'] }) })
    )

    await projectSetsClient.removeProjects('s1', ['p1'])
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/workspace/project-sets/s1/projects',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ projectIds: ['p1'] }) })
    )
  })

  it('reports an unreadable id as not_found, which is all the server says', async () => {
    fetchMock.mockResolvedValue(json(404, {}))
    const error = await projectSetsClient.addProjects('s1', ['p9']).catch((e: unknown) => e)
    expect((error as ProjectSetRefusedError).code).toBe('not_found')
  })
})
