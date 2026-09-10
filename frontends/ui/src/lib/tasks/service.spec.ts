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
vi.mock('@/lib/documents/agent-document', () => ({ fileAgentDocumentDraft: vi.fn() }))
vi.mock('@/lib/documents/lifecycle', () => ({
  replaceVersionContent: vi.fn(),
  transitionDocumentVersion: vi.fn(),
}))
vi.mock('@/lib/documents/revision', () => ({ openDraftForRevision: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn() }))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { Job, JobRun, Task } from '@/lib/db/schema'
import { fileAgentDocumentDraft } from '@/lib/documents/agent-document'
import { replaceVersionContent, transitionDocumentVersion } from '@/lib/documents/lifecycle'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { fileResearchReport } from '@/lib/documents/research-report'
import { openDraftForRevision } from '@/lib/documents/revision'
import { emitInboxItems } from '@/lib/inbox/service'
import * as repository from './repository'
import {
  completeTaskForRun,
  createTaskForRun,
  PREVIOUS_DECISIONS_HEADER,
  previousDecisionsBlock,
  recordTaskOutcome,
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

// ---------------------------------------------------------------------------
// The delegated kinds (ADR-0051, slice 6)
// ---------------------------------------------------------------------------

/**
 * A task delegated from chat: no job, no run, its own backend job id.
 *
 * It also re-seeds the `updateTask` double, because `completeTaskForRun` files
 * from the row the database HANDS BACK rather than from the one it was given —
 * the shared double in `beforeEach` starts from the deep-research fixture, and a
 * test that did not re-seed it would be asserting about that task's kind.
 */
const delegated = (overrides: Partial<Task> = {}): Task => {
  const row = {
    ...task,
    kind: 'document',
    title: 'Dokument: Aktenvermerk Fluchtweg',
    conversationId: 's_conv_2',
    plan: { prompt: 'Schreibe …', skill: {}, dataSources: null, goal: 'Schreib den Aktenvermerk' },
    ...overrides,
  } as Task
  let current = row
  vi.mocked(repository.updateTask).mockImplementation(async (_id, _org, patch) => {
    current = { ...current, ...patch } as Task
    return current
  })
  return row
}

describe('completeTaskForRun, by kind', () => {
  it('files a `document` task as a new draft and submits it to the requester', async () => {
    vi.mocked(fileAgentDocumentDraft).mockResolvedValue({
      documentId: 'doc-7',
      version: { id: 'ver-1' } as never,
      alreadyFiled: false,
    })
    vi.mocked(findDocumentInOrg).mockResolvedValue({ filename: 'aktenvermerk-2026-09-10.md' } as never)

    const { filed } = await completeTaskForRun(delegated(), { status: 'success', report: '# Aktenvermerk' })

    // The task's own id as the reference, so a retried outcome updates the
    // document the first one made rather than filing a second.
    expect(vi.mocked(fileAgentDocumentDraft).mock.calls[0][0]).toMatchObject({
      projectId: 'proj-1',
      ref: 'task-task-1',
      content: '# Aktenvermerk',
      actingHuman: false,
    })
    expect(transitionDocumentVersion).toHaveBeenCalledWith(expect.anything(), 'doc-7', 'ver-1', 'submit', {
      reviewerUserIds: ['user_owner'],
    })
    expect(filed).toEqual({ documentId: 'doc-7', filename: 'aktenvermerk-2026-09-10.md' })
  })

  it('does not submit a `document` task twice when the reference was already filed', async () => {
    vi.mocked(fileAgentDocumentDraft).mockResolvedValue({
      documentId: 'doc-7',
      version: { id: 'ver-1' } as never,
      alreadyFiled: true,
    })
    vi.mocked(findDocumentInOrg).mockResolvedValue({ filename: 'aktenvermerk-2026-09-10.md' } as never)

    await completeTaskForRun(delegated(), { status: 'success', report: '# Aktenvermerk' })
    expect(transitionDocumentVersion).not.toHaveBeenCalled()
  })

  it('writes a `revision` task over the open draft of the SAME document and submits it back', async () => {
    vi.mocked(openDraftForRevision).mockResolvedValue({
      version: { id: 'ver-2', contentHash: 'sha256:abc' } as never,
      filename: 'befund.md',
      reviewers: ['user_reviewer'],
    })
    vi.mocked(replaceVersionContent).mockResolvedValue({ id: 'ver-2' } as never)

    const revision = delegated({
      kind: 'revision',
      plan: {
        prompt: 'Überarbeite …',
        skill: {},
        dataSources: null,
        goal: 'Die Fluchtweglänge stimmt nicht',
        subject: { documentId: 'doc-3', versionId: 'ver-1', comment: 'Die Fluchtweglänge stimmt nicht' },
      },
    } as Partial<Task>)

    const { filed } = await completeTaskForRun(revision, { status: 'success', report: '# Befund, überarbeitet' })

    // The If-Match is the hash the LIFECYCLE reported, never one computed here:
    // a self-computed hash agrees with itself and overwrites a reviewer.
    expect(vi.mocked(replaceVersionContent).mock.calls[0].slice(1)).toEqual([
      'doc-3',
      'ver-2',
      '# Befund, überarbeitet',
      'sha256:abc',
    ])
    // Back to the person who asked for the changes: they are the one waiting.
    expect(transitionDocumentVersion).toHaveBeenCalledWith(
      expect.anything(),
      'doc-3',
      'ver-2',
      'submit',
      { reviewerUserIds: ['user_reviewer'] },
    )
    // The SAME document, never a second one.
    expect(filed).toEqual({ documentId: 'doc-3', filename: 'befund.md' })
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })

  it('records a revision task with no subject as a failed filing rather than throwing', async () => {
    const broken = delegated({ kind: 'revision' })
    const { task: closed } = await completeTaskForRun(broken, { status: 'success', report: '# x' })
    expect(closed.filingStatus).toBe('failed')
  })

  it('files nothing for a `compliance_check` or an `einreichcheck`', async () => {
    // Their result IS the conversation the run wrote into; filing the prose as
    // a second document would put a copy of the thread in Berichte.
    for (const kind of ['compliance_check', 'einreichcheck'] as const) {
      vi.clearAllMocks()
      const { filed } = await completeTaskForRun(delegated({ kind }), { status: 'success', report: '# Ergebnis' })
      expect(filed).toBeNull()
      expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
      expect(fileResearchReport).not.toHaveBeenCalled()
    }
  })
})

describe('recordTaskOutcome', () => {
  it('closes the task and tells the requester, with the task and the thread on the row', async () => {
    vi.mocked(emitInboxItems).mockResolvedValue(1)
    vi.mocked(fileAgentDocumentDraft).mockResolvedValue({
      documentId: 'doc-7',
      version: { id: 'ver-1' } as never,
      alreadyFiled: false,
    })
    vi.mocked(findDocumentInOrg).mockResolvedValue({ filename: 'aktenvermerk.md' } as never)

    const { notified, filed } = await recordTaskOutcome(delegated(), { status: 'success', report: '# x' })

    expect(notified).toBe(true)
    expect(filed).toEqual({ documentId: 'doc-7', filename: 'aktenvermerk.md' })
    const [[emission]] = vi.mocked(emitInboxItems).mock.calls
    expect(emission[0]).toMatchObject({
      recipientUserId: 'user_owner',
      type: 'job.completed',
      resourceType: 'project',
      resourceId: 'proj-1',
      // The work was Piloti's, and a row whose actor is its recipient is
      // dropped — which a task somebody delegated to themselves always would be.
      actorUserId: null,
    })
    expect(emission[0].payload).toMatchObject({
      taskId: 'task-1',
      conversationId: 's_conv_2',
      filedDocumentId: 'doc-7',
      jobId: null,
      runId: null,
    })
  })

  it('tells the requester about a failure too, and files nothing', async () => {
    vi.mocked(emitInboxItems).mockResolvedValue(1)
    await recordTaskOutcome(delegated(), { status: 'failure', error: 'Budget exhausted' })

    const [[emission]] = vi.mocked(emitInboxItems).mock.calls
    expect(emission[0].type).toBe('job.failed')
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })
})
