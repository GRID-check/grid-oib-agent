import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ role: 'project-admin' }),
}))

vi.mock('@/lib/projects/repository', () => ({
  findProjectInOrg: vi.fn(),
}))

vi.mock('@/lib/budgets/service', () => ({
  getBudgetStatus: vi.fn(),
}))

vi.mock('@/lib/model-config/service', () => ({
  getEffectiveModelOverrides: vi.fn(),
}))

vi.mock('@/lib/project-profile/prompt-view', () => ({
  loadProjectPromptView: vi.fn(),
  loadProjectBundesland: vi.fn(),
}))

vi.mock('@/lib/workos/feature-flags', () => ({
  isOrgFeatureEnabled: vi.fn(),
  WORKFLOWS_FLAG: 'workflows',
}))

vi.mock('./repository', () => ({
  insertWorkflow: vi.fn(),
  listWorkflowsInProject: vi.fn(),
  findWorkflow: vi.fn(),
  findWorkflowById: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  touchWorkflowLastRun: vi.fn(),
  insertWorkflowRun: vi.fn(),
  listWorkflowRuns: vi.fn(),
}))

// Keep the real error classes (fireWorkflow branches on instanceof) but stub
// the network call.
vi.mock('./backend-client', async (importActual) => {
  const actual = await importActual<typeof import('./backend-client')>()
  return { ...actual, submitWorkflowJob: vi.fn() }
})

import { requireProjectAccess } from '@/lib/authz/projects'
import { findProjectInOrg } from '@/lib/projects/repository'
import { getBudgetStatus } from '@/lib/budgets/service'
import { getEffectiveModelOverrides } from '@/lib/model-config/service'
import { loadProjectBundesland, loadProjectPromptView } from '@/lib/project-profile/prompt-view'
import { ConflictError, NotFoundError } from '@/lib/api/errors'
import * as repository from './repository'
import {
  submitWorkflowJob,
  WorkflowSubmitError,
  WorkflowSubmitSkippedError,
} from './backend-client'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import {
  createWorkflow,
  deleteWorkflow,
  fireScheduledWorkflow,
  fireWorkflow,
  getWorkflow,
  listWorkflows,
  runWorkflowNow,
  updateWorkflow,
} from './service'
import type { NewWorkflowRun, Workflow, WorkflowRun } from '@/lib/db/schema'
import { makeProject } from '@/test-utils/db-fixtures'
import type { AuthorizedSession } from '@/lib/auth/types'

const mockRequireProjectAccess = vi.mocked(requireProjectAccess)
const mockFindProjectInOrg = vi.mocked(findProjectInOrg)
const mockGetBudgetStatus = vi.mocked(getBudgetStatus)
const mockGetModelOverrides = vi.mocked(getEffectiveModelOverrides)
const mockLoadPromptView = vi.mocked(loadProjectPromptView)
const mockLoadBundesland = vi.mocked(loadProjectBundesland)
const mockSubmit = vi.mocked(submitWorkflowJob)
const repo = vi.mocked(repository)

const PROJECT_ID = 'proj-1'
const ORG_ID = 'org-1'

