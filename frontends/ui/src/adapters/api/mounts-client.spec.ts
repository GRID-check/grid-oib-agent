/**
 * @vitest-environment node
 */

/**
 * The mounts client is the UI's half of a contract written down before either
 * side existed (phase 3 contract §1), so what these tests hold is the contract:
 * which status means which refusal, and that a refusal the reader has an OFFER
 * for (the cap) arrives carrying the numbers that offer needs.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mountsClient, MountRefusedError } from './mounts-client'
import { ApiRequestError } from './api-error'

const json = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  global.fetch = fetchMock as unknown as typeof fetch
})

describe('list', () => {
  it('returns the mounts and the server-stated cap', async () => {
    fetchMock.mockResolvedValue(
      json(200, {
        mounts: [
          { projectId: 'p1', projectName: 'Seestadt Nord', mountedBy: 'user', mountedAt: '2026-09-08T10:00:00.000Z' },
        ],
        cap: 5,
      })
    )

    const result = await mountsClient.list('conv-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/conversations/conv-1/mounts')
    expect(result.cap).toBe(5)
    expect(result.mounts[0]?.projectName).toBe('Seestadt Nord')
  })

  it('drops a row with no project id rather than rendering a nameless chip', async () => {
    fetchMock.mockResolvedValue(json(200, { mounts: [{ projectName: 'Ghost' }], cap: 5 }))
    expect((await mountsClient.list('c')).mounts).toEqual([])
  })

  it('throws with the status when the list is refused', async () => {
    fetchMock.mockResolvedValue(json(403, {}))
    await expect(mountsClient.list('c')).rejects.toBeInstanceOf(ApiRequestError)
  })
})

describe('mount', () => {
  it('posts the project id and returns the mount', async () => {
    fetchMock.mockResolvedValue(
      json(201, {
        mount: { projectId: 'p1', projectName: 'Seestadt Nord', mountedBy: 'user', mountedAt: 'x' },
        grant: { grant: 'b64', sig: 'hex' },
      })
    )

    const mount = await mountsClient.mount('conv-1', 'p1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/conv-1/mounts',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectId: 'p1' }) })
    )
    expect(mount.projectId).toBe('p1')
  })

  it('carries the cap and the mounted names on 409, because the offer needs them', async () => {
    fetchMock.mockResolvedValue(
      json(409, { code: 'WORKSPACE_MOUNT_CAP', cap: 5, mounted: ['A', 'B'] })
    )

    await expect(mountsClient.mount('c', 'p')).rejects.toMatchObject({
      code: 'cap',
      cap: 5,
      mounted: ['A', 'B'],
    })
  })

  it.each([
    [403, 'no_access'],
    [404, 'not_found'],
    [500, 'unavailable'],
  ])('maps %i to the %s refusal', async (status, code) => {
    fetchMock.mockResolvedValue(json(status, {}))
    const error = await mountsClient.mount('c', 'p').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MountRefusedError)
    expect((error as MountRefusedError).code).toBe(code)
  })
})

describe('the two 409s', () => {
  it('reads the exclusion refusal as its own code, with the people it names', async () => {
    fetchMock.mockResolvedValue(
      json(409, {
        code: 'WORKSPACE_MOUNT_WOULD_EXCLUDE',
        excluded: ['Anna Meier', 'Bernd Huber'],
      })
    )

    await expect(mountsClient.mount('c', 'p')).rejects.toMatchObject({
      code: 'would_exclude',
      excluded: ['Anna Meier', 'Bernd Huber'],
    })
  })

  it('still reads a bodyless 409 as the cap, which is the older and commoner one', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => {
        throw new Error('no body')
      },
    } as unknown as Response)

    await expect(mountsClient.mount('c', 'p')).rejects.toMatchObject({ code: 'cap' })
  })
})

describe('mountSet', () => {
  const answer = {
    set: { id: 's1', name: 'Bezirk 3' },
    mounts: [
      {
        mount: {
          projectId: 'p1',
          projectName: 'Seestadt Nord',
          mountedBy: 'user',
          mountedAt: '2026-09-08T10:00:00.000Z',
        },
        grant: { grant: 'b64', sig: 'hex' },
        created: true,
      },
    ],
    skipped: [{ projectId: 'p2', projectName: 'Nordbahnhof', reason: 'forbidden' }],
  }

  it('posts the SET id, never a project id', async () => {
    fetchMock.mockResolvedValue(json(201, answer))

    const result = await mountsClient.mountSet('conv-1', 's1')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/conv-1/mounts',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ projectSetId: 's1' }) })
    )
    expect(result.set).toEqual({ id: 's1', name: 'Bezirk 3' })
    expect(result.mounts.map((m) => m.projectId)).toEqual(['p1'])
  })

  it('reports the skipped members rather than throwing away the half that worked', async () => {
    fetchMock.mockResolvedValue(json(201, answer))

    const result = await mountsClient.mountSet('c', 's1')

    expect(result.skipped).toEqual([
      { projectId: 'p2', projectName: 'Nordbahnhof', reason: 'forbidden' },
    ])
  })

  it('carries the Sammlung’s name on the cap refusal, so the sentence can name it', async () => {
    fetchMock.mockResolvedValue(
      json(409, {
        code: 'WORKSPACE_MOUNT_CAP',
        cap: 5,
        mounted: ['A'],
        set: { id: 's1', name: 'Bezirk 3' },
      })
    )

    await expect(mountsClient.mountSet('c', 's1')).rejects.toMatchObject({
      code: 'cap',
      cap: 5,
      set: { id: 's1', name: 'Bezirk 3' },
    })
  })

  it.each([
    [403, 'no_access'],
    [404, 'not_found'],
    [500, 'unavailable'],
  ])('maps %i to the %s refusal, exactly as one project does', async (status, code) => {
    fetchMock.mockResolvedValue(json(status, {}))
    const error = await mountsClient.mountSet('c', 's1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MountRefusedError)
    expect((error as MountRefusedError).code).toBe(code)
  })
})

describe('unmount', () => {
  it('deletes by project id', async () => {
    fetchMock.mockResolvedValue(json(204, {}))
    await mountsClient.unmount('conv-1', 'p1')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/conversations/conv-1/mounts/p1',
      expect.objectContaining({ method: 'DELETE' })
    )
  })

  it('treats a 404 as the desired end state — the project is not in view', async () => {
    fetchMock.mockResolvedValue(json(404, {}))
    await expect(mountsClient.unmount('c', 'p')).resolves.toBeUndefined()
  })

  it('throws on any other failure, so the chip does not vanish on a lie', async () => {
    fetchMock.mockResolvedValue(json(500, {}))
    await expect(mountsClient.unmount('c', 'p')).rejects.toBeInstanceOf(ApiRequestError)
  })
})
