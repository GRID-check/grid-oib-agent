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

// The delegated arm: a task created from a chat handoff has no `job_runs` row,
// so the route falls through to the task lookup (see the route's own comment).
vi.mock('@/lib/tasks/service', () => ({
  loadTaskForOutcome: vi.fn(),
  recordTaskOutcome: vi.fn(),
}))

import type { JobRun, Task } from '@/lib/db/schema'
import { loadJobRunForOutcome, recordJobOutcome } from '@/lib/jobs/service'
import { loadTaskForOutcome, recordTaskOutcome } from '@/lib/tasks/service'
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

/** A delegated task: no job, no run, its own backend job id. */
const task = {
  id: 'task-1',
  organizationId: 'org-1',
  projectId: 'proj-1',
  kind: 'einreichcheck',
  title: 'Einreichcheck: Haus A',
  requesterUserId: 'user-1',
  backendJobId: BACKEND_JOB_ID,
  conversationId: 's_conv_2',
} as unknown as Task

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
    vi.mocked(recordJobOutcome).mockResolvedValue({ notified: true, filed: null })

    const response = await POST(
      makeRequest({ organizationId: 'org-1', status: 'failure', error: 'Budget exhausted' }, REAL_TOKEN),
      routeContext
    )

    expect(response.status).toBe(200)
    expect(loadJobRunForOutcome).toHaveBeenCalledWith(BACKEND_JOB_ID)
    expect(recordJobOutcome).toHaveBeenCalledWith(run, {
      status: 'failure',
      error: 'Budget exhausted',
      report: null,
      cards: null,
    })
    expect(await response.json()).toEqual({ notified: true, filed: null })
  })

  it('is a 404 for a backend id the BFF has neither a run nor a task for', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(loadJobRunForOutcome).mockResolvedValue(null)
    vi.mocked(loadTaskForOutcome).mockResolvedValue(null)

    const response = await POST(makeRequest({ organizationId: 'org-1', status: 'success' }, REAL_TOKEN), routeContext)

    // The ordinary case, not an error: an interactive deep-research job has
    // neither row, and the worker reads 404 as "nothing to notify".
    expect(response.status).toBe(404)
    expect(recordJobOutcome).not.toHaveBeenCalled()
    expect(recordTaskOutcome).not.toHaveBeenCalled()
  })

  it('closes a DELEGATED task when the backend id names no run', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(loadJobRunForOutcome).mockResolvedValue(null)
    vi.mocked(loadTaskForOutcome).mockResolvedValue(task)
    vi.mocked(recordTaskOutcome).mockResolvedValue({ notified: true, filed: null })

    const response = await POST(
      makeRequest({ organizationId: 'org-1', status: 'success', report: '# Ergebnis' }, REAL_TOKEN),
      routeContext
    )

    expect(response.status).toBe(200)
    expect(loadTaskForOutcome).toHaveBeenCalledWith(BACKEND_JOB_ID)
    expect(recordTaskOutcome).toHaveBeenCalledWith(task, {
      status: 'success',
      error: null,
      report: '# Ergebnis',
      cards: null,
    })
    // The job arm never ran: one backend id belongs to one of the two.
    expect(recordJobOutcome).not.toHaveBeenCalled()
  })

  it('refuses a task whose tenant disagrees with the caller, as a 404', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(loadJobRunForOutcome).mockResolvedValue(null)
    vi.mocked(loadTaskForOutcome).mockResolvedValue(task)

    const response = await POST(makeRequest({ organizationId: 'org-2', status: 'success' }, REAL_TOKEN), routeContext)

    expect(response.status).toBe(404)
    expect(recordTaskOutcome).not.toHaveBeenCalled()
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
