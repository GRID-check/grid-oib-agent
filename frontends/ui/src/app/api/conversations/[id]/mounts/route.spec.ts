/**
 * @vitest-environment node
 */
/**
 * The session-authenticated half of the mounts endpoint (ADR-0054, spec MT-2,
 * MT-11).
 *
 * The route is a thin adapter, so what is worth asserting is exactly the three
 * things HTTP adds on top of the service: the body it accepts, the 201/200
 * split, and the cap's 409 — the one refusal that carries a body of its own,
 * because two very different clients read `cap` and `mounted` from it. The
 * decisions themselves (the permission, the cap, idempotence, the grant) belong
 * to `mounts-service.spec.ts`; asserting them again here would be asserting the
 * mock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
  }),
  authzErrorResponse: () => null,
}))

// The real module minus its two entry points: `WorkspaceMountCapError` has to
// be the SAME class the route tests `instanceof` against, or this suite would
// pass while the shipped route fell through to a 500.
vi.mock('@/lib/workspace/mounts-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace/mounts-service')>()
  return { ...actual, listMounts: vi.fn(), mountProject: vi.fn(), mountProjectSet: vi.fn() }
})

import { NotFoundError } from '@/lib/api/errors'
import {
  listMounts,
  mountProject,
  mountProjectSet,
  WorkspaceMountCapError,
  WorkspaceMountExclusionError,
} from '@/lib/workspace/mounts-service'
import { GET, POST } from './route'

const CONVERSATION = 'conv_buero'
const PROJECT = '11111111-1111-1111-1111-111111111111'

const context = { params: Promise.resolve({ id: CONVERSATION }) }

const get = () =>
  GET(new Request(`https://grid.test/api/conversations/${CONVERSATION}/mounts`), context)

const post = (body: unknown) =>
  POST(
    new Request(`https://grid.test/api/conversations/${CONVERSATION}/mounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    context
  )

const mount = {
  projectId: PROJECT,
  projectName: 'Seestadt',
  mountedBy: 'user' as const,
  mountedAt: '2026-09-08T10:00:00.000Z',
}
const grant = { grant: 'eyJ2IjoxfQ', sig: 'abc123' }

const SET = '99999999-9999-9999-9999-999999999999'

beforeEach(() => {
  vi.mocked(listMounts).mockResolvedValue({ mounts: [], cap: 5 })
  vi.mocked(mountProject).mockResolvedValue({ mount, grant, created: true })
  vi.mocked(mountProjectSet).mockResolvedValue({
    set: { id: SET, name: 'Bezirk 3' },
    mounts: [{ mount, grant, created: true }],
    skipped: [],
  })
})

afterEach(() => vi.clearAllMocks())

describe('GET /api/conversations/:id/mounts', () => {
  it('serves the mounted set and the cap the UI measures it against', async () => {
    vi.mocked(listMounts).mockResolvedValue({ mounts: [mount], cap: 5 })

    const response = await get()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mounts: [mount], cap: 5 })
    expect(listMounts).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user_1' }),
      CONVERSATION
    )
  })

  it('answers a conversation the caller may not read as if it did not exist', async () => {
    vi.mocked(listMounts).mockRejectedValue(new NotFoundError())

    expect((await get()).status).toBe(404)
  })
})

describe('POST /api/conversations/:id/mounts', () => {
  it('mounts as the PERSON and answers 201 with the mount and its grant', async () => {
    const response = await post({ projectId: PROJECT })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ mount, grant })
    expect(mountProject).toHaveBeenCalledWith({
      session: expect.objectContaining({ userId: 'user_1' }),
      conversationId: CONVERSATION,
      projectId: PROJECT,
      // Never `agent` from this route: the actor is what a reader later reads
      // as attribution, so the adapter states it rather than accepting it.
      mountedBy: 'user',
    })
  })

  it('answers 200 for the idempotent re-mount — the same mount said twice', async () => {
    vi.mocked(mountProject).mockResolvedValue({ mount, grant, created: false })

    const response = await post({ projectId: PROJECT })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mount, grant })
  })

  it('surfaces the cap as a 409 whose body names the cap and what is already mounted', async () => {
    vi.mocked(mountProject).mockRejectedValue(
      new WorkspaceMountCapError(5, ['Seestadt', 'Nordbahnhof'])
    )

    const response = await post({ projectId: PROJECT })

    expect(response.status).toBe(409)
    // `cap` and `mounted` sit at the TOP LEVEL, not under the envelope's
    // `details`: the UI disables its add row from them and the Python tool
    // builds its refusal string from them (MT-9).
    expect(await response.json()).toMatchObject({
      code: 'WORKSPACE_MOUNT_CAP',
      cap: 5,
      mounted: ['Seestadt', 'Nordbahnhof'],
    })
  })

  it('renders the exclusion refusal with the NAMES at the top level (spec AC-8)', async () => {
    vi.mocked(mountProject).mockRejectedValue(
      new WorkspaceMountExclusionError(['Anna Meier', 'Bernd Huber'])
    )

    const response = await post({ projectId: PROJECT })

    expect(response.status).toBe(409)
    // Same shape as the cap's refusal, and for the same reason: the UI puts the
    // names beside its add row, the agent puts them in a sentence, and a body
    // the two read differently is a body they can disagree about.
    expect(await response.json()).toMatchObject({
      code: 'WORKSPACE_MOUNT_WOULD_EXCLUDE',
      excluded: ['Anna Meier', 'Bernd Huber'],
    })
  })

  it('refuses a body that names neither target, both, or a non-id', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ projectId: 'Seestadt' })).status).toBe(400)
    // Both is a client bug, and a precedence rule ("the project wins") would
    // make it a silent one.
    expect((await post({ projectId: PROJECT, projectSetId: SET })).status).toBe(400)
    expect(mountProject).not.toHaveBeenCalled()
    expect(mountProjectSet).not.toHaveBeenCalled()
  })

  it('answers a project the caller may not reach as if it did not exist (MT-4)', async () => {
    vi.mocked(mountProject).mockRejectedValue(new NotFoundError())

    expect((await post({ projectId: PROJECT })).status).toBe(404)
  })
})

/**
 * The same endpoint, given a Sammlung (spec GR-2).
 *
 * MT-2 says one endpoint so that there is one place a mount is authorized; a
 * set is not a reason for a second one. What differs is the answer's shape,
 * because `{ mount, grant }` is what the UI and the Python tool already read
 * and folding a set into it would make every existing reader parse a case it
 * never asks for.
 */
