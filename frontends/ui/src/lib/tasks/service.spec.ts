/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  insertTask: vi.fn(),
  findTaskByBackendJobId: vi.fn(),
  findTaskInProject: vi.fn(),
  listTasksInProject: vi.fn(),
  updateTask: vi.fn(),
  listRejectedReviewsForJob: vi.fn(),
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/documents/research-report', () => ({ fileResearchReport: vi.fn() }))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Job, JobRun, Task } from '@/lib/db/schema'
import { fileResearchReport } from '@/lib/documents/research-report'
import * as repository from './repository'
import {
  completeTaskForRun,
  createTaskForRun,
  PREVIOUS_DECISIONS_HEADER,
  previousDecisionsBlock,
  reviewTask,
} from './service'

const job = {
  id: 'job-1',
  organizationId: 'org_1',
  projectId: 'proj-1',
  name: 'Wochenbericht Brandschutz',
  prompt: 'Prüfe …',
  output: 'deep-research',
  createdBy: 'user_owner',
  createdByEmail: 'owner@grid.test',
  dataSources: ['knowledge_layer'],
  skillSnapshot: null,
} as unknown as Job

const run = {
  id: 'run-1',
  scheduleId: 'job-1',
  projectId: 'proj-1',
  organizationId: 'org_1',
  jobId: 'backend-job-1',
  trigger: 'schedule',
  status: 'submitted',
  conversationId: null,
  skillSnapshot: {},
  createdAt: new Date('2026-09-02T03:00:00Z'),
} as unknown as JobRun

const task = {
  id: 'task-1',
  organizationId: 'org_1',
  projectId: 'proj-1',
  kind: 'deep-research',
  title: 'Wochenbericht Brandschutz',
  requesterUserId: 'user_owner',
  requesterEmail: 'owner@grid.test',
  status: 'running',
  backendJobId: 'backend-job-1',
} as unknown as Task

const pinned = {
  userId: 'user_owner',
  email: 'owner@grid.test',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: ['project:documents:write', 'project:documents:generate'],
  featureFlags: null,
  accessToken: '',
  name: null,
} as AuthorizedSession

beforeEach(() => {
  vi.clearAllMocks()
  // The row as the database would hand it back: every update lands on the
  // previous state, so the second update sees the first's status.
  let current: Task = task
  vi.mocked(repository.updateTask).mockImplementation(async (_id, _org, patch) => {
    current = { ...current, ...patch } as Task
    return current
  })
  vi.mocked(repository.insertTask).mockImplementation(async (values) => ({ ...task, ...values, id: 'task-1' }) as Task)
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(pinned)
  vi.mocked(fileResearchReport).mockResolvedValue({
    documentId: 'doc-9',
    filename: 'wochenbericht-brandschutz-2026-09-02.pdf',
    folderId: null,
    alreadyFiled: false,
  })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('createTaskForRun', () => {
  it('pins the requester and freezes the plan beside the run', async () => {
    const created = await createTaskForRun(job, run, 'Prüfe …\n\n---\nSkill …')

    expect(created?.id).toBe('task-1')
    expect(repository.insertTask).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        projectId: 'proj-1',
        kind: 'deep-research',
        title: 'Wochenbericht Brandschutz',
        requesterUserId: 'user_owner',
        requesterEmail: 'owner@grid.test',
        status: 'running',
        jobId: 'job-1',
        jobRunId: 'run-1',
        backendJobId: 'backend-job-1',
        plan: { prompt: 'Prüfe …\n\n---\nSkill …', skill: {}, dataSources: ['knowledge_layer'] },
      })
    )
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.created', actor: { userId: 'user_owner', email: 'owner@grid.test' } })
    )
  })

  it('records nothing for a run that was not submitted', async () => {
    const skipped = { ...run, status: 'skipped', jobId: null } as unknown as JobRun

    expect(await createTaskForRun(job, skipped, 'x')).toBeNull()
    expect(repository.insertTask).not.toHaveBeenCalled()
  })

  it('never lets a failed insert become a run nobody hears about', async () => {
    vi.mocked(repository.insertTask).mockRejectedValueOnce(new Error('db gone'))

    await expect(createTaskForRun(job, run, 'x')).resolves.toBeNull()
  })
})