const session: AuthorizedSession = {
  userId: 'user-1',
  email: 'owner@example.com',
  name: 'Workflow Owner',
  accessToken: 'test-access-token',
  organizationId: ORG_ID,
  organizationMembershipId: 'om-1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

/**
 * The row `insertWorkflowRun` returns for a given insert: the database fills in
 * the id and created_at, and the nullable columns come back as explicit nulls
 * rather than absent keys.
 */
const insertedRun = (
  values: NewWorkflowRun,
  id: string,
  createdAt: Date = new Date(),
): WorkflowRun => ({
  ...values,
  id,
  createdAt,
  jobId: values.jobId ?? null,
  detail: values.detail ?? null,
  triggeredBy: values.triggeredBy ?? null,
})

const workflow: Workflow = {
  id: 'wf-1',
  projectId: PROJECT_ID,
  organizationId: ORG_ID,
  name: 'Weekly market scan',
  description: null,
  definition: { version: 1, blocks: { objective: 'Study X' } },
  compiledPrompt: '# Objective\n\nStudy X',
  agentType: 'deep_researcher',
  dataSources: ['web_search'],
  enabled: true,
  scheduleCron: null,
  scheduleTimezone: 'UTC',
  nextRunAt: null,
  lastRunAt: null,
  createdBy: 'creator-9',
  createdByEmail: 'creator@example.com',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireProjectAccess.mockResolvedValue({ role: 'project-admin' })
  mockFindProjectInOrg.mockResolvedValue(makeProject({ id: PROJECT_ID, organizationId: ORG_ID }))
  mockGetBudgetStatus.mockResolvedValue({
    blocked: false,
    blockedScope: null,
    remainingOrgUsd: 5,
    remainingUserUsd: null,
    remainingProjectUsd: 2,
  })
  mockGetModelOverrides.mockResolvedValue({ deep_research: 'some/model' })
  mockLoadPromptView.mockResolvedValue('Project context here')
  mockLoadBundesland.mockResolvedValue(null)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('read/authz + tenancy', () => {
  it('listWorkflows requires view access and scopes by org', async () => {
    repo.listWorkflowsInProject.mockResolvedValue([workflow])
    const result = await listWorkflows(session, PROJECT_ID)
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(session, PROJECT_ID, 'project:view')
    expect(repo.listWorkflowsInProject).toHaveBeenCalledWith(PROJECT_ID, ORG_ID)
    expect(result).toEqual([workflow])
  })

  it('getWorkflow 404s when the row is missing or belongs to another project', async () => {
    repo.findWorkflow.mockResolvedValueOnce(null)
    await expect(getWorkflow(session, PROJECT_ID, 'wf-x')).rejects.toBeInstanceOf(NotFoundError)

    repo.findWorkflow.mockResolvedValueOnce({ ...workflow, projectId: 'other-proj' })
    await expect(getWorkflow(session, PROJECT_ID, 'wf-1')).rejects.toBeInstanceOf(NotFoundError)
    expect(repo.findWorkflow).toHaveBeenLastCalledWith('wf-1', ORG_ID)
  })
})

describe('createWorkflow', () => {
  it('requires edit access, compiles the prompt, and stores creator identity', async () => {
    repo.insertWorkflow.mockImplementation(async (v) => ({ ...workflow, ...v }) as Workflow)
    await createWorkflow(session, PROJECT_ID, {
      name: 'New WF',
      definition: { version: 1, blocks: { objective: 'Do research', context: 'ctx' } },
    })
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(session, PROJECT_ID, 'project:edit')
    expect(repo.insertWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        organizationId: ORG_ID,
        name: 'New WF',
        compiledPrompt: '# Objective\n\nDo research\n\n# Background & Context\n\nctx',
        createdBy: 'user-1',
        createdByEmail: 'owner@example.com',
        nextRunAt: null,
      }),
    )
  })

  it('404s when the project is not in the caller org (tenancy via requireProjectAccess)', async () => {
    mockRequireProjectAccess.mockRejectedValueOnce(new NotFoundError())
    await expect(
      createWorkflow(session, PROJECT_ID, {
        name: 'X',
        definition: { version: 1, blocks: { objective: 'y' } },
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(repo.insertWorkflow).not.toHaveBeenCalled()
  })

  it('computes next_run_at when scheduled + enabled', async () => {
    repo.insertWorkflow.mockImplementation(async (v) => ({ ...workflow, ...v }) as Workflow)
    await createWorkflow(session, PROJECT_ID, {
      name: 'Scheduled',
      definition: { version: 1, blocks: { objective: 'y' } },
      scheduleCron: '0 9 * * 1',
      scheduleTimezone: 'UTC',
      enabled: true,
    })
    const arg = repo.insertWorkflow.mock.calls[0][0]
    expect(arg.scheduleCron).toBe('0 9 * * 1')
    expect(arg.nextRunAt).toBeInstanceOf(Date)
    expect((arg.nextRunAt as Date).getTime()).toBeGreaterThan(Date.now())
  })

  it('leaves next_run_at null for a scheduled-but-disabled workflow', async () => {
    repo.insertWorkflow.mockImplementation(async (v) => ({ ...workflow, ...v }) as Workflow)
    await createWorkflow(session, PROJECT_ID, {
      name: 'Disabled scheduled',
      definition: { version: 1, blocks: { objective: 'y' } },
      scheduleCron: '0 9 * * 1',
      enabled: false,
    })
    expect(repo.insertWorkflow.mock.calls[0][0].nextRunAt).toBeNull()
  })
})

describe('always-on knowledge_layer data source', () => {
  beforeEach(() => {
    repo.insertWorkflow.mockImplementation(async (v) => ({ ...workflow, ...v }) as Workflow)
    repo.findWorkflow.mockResolvedValue(workflow)
    repo.updateWorkflow.mockImplementation(async (_id, _org, patch) => ({ ...workflow, ...patch }) as Workflow)
  })

  it('createWorkflow prepends knowledge_layer to a user-selected list', async () => {
    await createWorkflow(session, PROJECT_ID, {
      name: 'WF',
      definition: { version: 1, blocks: { objective: 'y' } },
      dataSources: ['web_search', 'ris'],
    })
    expect(repo.insertWorkflow.mock.calls[0][0].dataSources).toEqual(['knowledge_layer', 'web_search', 'ris'])
  })

  it('createWorkflow turns an empty additional-sources list into [knowledge_layer]', async () => {
    await createWorkflow(session, PROJECT_ID, {
      name: 'WF',
      definition: { version: 1, blocks: { objective: 'y' } },
      dataSources: [],
    })
    expect(repo.insertWorkflow.mock.calls[0][0].dataSources).toEqual(['knowledge_layer'])
  })

  it('createWorkflow does not duplicate knowledge_layer when already selected', async () => {
    await createWorkflow(session, PROJECT_ID, {
      name: 'WF',
      definition: { version: 1, blocks: { objective: 'y' } },
      dataSources: ['knowledge_layer', 'web_search'],
    })
    expect(repo.insertWorkflow.mock.calls[0][0].dataSources).toEqual(['knowledge_layer', 'web_search'])
  })

  it('createWorkflow leaves null (all sources) unchanged', async () => {
    await createWorkflow(session, PROJECT_ID, {
      name: 'WF',
      definition: { version: 1, blocks: { objective: 'y' } },
      dataSources: null,
    })
    expect(repo.insertWorkflow.mock.calls[0][0].dataSources).toBeNull()
  })

  it('createWorkflow leaves an omitted dataSources as null', async () => {
    await createWorkflow(session, PROJECT_ID, {
      name: 'WF',
      definition: { version: 1, blocks: { objective: 'y' } },
    })
    expect(repo.insertWorkflow.mock.calls[0][0].dataSources).toBeNull()
  })

  it('updateWorkflow persists a knowledge_layer-included list when dataSources is patched', async () => {
    await updateWorkflow(session, PROJECT_ID, 'wf-1', { dataSources: ['ris'] })
    expect(repo.updateWorkflow.mock.calls[0][2].dataSources).toEqual(['knowledge_layer', 'ris'])
  })

  it('updateWorkflow normalizes an existing (legacy) list when dataSources is not patched', async () => {
    // existing.dataSources is ['web_search'] (pre-change legacy row) — a patch
    // that does not touch dataSources still re-normalizes it on save.
    await updateWorkflow(session, PROJECT_ID, 'wf-1', { name: 'renamed' })
    expect(repo.updateWorkflow.mock.calls[0][2].dataSources).toEqual(['knowledge_layer', 'web_search'])
  })

  it('updateWorkflow keeps null (all sources) when patched to null', async () => {
    await updateWorkflow(session, PROJECT_ID, 'wf-1', { dataSources: null })
    expect(repo.updateWorkflow.mock.calls[0][2].dataSources).toBeNull()
  })

  it('fireWorkflow includes knowledge_layer for a legacy row whose stored array lacks it', async () => {
    mockSubmit.mockResolvedValue({ job_id: 'job-legacy' })
    repo.insertWorkflowRun.mockImplementation(async (v) => insertedRun(v, 'run-l'))

    const legacyRow = { ...workflow, dataSources: ['web_search'] }
    await fireWorkflow(legacyRow, 'schedule', 'scheduler')

    expect(mockSubmit.mock.calls[0][0].data_sources).toEqual(['knowledge_layer', 'web_search'])
  })

  it('fireWorkflow keeps null (all sources) for a row with null dataSources', async () => {
    mockSubmit.mockResolvedValue({ job_id: 'job-null' })
    repo.insertWorkflowRun.mockImplementation(async (v) => insertedRun(v, 'run-n'))

    const nullRow = { ...workflow, dataSources: null }
    await fireWorkflow(nullRow, 'schedule', 'scheduler')

    expect(mockSubmit.mock.calls[0][0].data_sources).toBeNull()
  })
})

describe('updateWorkflow', () => {
  it('recompiles the prompt and recomputes next_run_at', async () => {
    repo.findWorkflow.mockResolvedValue(workflow)
    repo.updateWorkflow.mockImplementation(async (_id, _org, patch) => ({ ...workflow, ...patch }) as Workflow)
    await updateWorkflow(session, PROJECT_ID, 'wf-1', {
      definition: { version: 1, blocks: { objective: 'Updated objective' } },
      scheduleCron: '0 * * * *',
    })
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(session, PROJECT_ID, 'project:edit')
    const patch = repo.updateWorkflow.mock.calls[0][2]
    expect(patch.compiledPrompt).toBe('# Objective\n\nUpdated objective')
    expect(patch.nextRunAt).toBeInstanceOf(Date)
    expect(repo.updateWorkflow).toHaveBeenCalledWith('wf-1', ORG_ID, expect.anything())
  })
})

describe('deleteWorkflow', () => {
  it('requires edit access and 404s on a cross-project id', async () => {
    repo.findWorkflow.mockResolvedValueOnce({ ...workflow, projectId: 'other' })
    await expect(deleteWorkflow(session, PROJECT_ID, 'wf-1')).rejects.toBeInstanceOf(NotFoundError)
    expect(repo.deleteWorkflow).not.toHaveBeenCalled()
  })
})

describe('runWorkflowNow', () => {
  it('rejects a disabled workflow with 409', async () => {
    repo.findWorkflow.mockResolvedValue({ ...workflow, enabled: false })
    await expect(runWorkflowNow(session, PROJECT_ID, 'wf-1')).rejects.toBeInstanceOf(ConflictError)
    expect(mockSubmit).not.toHaveBeenCalled()
  })
})

describe('fireWorkflow (single submission path)', () => {
  it('submits with owner identity + budget/model/collection context and records a submitted run', async () => {
    mockSubmit.mockResolvedValue({ job_id: 'job-123' })
    repo.insertWorkflowRun.mockImplementation(
      async (v) => insertedRun(v, 'run-1', new Date('2026-07-16T10:00:00Z')),
    )

    const run = await fireWorkflow(workflow, 'schedule', 'scheduler')

    // Budget + collection scope built from the workflow row's OWN org.
    expect(mockGetBudgetStatus).toHaveBeenCalledWith(ORG_ID, 'creator-9', PROJECT_ID)
    const payload = mockSubmit.mock.calls[0][0]
    expect(payload).toMatchObject({
      agent_type: 'deep_researcher',
      input: '# Objective\n\nStudy X',
      organization_id: ORG_ID,
      user_id: 'creator-9', // workflow creator, not the actor
      project_id: PROJECT_ID,
      owner_email: 'creator@example.com',
      // knowledge_layer is always prepended, even for this stored ['web_search'] row.
      data_sources: ['knowledge_layer', 'web_search'],
      model_overrides: { deep_research: 'some/model' },
      project_context: 'Project context here',
    })
    // Budget header is the base64url budget snapshot the interactive path sends.
    expect(JSON.parse(Buffer.from(payload.budget_header as string, 'base64url').toString())).toEqual({
      remainingOrgUsd: 5,
      remainingUserUsd: null,
      remainingProjectUsd: 2,
    })
    // Collection scope includes the project's real collection name.
    expect(payload.collection_scope).toContain('proj_abc')

    // Signed context envelope (backlog T3-9 follow-up, 2026-07-16): dual-write
    // alongside the payload, built from the same org/user/project/budget/
    // overrides/scope values.
    const contextHeaders = mockSubmit.mock.calls[0][1] as Record<string, string>
    expect(contextHeaders['X-Grid-Request-Context']).toBeDefined()
    const decodedEnvelope = JSON.parse(Buffer.from(contextHeaders['X-Grid-Request-Context'], 'base64url').toString())
    expect(decodedEnvelope).toMatchObject({
      organizationId: ORG_ID,
      userId: 'creator-9',
      projectId: PROJECT_ID,
      modelOverrides: { deep_research: 'some/model' },
      budget: { remainingOrgUsd: 5, remainingUserUsd: null, remainingProjectUsd: 2 },
    })
    expect(decodedEnvelope.collectionScope).toContain('proj_abc')
    // No GRID_INTERNAL_API_TOKEN stubbed in this test -> envelope is unsigned.
    expect(contextHeaders['X-Grid-Request-Context-Sig']).toBeUndefined()

    expect(repo.insertWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf-1',
        organizationId: ORG_ID,
        status: 'submitted',
        jobId: 'job-123',
        trigger: 'schedule',
        triggeredBy: 'scheduler',
        promptSnapshot: '# Objective\n\nStudy X',
      }),
    )
    expect(repo.touchWorkflowLastRun).toHaveBeenCalledWith('wf-1', run.createdAt)
    expect(run.status).toBe('submitted')
  })

  it('carries the resolved bundesland fact structurally on the envelope (backlog T3-9 follow-up, 2026-07-16)', async () => {
    mockLoadBundesland.mockResolvedValue('tirol')
    mockSubmit.mockResolvedValue({ job_id: 'job-bundesland' })
    repo.insertWorkflowRun.mockImplementation(
      async (v) => insertedRun(v, 'run-bundesland'),
    )

    await fireWorkflow(workflow, 'schedule', 'scheduler')

    expect(mockLoadBundesland).toHaveBeenCalledWith(PROJECT_ID)
    const contextHeaders = mockSubmit.mock.calls[0][1] as Record<string, string>
    const decodedEnvelope = JSON.parse(Buffer.from(contextHeaders['X-Grid-Request-Context'], 'base64url').toString())
    expect(decodedEnvelope.bundesland).toBe('tirol')
  })

  it('omits bundesland from the envelope cleanly when the project has no valid fact', async () => {
    mockLoadBundesland.mockResolvedValue(null)
    mockSubmit.mockResolvedValue({ job_id: 'job-no-bundesland' })
    repo.insertWorkflowRun.mockImplementation(
      async (v) => insertedRun(v, 'run-no-bundesland'),
    )

    await fireWorkflow(workflow, 'schedule', 'scheduler')

    const contextHeaders = mockSubmit.mock.calls[0][1] as Record<string, string>
    const decodedEnvelope = JSON.parse(Buffer.from(contextHeaders['X-Grid-Request-Context'], 'base64url').toString())
    expect(decodedEnvelope.bundesland).toBeUndefined()
  })

  it('signs the context envelope when GRID_INTERNAL_API_TOKEN is configured', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'test-secret')
    mockSubmit.mockResolvedValue({ job_id: 'job-signed' })
    repo.insertWorkflowRun.mockImplementation(async (v) => insertedRun(v, 'run-signed'))

    await fireWorkflow(workflow, 'schedule', 'scheduler')

    const contextHeaders = mockSubmit.mock.calls[0][1] as Record<string, string>
    expect(contextHeaders['X-Grid-Request-Context-Sig']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records a 429 as a skipped run WITHOUT throwing', async () => {
    mockSubmit.mockRejectedValue(new WorkflowSubmitSkippedError('org cap reached', 120))
    repo.insertWorkflowRun.mockImplementation(async (v) => insertedRun(v, 'run-2'))

    const run = await fireWorkflow(workflow, 'manual', 'user-1')

    expect(run.status).toBe('skipped')
    const inserted = repo.insertWorkflowRun.mock.calls[0][0]
    expect(inserted.status).toBe('skipped')
    expect(inserted.jobId).toBeNull()
    expect(inserted.detail).toContain('org cap reached')
    expect(inserted.detail).toContain('120')
    expect(repo.touchWorkflowLastRun).toHaveBeenCalled()
  })

  it('records other backend failures as an error run', async () => {
    mockSubmit.mockRejectedValue(new WorkflowSubmitError('boom', 500))
    repo.insertWorkflowRun.mockImplementation(async (v) => insertedRun(v, 'run-3'))

    const run = await fireWorkflow(workflow, 'schedule', 'scheduler')

    expect(run.status).toBe('error')
    expect(repo.insertWorkflowRun.mock.calls[0][0].detail).toBe('boom')
  })

  it('records a context-build failure as an error run instead of throwing (occurrence already consumed)', async () => {
    // buildProjectCollectionScope's project lookup throwing must not escape:
    // the schedule already advanced past this occurrence, so an unrecorded
    // throw would lose it without a trace.
    mockFindProjectInOrg.mockRejectedValueOnce(new Error('db timeout'))
    repo.insertWorkflowRun.mockImplementation(async (v) => insertedRun(v, 'run-4'))

    const run = await fireWorkflow(workflow, 'schedule', 'scheduler')

    expect(run.status).toBe('error')
    expect(repo.insertWorkflowRun.mock.calls[0][0].detail).toBe('db timeout')
    expect(mockSubmit).not.toHaveBeenCalled()
  })
})