describe('POST /api/conversations/:id/mounts — a Sammlung', () => {
  it('mounts the set and answers 201 with one grant per mount', async () => {
    const response = await post({ projectSetId: SET })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      set: { id: SET, name: 'Bezirk 3' },
      mounts: [{ mount, grant, created: true }],
      skipped: [],
    })
    expect(mountProjectSet).toHaveBeenCalledWith({
      session: expect.objectContaining({ userId: 'user_1' }),
      conversationId: CONVERSATION,
      projectSetId: SET,
      mountedBy: 'user',
    })
    // The single-project path is untouched by the new body.
    expect(mountProject).not.toHaveBeenCalled()
  })

  it('answers 200 when the conversation already read every project in the set', async () => {
    vi.mocked(mountProjectSet).mockResolvedValue({
      set: { id: SET, name: 'Bezirk 3' },
      mounts: [{ mount, grant, created: false }],
      skipped: [],
    })

    expect((await post({ projectSetId: SET })).status).toBe(200)
  })

  it('carries the skipped members through to the client', async () => {
    vi.mocked(mountProjectSet).mockResolvedValue({
      set: { id: SET, name: 'Bezirk 3' },
      mounts: [{ mount, grant, created: true }],
      skipped: [{ projectId: 'p-b', projectName: 'Nordbahnhof', reason: 'forbidden' as const }],
    })

    const body = (await (await post({ projectSetId: SET })).json()) as {
      skipped: Array<{ projectName: string }>
    }

    expect(body.skipped).toEqual([
      { projectId: 'p-b', projectName: 'Nordbahnhof', reason: 'forbidden' },
    ])
  })

  it('names the SET in the cap refusal, beside the cap and what is mounted', async () => {
    vi.mocked(mountProjectSet).mockRejectedValue(
      new WorkspaceMountCapError(5, ['Seestadt'], 'Bezirk 3')
    )

    const response = await post({ projectSetId: SET })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'WORKSPACE_MOUNT_CAP',
      cap: 5,
      mounted: ['Seestadt'],
      set: 'Bezirk 3',
    })
  })

  it('leaves `set` off the cap refusal for a single project', async () => {
    vi.mocked(mountProject).mockRejectedValue(new WorkspaceMountCapError(5, ['Seestadt']))

    const body = (await (await post({ projectId: PROJECT })).json()) as Record<string, unknown>

    expect(body).not.toHaveProperty('set')
  })

  it('refuses the whole set when it would shut a participant out (spec AC-8)', async () => {
    vi.mocked(mountProjectSet).mockRejectedValue(new WorkspaceMountExclusionError(['Anna Meier']))

    const response = await post({ projectSetId: SET })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'WORKSPACE_MOUNT_WOULD_EXCLUDE',
      excluded: ['Anna Meier'],
    })
  })

  it('answers a Sammlung the caller may not reach as if it did not exist', async () => {
    vi.mocked(mountProjectSet).mockRejectedValue(new NotFoundError())
    expect((await post({ projectSetId: SET })).status).toBe(404)
  })
})