describe('completeTaskForRun', () => {
  it('files a finished deep-research report as the requester and records where', async () => {
    const result = await completeTaskForRun(task, { status: 'success', report: '# Bericht', cards: [{ type: 'legal_basis' }] })

    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith({
      userId: 'user_owner',
      email: 'owner@grid.test',
      organizationId: 'org_1',
    })
    expect(fileResearchReport).toHaveBeenCalledWith({
      session: pinned,
      projectId: 'proj-1',
      runId: 'backend-job-1',
      report: '# Bericht',
      cards: [{ type: 'legal_basis' }],
    })
    expect(result.filed).toEqual({ documentId: 'doc-9', filename: 'wochenbericht-brandschutz-2026-09-02.pdf' })
    expect(repository.updateTask).toHaveBeenLastCalledWith('task-1', 'org_1', {
      filingStatus: 'filed',
      filingDetail: null,
      filedDocumentId: 'doc-9',
    })
    expect(result.task.status).toBe('succeeded')
  })

  it('refuses, and records why, when the requester is no longer a member', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValueOnce(null)

    const result = await completeTaskForRun(task, { status: 'success', report: '# Bericht' })

    expect(fileResearchReport).not.toHaveBeenCalled()
    expect(result.filed).toBeNull()
    expect(repository.updateTask).toHaveBeenLastCalledWith(
      'task-1',
      'org_1',
      expect.objectContaining({ filingStatus: 'refused', filedDocumentId: null })
    )
  })

  it.each([
    ['a permission the requester does not hold', new NotFoundError('Project not found')],
    ['a feature that is off for the organization', new ForbiddenError('disabled')],
  ])('treats %s as a refusal, never as a failure', async (_label, error) => {
    vi.mocked(fileResearchReport).mockRejectedValueOnce(error)

    const result = await completeTaskForRun(task, { status: 'success', report: '# Bericht' })

    expect(result.filed).toBeNull()
    expect(repository.updateTask).toHaveBeenLastCalledWith(
      'task-1',
      'org_1',
      expect.objectContaining({ filingStatus: 'refused' })
    )
  })

  it('records a broken filing as failed with the operator detail, and still closes the task', async () => {
    vi.mocked(fileResearchReport).mockRejectedValueOnce(new Error('report exceeds the PDF ceiling'))

    const result = await completeTaskForRun(task, { status: 'success', report: '# Bericht' })

    expect(result.task.status).toBe('succeeded')
    expect(repository.updateTask).toHaveBeenLastCalledWith(
      'task-1',
      'org_1',
      expect.objectContaining({ filingStatus: 'failed', filingDetail: 'Error: report exceeds the PDF ceiling' })
    )
  })

  it('closes a failed run without filing anything', async () => {
    const result = await completeTaskForRun(task, { status: 'failure', error: 'Budget exhausted' })

    expect(result.task.status).toBe('failed')
    expect(result.task.error).toBe('Budget exhausted')
    expect(fileResearchReport).not.toHaveBeenCalled()
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.completed', metadata: expect.objectContaining({ status: 'failed' }) })
    )
  })

  it('files nothing for a chat task, whose result is its conversation', async () => {
    const chat = { ...task, kind: 'chat' } as Task

    const result = await completeTaskForRun(chat, { status: 'success', report: 'answer' })

    expect(fileResearchReport).not.toHaveBeenCalled()
    expect(result.filed).toBeNull()
  })
})

describe('reviewTask', () => {
  const reviewer = { ...pinned, userId: 'user_reviewer', email: 'reviewer@grid.test' } as AuthorizedSession

  it('records the decision, the reason and who decided', async () => {
    vi.mocked(repository.findTaskInProject).mockResolvedValueOnce({ ...task, status: 'succeeded' } as Task)

    const reviewed = await reviewTask(reviewer, 'proj-1', 'task-1', {
      decision: 'rejected',
      reason: 'Atrium ist OIB 2.3, siehe Entscheidung vom 12.08.',
    })

    expect(requireProjectAccess).toHaveBeenCalledWith(reviewer, 'proj-1', 'project:edit')
    expect(reviewed.review).toBe('rejected')
    expect(reviewed.reviewReason).toBe('Atrium ist OIB 2.3, siehe Entscheidung vom 12.08.')
    expect(reviewed.reviewedBy).toBe('user_reviewer')
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.reviewed', metadata: expect.objectContaining({ decision: 'rejected', withReason: true }) })
    )
  })

  it('refuses to review a task that is still running', async () => {
    vi.mocked(repository.findTaskInProject).mockResolvedValueOnce(task)

    await expect(reviewTask(reviewer, 'proj-1', 'task-1', { decision: 'accepted' })).rejects.toMatchObject({ status: 409 })
  })

  it('is a 404 for a task outside the project', async () => {
    vi.mocked(repository.findTaskInProject).mockResolvedValueOnce(null)

    await expect(reviewTask(reviewer, 'proj-1', 'task-x', { decision: 'accepted' })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('previousDecisionsBlock', () => {
  it('quotes earlier rejections verbatim, newest first, under a versioned header', async () => {
    vi.mocked(repository.listRejectedReviewsForJob).mockResolvedValueOnce([
      { id: 't2', reviewReason: 'Atrium ist OIB 2.3.', reviewedAt: new Date('2026-09-01T10:00:00Z'), reviewedBy: 'u' },
      { id: 't1', reviewReason: 'Bundesland fehlt.', reviewedAt: null, reviewedBy: 'u' },
    ])

    const block = await previousDecisionsBlock(job)

    expect(block.startsWith(`### ${PREVIOUS_DECISIONS_HEADER}`)).toBe(true)
    expect(block).toContain('- [abgelehnt, 2026-09-01] Atrium ist OIB 2.3.')
    expect(block).toContain('- [abgelehnt] Bundesland fehlt.')
  })

  it('is empty when nothing was rejected', async () => {
    vi.mocked(repository.listRejectedReviewsForJob).mockResolvedValueOnce([])

    expect(await previousDecisionsBlock(job)).toBe('')
  })

  it('never stops a run from firing', async () => {
    vi.mocked(repository.listRejectedReviewsForJob).mockRejectedValueOnce(new Error('db gone'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await previousDecisionsBlock(job)).toBe('')
  })
})
