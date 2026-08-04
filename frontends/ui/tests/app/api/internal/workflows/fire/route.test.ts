import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory statically imports the session guard (authkit); internal
// routes never call it, but the import must resolve.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/workflows/service', () => ({
  loadWorkflowForFire: vi.fn(),
  fireScheduledWorkflow: vi.fn(),
}))

import { POST } from '@/app/api/internal/workflows/fire/route'
import { loadWorkflowForFire, fireScheduledWorkflow } from '@/lib/workflows/service'
import type { Workflow, WorkflowRun } from '@/lib/db/schema/workflows'

const mockLoad = vi.mocked(loadWorkflowForFire)

/**
 * These tests exercise the ROUTE, not the workflow row: the handler reads only
 * `id` and `enabled`, so the fixtures state those two fields. `as unknown as`
 * confines the widening to this one named boundary rather than switching off
 * checking at each call site with `any`.
 */
const asWorkflow = (row: Pick<Workflow, 'id' | 'enabled'>): Workflow => row as unknown as Workflow
const asRun = (row: { id: string; status: string }): WorkflowRun => row as unknown as WorkflowRun
const mockFire = vi.mocked(fireScheduledWorkflow)

const REAL_TOKEN = 'a-real-secret-token'
const WORKFLOW_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'

function makeRequest(body: unknown, token?: string): Request {
  return new Request('https://grid.test/api/internal/workflows/fire', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-grid-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/internal/workflows/fire', () => {
  it('returns 503 when the internal token is unconfigured', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    const res = await POST(makeRequest({ workflowId: WORKFLOW_ID }, REAL_TOKEN))
    expect(res.status).toBe(503)
    expect(mockFire).not.toHaveBeenCalled()
  })

  it('returns 403 without the token header', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const res = await POST(makeRequest({ workflowId: WORKFLOW_ID }))
    expect(res.status).toBe(403)
    expect(mockLoad).not.toHaveBeenCalled()
  })

  it('returns 403 for a wrong token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const res = await POST(makeRequest({ workflowId: WORKFLOW_ID }, 'wrong'))
    expect(res.status).toBe(403)
  })

  it('404s an unknown workflow', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    mockLoad.mockResolvedValue(null)
    const res = await POST(makeRequest({ workflowId: WORKFLOW_ID }, REAL_TOKEN))
    expect(res.status).toBe(404)
  })

  it('relays a not-fired result (disabled race guard)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    mockLoad.mockResolvedValue(asWorkflow({ id: WORKFLOW_ID, enabled: false }))
    mockFire.mockResolvedValue({ fired: false, reason: 'disabled' })
    const res = await POST(makeRequest({ workflowId: WORKFLOW_ID }, REAL_TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ fired: false, reason: 'disabled' })
    expect(mockFire).toHaveBeenCalledWith({ id: WORKFLOW_ID, enabled: false })
  })

  it('fires an enabled workflow through the scheduled-fire wrapper', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    mockLoad.mockResolvedValue(asWorkflow({ id: WORKFLOW_ID, enabled: true }))
    mockFire.mockResolvedValue({ fired: true, run: asRun({ id: 'run-1', status: 'submitted' }) })
    const res = await POST(makeRequest({ workflowId: WORKFLOW_ID }, REAL_TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ fired: true, run: { id: 'run-1', status: 'submitted' } })
    expect(mockFire).toHaveBeenCalledWith({ id: WORKFLOW_ID, enabled: true })
  })

  it('400s an invalid body (missing workflowId)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const res = await POST(makeRequest({}, REAL_TOKEN))
    expect(res.status).toBe(400)
  })
})
