/**
 * @vitest-environment node
 */
/**
 * The outcome webhook, ONE lookup and ONE recorder over `task_runs`: the
 * backend job id belongs to exactly one row now, so there is no first-table
 * then second-table fallback to test — only the tenant cross-check and the
 * platform-scope-then-tenant shape the run is resolved through.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/db/tenant-context', () => ({
  // The route factory opens a tenant slot around every handler; the two
  // scope helpers the handler itself calls are pass-through here.
  runWithTenantSlot: vi.fn((fn: () => unknown) => fn()),
  withPlatformAccess: vi.fn((_reason: string, fn: () => unknown) => fn()),
  withTenant: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}))

vi.mock('@/lib/tasks/service', () => ({
  loadRunForOutcome: vi.fn(),
  recordRunOutcome: vi.fn(),
}))

import type { TaskRun } from '@/lib/db/schema'
import { loadRunForOutcome, recordRunOutcome } from '@/lib/tasks/service'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { POST } from './route'

const REAL_TOKEN = 'a-real-secret-token'
const BACKEND_JOB_ID = 'backend-job-1'

const makeRequest = (body: unknown, token?: string) =>
  new Request(`https://grid.test/api/internal/jobs/${BACKEND_JOB_ID}/outcome`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-grid-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  })

const routeContext = { params: Promise.resolve({ jobId: BACKEND_JOB_ID }) }

const run = {
  id: 'run-1',
  definitionId: 'job-1',
  projectId: 'proj-1',
  organizationId: 'org-1',
  kind: 'einreichcheck',
  title: 'Einreichcheck: Haus A',
  requesterUserId: 'user-1',
  backendJobId: BACKEND_JOB_ID,
  conversationId: 's_conv_2',
  status: 'running',
} as unknown as TaskRun

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/jobs/[jobId]/outcome', () => {
  it('rejects a missing or wrong token before touching anything', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const body = { organizationId: 'org-1', status: 'success' }

    expect((await POST(makeRequest(body), routeContext)).status).toBe(403)
    expect((await POST(makeRequest(body, 'wrong'), routeContext)).status).toBe(403)
    expect(loadRunForOutcome).not.toHaveBeenCalled()
  })

  it('records the outcome for the run the backend id names', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(loadRunForOutcome).mockResolvedValue(run)
    vi.mocked(recordRunOutcome).mockResolvedValue({ notified: true, filed: null })

    const response = await POST(
      makeRequest({ organizationId: 'org-1', status: 'failure', error: 'Budget exhausted' }, REAL_TOKEN),
      routeContext
    )

    expect(response.status).toBe(200)
    // The lookup genuinely has no tenant yet, so it is the narrow bypass; the
    // recorder then runs inside the run's own tenant.
    expect(withPlatformAccess).toHaveBeenCalled()
    expect(loadRunForOutcome).toHaveBeenCalledWith(BACKEND_JOB_ID)
    expect(recordRunOutcome).toHaveBeenCalledWith(run, {
      status: 'failure',
      error: 'Budget exhausted',
      report: null,
      cards: null,
    })
    expect(await response.json()).toEqual({ notified: true, filed: null })
  })

  it('is a 404 for a backend id the BFF has no run for', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(loadRunForOutcome).mockResolvedValue(null)

    const response = await POST(makeRequest({ organizationId: 'org-1', status: 'success' }, REAL_TOKEN), routeContext)

    // The ordinary case, not an error: an interactive deep-research job has no
    // row, and the worker reads 404 as "nothing to notify".
    expect(response.status).toBe(404)
    expect(recordRunOutcome).not.toHaveBeenCalled()
  })

  it('refuses a run whose tenant disagrees with the caller, as a 404', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(loadRunForOutcome).mockResolvedValue(run)

    const response = await POST(makeRequest({ organizationId: 'org-2', status: 'success' }, REAL_TOKEN), routeContext)

    expect(response.status).toBe(404)
    expect(recordRunOutcome).not.toHaveBeenCalled()
  })

  it('rejects an unknown status', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await POST(makeRequest({ organizationId: 'org-1', status: 'done' }, REAL_TOKEN), routeContext)

    expect(response.status).toBe(400)
  })

  it('carries the report through for the filing arm', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(loadRunForOutcome).mockResolvedValue(run)
    vi.mocked(recordRunOutcome).mockResolvedValue({ notified: true, filed: { documentId: 'doc-1', filename: 'a.pdf' } })

    const response = await POST(
      makeRequest({ organizationId: 'org-1', status: 'success', report: '# Ergebnis' }, REAL_TOKEN),
      routeContext
    )

    expect(response.status).toBe(200)
    expect(recordRunOutcome).toHaveBeenCalledWith(
      run,
      expect.objectContaining({ status: 'success', report: '# Ergebnis' })
    )
  })
})
