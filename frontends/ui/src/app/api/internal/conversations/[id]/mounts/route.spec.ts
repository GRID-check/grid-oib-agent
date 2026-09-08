/**
 * @vitest-environment node
 */
/**
 * The agent's half of the mounts endpoint (ADR-0054, spec MT-2, MT-3, MT-12).
 *
 * The claim under test is the one that makes `open_project` safe: the service
 * token proves the CALLER is the backend and says nothing about the person whose
 * turn is running, so the identity comes from the request and every check runs
 * against that reconstructed caller. A twin that mounted on the service's own
 * authority would make "open project X" a read for anyone who can get that
 * sentence into a prompt.
 *
 * The permission, the cap and the grant are the service's, asserted in
 * `mounts-service.spec.ts`. What is asserted here is that this adapter reaches
 * the SAME service with the SAME arguments as the session route, and that it
 * refuses to guess an identity it was not given.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

// The route factory statically imports the session guard, which pulls in
// authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))

// The tenant scopes are pass-throughs: what this suite claims is about WHICH
// call the route makes, and the scopes themselves are covered by
// `tenant-context.spec.ts` and the isolation suite.
vi.mock('@/lib/db/tenant-context', () => ({
  runWithTenantSlot: vi.fn(async (fn: () => unknown) => fn()),
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => unknown) => fn()),
  withTenant: vi.fn(async (_scope: unknown, fn: () => unknown) => fn()),
}))

vi.mock('@/lib/workspace/mounts-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace/mounts-service')>()
  return { ...actual, mountProject: vi.fn(), sessionForInternalMount: vi.fn() }
})

import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { withTenant } from '@/lib/db/tenant-context'
import {
  mountProject,
  sessionForInternalMount,
  WorkspaceMountCapError,
} from '@/lib/workspace/mounts-service'
import { POST } from './route'

const REAL_TOKEN = 'a-real-secret-token'
const CONVERSATION = 'conv_buero'
const PROJECT = '11111111-1111-1111-1111-111111111111'
const ORG = 'org_1'

const identity = {
  organizationId: ORG,
  userId: 'user_1',
  organizationMembershipId: 'om_1',
}

const validBody = { projectId: PROJECT, ...identity, mountedBy: 'agent' }

const routeContext = { params: Promise.resolve({ id: CONVERSATION }) }

const makeRequest = (body: unknown, token?: string) =>
  new Request(`https://grid.test/api/internal/conversations/${CONVERSATION}/mounts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-grid-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  })

const mount = {
  projectId: PROJECT,
  projectName: 'Seestadt',
  mountedBy: 'agent' as const,
  mountedAt: '2026-09-08T10:00:00.000Z',
}
const grant = { grant: 'eyJ2IjoxfQ', sig: 'abc123' }

const reconstructed = { userId: 'user_1', organizationId: ORG } as AuthorizedSession

beforeEach(() => {
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
  vi.mocked(sessionForInternalMount).mockResolvedValue(reconstructed)
  vi.mocked(mountProject).mockResolvedValue({ mount, grant, created: true })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/conversations/:id/mounts — the token guard', () => {
  it('is 503 with no token configured and 403 with the wrong one, and mounts nothing either way', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    expect((await POST(makeRequest(validBody, REAL_TOKEN), routeContext)).status).toBe(503)

    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    expect((await POST(makeRequest(validBody, 'nope'), routeContext)).status).toBe(403)
    expect((await POST(makeRequest(validBody), routeContext)).status).toBe(403)

    expect(mountProject).not.toHaveBeenCalled()
  })
})

describe('POST /api/internal/conversations/:id/mounts — as the USER (MT-3)', () => {
  it('reconstructs the caller from the envelope identity and mounts as them', async () => {
    const response = await POST(makeRequest(validBody, REAL_TOKEN), routeContext)

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ mount, grant })
    // The tenant is entered from the BODY, so nothing here can read across the
    // boundary before the organization is known.
    expect(withTenant).toHaveBeenCalledWith(
      { organizationId: ORG, userId: 'user_1' },
      expect.any(Function)
    )
    expect(sessionForInternalMount).toHaveBeenCalledWith(identity)
    expect(mountProject).toHaveBeenCalledWith({
      session: reconstructed,
      conversationId: CONVERSATION,
      projectId: PROJECT,
      mountedBy: 'agent',
    })
  })

  it('refuses rather than widens when the identity is incomplete', async () => {
    // The membership id is the load-bearing field: WorkOS FGA keys on it, so
    // without it there is no per-project decision to make. Same for the user and
    // the organization — a mount with nobody to authorize is not a mount.
    for (const missing of ['organizationMembershipId', 'userId', 'organizationId'] as const) {
      const body: Record<string, unknown> = { ...validBody }
      delete body[missing]
      expect(
        (await POST(makeRequest(body, REAL_TOKEN), routeContext)).status,
        `missing ${missing}`
      ).toBe(400)
    }
    expect(mountProject).not.toHaveBeenCalled()
  })

  it('refuses a caller claiming the mount was made by a person', async () => {
    // Only the agent reaches this route, and `mounted_by` is what tells a reader
    // who widened the conversation's scope. A caller that could claim `user`
    // here could attribute its own mount to somebody (MT-5, MT-12).
    const response = await POST(
      makeRequest({ ...validBody, mountedBy: 'user' }, REAL_TOKEN),
      routeContext
    )

    expect(response.status).toBe(400)
    expect(mountProject).not.toHaveBeenCalled()
  })

  it('answers the idempotent re-mount 200 and the cap 409, exactly as the session route does', async () => {
    vi.mocked(mountProject).mockResolvedValue({ mount, grant, created: false })
    expect((await POST(makeRequest(validBody, REAL_TOKEN), routeContext)).status).toBe(200)

    vi.mocked(mountProject).mockRejectedValue(new WorkspaceMountCapError(5, ['Seestadt']))
    const capped = await POST(makeRequest(validBody, REAL_TOKEN), routeContext)
    expect(capped.status).toBe(409)
    expect(await capped.json()).toMatchObject({
      code: 'WORKSPACE_MOUNT_CAP',
      cap: 5,
      mounted: ['Seestadt'],
    })
  })

  it('answers a project this user may not reach as if it did not exist (MT-4)', async () => {
    // The agent must not be able to learn that a project it may not read exists,
    // so the refusal it gets is the absence answer.
    vi.mocked(mountProject).mockRejectedValue(new NotFoundError())

    expect((await POST(makeRequest(validBody, REAL_TOKEN), routeContext)).status).toBe(404)
  })
})
