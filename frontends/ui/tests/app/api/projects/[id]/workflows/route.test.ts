import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/workflows/service', () => ({
  listWorkflows: vi.fn(),
  createWorkflow: vi.fn(),
}))

import { GET, POST } from '@/app/api/projects/[id]/workflows/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { listWorkflows, createWorkflow } from '@/lib/workflows/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Workflow } from '@/lib/db/schema/workflows'

const mockSession = vi.mocked(requireAuthorizedSession)
const mockList = vi.mocked(listWorkflows)
const mockCreate = vi.mocked(createWorkflow)

/**
 * These tests exercise the ROUTE, not the row/session shapes: the handler
 * passes the session straight through and reads only `id` off a workflow. The
 * two helpers below confine the widening to one named boundary each, instead
 * of switching off checking per call site with `any`.
 */
const asWorkflow = (row: Pick<Workflow, 'id'>): Workflow => row as unknown as Workflow
const asAuthorizedSession = (fixture: Omit<AuthorizedSession, 'featureFlags'> & { featureFlags: null }): AuthorizedSession =>
  fixture as unknown as AuthorizedSession

const session = {
  userId: 'user_1',
  email: 'user@example.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [] as string[],
  featureFlags: null,
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

const validBody = {
  name: 'Weekly scan',
  definition: { version: 1, blocks: { objective: 'Research the market' } },
}

function req(body?: unknown): Request {
  return new Request('http://localhost/api/projects/proj_1/workflows', {
    method: body ? 'POST' : 'GET',
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSession.mockResolvedValue(asAuthorizedSession(session))
})

afterEach(() => {
  delete process.env.GRID_WORKFLOWS_ENABLED
  delete process.env.GRID_ENFORCE_FEATURE_FLAGS
})

describe('GET /api/projects/[id]/workflows', () => {
  it('returns 403 feature-disabled when the workflows gate is off (default)', async () => {
    const res = await GET(req(), makeParams('proj_1'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'feature-disabled', feature: 'workflows' })
    expect(mockList).not.toHaveBeenCalled()
  })

  it('lists workflows when the env gate is on', async () => {
    process.env.GRID_WORKFLOWS_ENABLED = 'true'
    mockList.mockResolvedValue([asWorkflow({ id: 'wf-1' })])
    const res = await GET(req(), makeParams('proj_1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ workflows: [{ id: 'wf-1' }] })
    expect(mockList).toHaveBeenCalledWith(session, 'proj_1')
  })
})

describe('POST /api/projects/[id]/workflows', () => {
  it('returns 403 feature-disabled when off, before validating the body', async () => {
    const res = await POST(req(validBody), makeParams('proj_1'))
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns 400 on an invalid body when the gate is on', async () => {
    process.env.GRID_WORKFLOWS_ENABLED = 'true'
    const res = await POST(req({ description: 'no name or definition' }), makeParams('proj_1'))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates a workflow (201) on a valid body', async () => {
    process.env.GRID_WORKFLOWS_ENABLED = 'true'
    mockCreate.mockResolvedValue(asWorkflow({ id: 'wf-new' }))
    const res = await POST(req(validBody), makeParams('proj_1'))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: 'wf-new' })
    expect(mockCreate).toHaveBeenCalledWith(session, 'proj_1', expect.objectContaining({ name: 'Weekly scan' }))
  })
})