describe('fireScheduledWorkflow (scheduler wrapper)', () => {
  const mockOrgFlag = vi.mocked(isOrgFeatureEnabled)

  it('skips a disabled workflow without touching run history', async () => {
    const result = await fireScheduledWorkflow({ ...workflow, enabled: false })
    expect(result).toEqual({ fired: false, reason: 'disabled' })
    expect(mockSubmit).not.toHaveBeenCalled()
    expect(repo.insertWorkflowRun).not.toHaveBeenCalled()
  })

  it('fires when enforcement is off and GRID_WORKFLOWS_ENABLED=true (env gate)', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'false')
    vi.stubEnv('GRID_WORKFLOWS_ENABLED', 'true')
    mockSubmit.mockResolvedValue({ job_id: 'job-9' })
    repo.insertWorkflowRun.mockImplementation(async (v) => insertedRun(v, 'run-9'))

    const result = await fireScheduledWorkflow(workflow)

    expect(result.fired).toBe(true)
    expect(mockOrgFlag).not.toHaveBeenCalled() // env gate, no WorkOS lookup
    expect(mockSubmit).toHaveBeenCalled()
  })

  it('records a skipped run when the deployment gate is off (enforcement off, env unset)', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'false')
    vi.stubEnv('GRID_WORKFLOWS_ENABLED', 'false')
    repo.insertWorkflowRun.mockImplementation(async (v) => insertedRun(v, 'run-10'))

    const result = await fireScheduledWorkflow(workflow)

    expect(result.fired).toBe(false)
    expect(result).toMatchObject({ reason: 'feature-disabled' })
    expect(mockSubmit).not.toHaveBeenCalled()
    const inserted = repo.insertWorkflowRun.mock.calls[0][0]
    expect(inserted.status).toBe('skipped')
    expect(inserted.detail).toContain('disabled for this organization')
  })

  it('evaluates the per-org WorkOS flag under enforcement and fires when enabled', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    mockOrgFlag.mockResolvedValue(true)
    mockSubmit.mockResolvedValue({ job_id: 'job-11' })
    repo.insertWorkflowRun.mockImplementation(async (v) => insertedRun(v, 'run-11'))

    const result = await fireScheduledWorkflow(workflow)

    expect(mockOrgFlag).toHaveBeenCalledWith('workflows', ORG_ID, false)
    expect(result.fired).toBe(true)
  })

  it('records a skipped run when the org flag is revoked under enforcement (fail-closed)', async () => {
    vi.stubEnv('GRID_ENFORCE_FEATURE_FLAGS', 'true')
    mockOrgFlag.mockResolvedValue(false)
    repo.insertWorkflowRun.mockImplementation(async (v) => insertedRun(v, 'run-12'))

    const result = await fireScheduledWorkflow(workflow)

    expect(result.fired).toBe(false)
    expect(result).toMatchObject({ reason: 'feature-disabled' })
    expect(mockSubmit).not.toHaveBeenCalled()
    expect(repo.insertWorkflowRun.mock.calls[0][0].status).toBe('skipped')
  })
})
