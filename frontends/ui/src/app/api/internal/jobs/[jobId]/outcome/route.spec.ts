/**
 * @vitest-environment node
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

vi.mock('@/lib/jobs/service', () => ({
  loadJobRunForOutcome: vi.fn(),
  recordJobOutcome: vi.fn(),
}))

import type { JobRun } from '@/lib/db/schema'
import { loadJobRunForOutcome, recordJobOutcome } from '@/lib/jobs/service'
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
  scheduleId: 'job-1',
  projectId: 'proj-1',
  organizationId: 'org-1',
  jobId: BACKEND_JOB_ID,
  trigger: 'schedule',
  status: 'submitted',
  detail: null,
  conversationId: null,
  skillSnapshot: {},
  triggeredBy: 'scheduler',
  createdAt: new Date('2026-09-01T03:00:00Z'),
} as unknown as JobRun

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
    expect(loadJobRunForOutcome).not.toHaveBeenCalled()
  })

  it('records the outcome for the run the backend id names', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(loadJobRunForOutcome).mockResolvedValue(run)
    vi.mocked(recordJobOutcome).mockResolvedValue({ notified: true })

    const response = await POST(
      makeRequest({ organizationId: 'org-1', status: 'failure', error: 'Budget exhausted' }, REAL_TOKEN),
      routeContext
    )

    expect(response.status).toBe(200)
    expect(loadJobRunForOutcome).toHaveBeenCalledWith(BACKEND_JOB_ID)
    expect(recordJobOutcome).toHaveBeenCalledWith(run, { status: 'failure', error: 'Budget exhausted' })
    expect(await response.json()).toEqual({ notified: true })
  })

  it('is a 404 for a backend id the BFF has no run for', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(loadJobRunForOutcome).mockResolvedValue(null)

    const response = await POST(makeRequest({ organizationId: 'org-1', status: 'success' }, REAL_TOKEN), routeContext)

    expect(response.status).toBe(404)
    expect(recordJobOutcome).not.toHaveBeenCalled()
  })

  it('refuses a run whose tenant disagrees with the caller, as a 404', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(loadJobRunForOutcome).mockResolvedValue(run)

    const response = await POST(makeRequest({ organizationId: 'org-2', status: 'success' }, REAL_TOKEN), routeContext)

    expect(response.status).toBe(404)
    expect(recordJobOutcome).not.toHaveBeenCalled()
  })

  it('rejects an unknown status', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await POST(makeRequest({ organizationId: 'org-1', status: 'done' }, REAL_TOKEN), routeContext)

    expect(response.status).toBe(400)
  })
})
