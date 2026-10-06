/**
 * @vitest-environment node
 */
/**
 * The run lifecycle service over `task_runs` (migration 0086): one recorder
 * closes a run, files its result as the pinned requester, and tells them.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({
  insertRun: vi.fn(),
  findRunByBackendJobId: vi.fn(),
  findRunInProject: vi.fn(),
  listRunsInProject: vi.fn(),
  updateRun: vi.fn(),
  closeActiveRun: vi.fn(),
  listRejectedReviewsForDefinition: vi.fn(),
  findRunById: vi.fn(),
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/documents/research-report', () => ({
  fileResearchReport: vi.fn(),
  queueResearchReportFiling: vi.fn(),
}))
vi.mock('@/lib/documents/agent-document', () => ({ fileAgentDocumentDraft: vi.fn() }))
vi.mock('@/lib/documents/lifecycle', () => ({
  replaceVersionContent: vi.fn(),
  transitionDocumentVersion: vi.fn(),
}))
vi.mock('@/lib/documents/revision', () => ({ openDraftForRevision: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn() }))
vi.mock('@/lib/runs/service', () => ({ settleRunLedger: vi.fn() }))

import { ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { TaskRun } from '@/lib/db/schema'
import { fileAgentDocumentDraft } from '@/lib/documents/agent-document'
import { replaceVersionContent, transitionDocumentVersion } from '@/lib/documents/lifecycle'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { fileResearchReport, queueResearchReportFiling } from '@/lib/documents/research-report'
import { openDraftForRevision } from '@/lib/documents/revision'
import { emitInboxItems } from '@/lib/inbox/service'
import { settleRunLedger } from '@/lib/runs/service'
import type { SkillSnapshot } from '@/lib/skills/types'
import * as repository from './repository'
import type { FileResearchReportPayload } from '@/lib/jobs-queue/types'
import {
  completeRunForOutcome,
  PREVIOUS_DECISIONS_HEADER,
  previousDecisionsBlock,
  recordRunOutcome,
  reviewTask,
  runReportFilingJob,
} from './service'

const emptySkill = {} as SkillSnapshot

const definition = {
  id: 'job-1',
  organizationId: 'org_1',
}

const run = {
  id: 'run-1',
  definitionId: 'job-1',
  organizationId: 'org_1',
  projectId: 'proj-1',
  kind: 'deep-research',
  title: 'Wochenbericht Brandschutz',
  plan: { prompt: 'Prüfe …', skill: emptySkill, dataSources: ['knowledge_layer'] },
  requesterUserId: 'user_owner',
  requesterEmail: 'owner@grid.test',
  trigger: 'schedule',
  status: 'running',
  backendJobId: 'backend-job-1',
  conversationId: null,
  skillSnapshot: emptySkill,
} as unknown as TaskRun

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
  let current: TaskRun = run
  vi.mocked(repository.updateRun).mockImplementation(async (_id, _org, patch) => {
    current = { ...current, ...patch } as TaskRun
    return current
  })
  vi.mocked(repository.insertRun).mockImplementation(async (values) => ({ ...run, ...values }) as TaskRun)
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(pinned)
  vi.mocked(fileResearchReport).mockResolvedValue({
    documentId: 'doc-9',
    filename: 'wochenbericht-brandschutz-2026-09-02.pdf',
    folderId: null,
    alreadyFiled: false,
  })
  vi.mocked(queueResearchReportFiling).mockResolvedValue({ jobId: 'bff-job-1' })
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('completeRunForOutcome', () => {
  it('queues the filing of a run that has no definition behind it — an escalated question', async () => {
    // The commissioned run of a chat escalation (ADR-0062): one row, no
    // standing intent. Everything the outcome path needs is on the run itself,
    // and the inbox row says so with a null job id rather than inventing one.
    const escalated = { ...run, definitionId: null, conversationId: 's_conv', runMessageId: 'msg-1' } as TaskRun

    const result = await completeRunForOutcome(escalated, { status: 'success', report: '# Bericht' })

    // Not filed here: the document is the job's to make.
    expect(result.filed).toBeNull()
    expect(result.run.status).toBe('succeeded')
    expect(result.run.filingStatus).toBe('queued')

    await recordRunOutcome(escalated, { status: 'success', report: '# Bericht' })
    const emitted = vi.mocked(emitInboxItems).mock.calls.at(-1)?.[0]?.[0]
    expect(emitted?.payload).toMatchObject({ jobId: null, runId: 'run-1', runMessageId: 'msg-1', filedDocumentId: null })
  })

  it('queues the filing of a finished deep-research report instead of rendering it here', async () => {
    const result = await completeRunForOutcome(run, { status: 'success', report: '# Bericht', cards: [{ type: 'legal_basis' }] })

    expect(queueResearchReportFiling).toHaveBeenCalledWith({
      organizationId: 'org_1',
      payload: {
        runId: 'backend-job-1',
        projectId: 'proj-1',
        report: '# Bericht',
        cards: [{ type: 'legal_basis' }],
        taskRunId: 'run-1',
        // The run's own pinned requester files it, resolved when the job runs.
        requester: null,
      },
    })
    // Nothing is rendered, and nobody is resolved, in the outcome callback.
    expect(fileResearchReport).not.toHaveBeenCalled()
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
    expect(result.filed).toBeNull()
    expect(result.run.status).toBe('succeeded')
    expect(result.run.filingStatus).toBe('queued')
  })

  it('says `queued` before the job exists, so a job that ends at once is never overwritten', async () => {
    await completeRunForOutcome(run, { status: 'success', report: '# Bericht' })

    const order = [
      vi.mocked(repository.updateRun).mock.invocationCallOrder.at(-1) ?? 0,
      vi.mocked(queueResearchReportFiling).mock.invocationCallOrder[0],
    ]
    expect(order[0]).toBeLessThan(order[1])
    expect(repository.updateRun).toHaveBeenLastCalledWith('run-1', 'org_1', {
      filingStatus: 'queued',
      filingDetail: null,
      filedDocumentId: null,
    })
  })

  it('records a filing it could not queue as failed, with the reason, and still closes the run', async () => {
    vi.mocked(queueResearchReportFiling).mockRejectedValueOnce(new Error('database gone'))

    const result = await completeRunForOutcome(run, { status: 'success', report: '# Bericht' })

    expect(result.run.status).toBe('succeeded')
    expect(repository.updateRun).toHaveBeenLastCalledWith(
      'run-1',
      'org_1',
      expect.objectContaining({
        filingStatus: 'failed',
        filingDetail: 'could not queue the filing: Error: database gone',
      })
    )
  })

  it('records a run that has no backend job id as failed rather than queueing nothing', async () => {
    const unsubmitted = { ...run, backendJobId: null } as TaskRun
    vi.mocked(repository.updateRun).mockResolvedValueOnce({ ...unsubmitted, status: 'succeeded' } as TaskRun)

    const result = await completeRunForOutcome(unsubmitted, { status: 'success', report: '# Bericht' })

    expect(queueResearchReportFiling).not.toHaveBeenCalled()
    expect(result.run.filingStatus).toBe('failed')
  })

  it('queues nothing for a run whose report a worker’s earlier attempt already filed', async () => {
    const filed = { ...run, filingStatus: 'filed', filedDocumentId: 'doc-9' } as TaskRun
    vi.mocked(repository.updateRun).mockResolvedValueOnce(filed)

    const result = await completeRunForOutcome(run, { status: 'success', report: '# Bericht' })

    expect(queueResearchReportFiling).not.toHaveBeenCalled()
    expect(result.run.filedDocumentId).toBe('doc-9')
  })

  it('closes a failed run without filing anything', async () => {
    const result = await completeRunForOutcome(run, { status: 'failure', error: 'Budget exhausted' })

    expect(result.run.status).toBe('failed')
    expect(result.run.error).toBe('Budget exhausted')
    expect(fileResearchReport).not.toHaveBeenCalled()
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'task.completed', metadata: expect.objectContaining({ status: 'failed' }) })
    )
  })

  it('files nothing for a chat run, whose result is its conversation', async () => {
    const chat = { ...run, kind: 'chat' } as TaskRun

    const result = await completeRunForOutcome(chat, { status: 'success', report: 'answer' })

    expect(fileResearchReport).not.toHaveBeenCalled()
    expect(result.filed).toBeNull()
  })
})

describe('runReportFilingJob (file_research_report)', () => {
  const payload = (over: Partial<FileResearchReportPayload> = {}): FileResearchReportPayload => ({
    runId: 'backend-job-1',
    projectId: 'proj-1',
    report: '# Bericht',
    cards: [{ type: 'legal_basis' }],
    taskRunId: 'run-1',
    requester: null,
    ...over,
  })
  const last = { last: true }
  const notLast = { last: false }

  beforeEach(() => {
    vi.mocked(repository.findRunById).mockResolvedValue(run)
  })

  it('files as the run’s pinned requester, resolved now, and records where', async () => {
    await runReportFilingJob('org_1', payload(), notLast)

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
    expect(repository.updateRun).toHaveBeenLastCalledWith('run-1', 'org_1', {
      filingStatus: 'filed',
      filingDetail: null,
      filedDocumentId: 'doc-9',
    })
  })

  it('files as the reader whose identity the job carries, and resolves nobody', async () => {
    const requester = {
      userId: 'user_reader',
      email: 'reader@grid.test',
      organizationMembershipId: 'om_7',
      role: 'member',
      permissions: ['project:documents:write'],
      featureFlags: ['agent-authored-documents'],
    }

    await runReportFilingJob('org_1', payload({ requester, taskRunId: null }), notLast)

    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
    expect(vi.mocked(fileResearchReport).mock.calls[0][0].session).toMatchObject({
      userId: 'user_reader',
      organizationId: 'org_1',
      organizationMembershipId: 'om_7',
      permissions: ['project:documents:write'],
      // What the filing's feature gate reads under enforcement.
      featureFlags: ['agent-authored-documents'],
      accessToken: '',
    })
    // A read with no run row has no row to record on.
    expect(repository.updateRun).not.toHaveBeenCalled()
  })

  it('refuses, and records why, when the requester is no longer a member, and does not retry', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValueOnce(null)

    await expect(runReportFilingJob('org_1', payload(), notLast)).resolves.toBeUndefined()

    expect(fileResearchReport).not.toHaveBeenCalled()
    expect(repository.updateRun).toHaveBeenLastCalledWith(
      'run-1',
      'org_1',
      expect.objectContaining({ filingStatus: 'refused', filedDocumentId: null })
    )
  })

  it.each([
    ['a permission the requester does not hold', new NotFoundError('Project not found')],
    ['a feature that is off for the organization', new ForbiddenError('disabled')],
  ])('treats %s as a refusal, never as a failure, and finishes the job', async (_label, error) => {
    vi.mocked(fileResearchReport).mockRejectedValueOnce(error)

    await expect(runReportFilingJob('org_1', payload(), notLast)).resolves.toBeUndefined()

    expect(repository.updateRun).toHaveBeenLastCalledWith(
      'run-1',
      'org_1',
      expect.objectContaining({ filingStatus: 'refused' })
    )
  })

  it('hands a broken filing back to the queue and keeps the row `queued` while a retry is left', async () => {
    vi.mocked(fileResearchReport).mockRejectedValueOnce(new Error('object store down'))

    await expect(runReportFilingJob('org_1', payload(), notLast)).rejects.toThrow('object store down')

    expect(repository.updateRun).not.toHaveBeenCalled()
  })

  it('records the failure, with the operator detail, on the attempt after which the queue gives up', async () => {
    vi.mocked(fileResearchReport).mockRejectedValueOnce(new Error('report exceeds the PDF ceiling'))

    await expect(runReportFilingJob('org_1', payload(), last)).rejects.toThrow('report exceeds the PDF ceiling')

    expect(repository.updateRun).toHaveBeenLastCalledWith(
      'run-1',
      'org_1',
      expect.objectContaining({ filingStatus: 'failed', filingDetail: 'Error: report exceeds the PDF ceiling' })
    )
  })

  it('files the same report twice as one document: the filing is idempotent on the run', async () => {
    await runReportFilingJob('org_1', payload(), notLast)
    await runReportFilingJob('org_1', payload(), notLast)

    // The key is the backend job id, which is what `fileGeneratedDocument` probes on.
    expect(vi.mocked(fileResearchReport).mock.calls.map(([call]) => call.runId)).toEqual([
      'backend-job-1',
      'backend-job-1',
    ])
  })
})

describe('reviewTask', () => {
  const reviewer = { ...pinned, userId: 'user_reviewer', email: 'reviewer@grid.test' } as AuthorizedSession

  it('records the decision, the reason and who decided', async () => {
    vi.mocked(repository.findRunInProject).mockResolvedValueOnce({ ...run, status: 'succeeded' } as TaskRun)

    const reviewed = await reviewTask(reviewer, 'proj-1', 'run-1', {
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

  it('refuses to review a run that is still running', async () => {
    vi.mocked(repository.findRunInProject).mockResolvedValueOnce(run)

    await expect(reviewTask(reviewer, 'proj-1', 'run-1', { decision: 'accepted' })).rejects.toMatchObject({ status: 409 })
  })

  it('is a 404 for a run outside the project', async () => {
    vi.mocked(repository.findRunInProject).mockResolvedValueOnce(null)

    await expect(reviewTask(reviewer, 'proj-1', 'run-x', { decision: 'accepted' })).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('previousDecisionsBlock', () => {
  it('quotes earlier rejections verbatim, newest first, under a versioned header', async () => {
    vi.mocked(repository.listRejectedReviewsForDefinition).mockResolvedValueOnce([
      { id: 't2', reviewReason: 'Atrium ist OIB 2.3.', reviewedAt: new Date('2026-09-01T10:00:00Z'), reviewedBy: 'u' },
      { id: 't1', reviewReason: 'Bundesland fehlt.', reviewedAt: null, reviewedBy: 'u' },
    ])

    const block = await previousDecisionsBlock(definition)

    expect(repository.listRejectedReviewsForDefinition).toHaveBeenCalledWith('job-1', 'org_1')
    expect(block.startsWith(`### ${PREVIOUS_DECISIONS_HEADER}`)).toBe(true)
    expect(block).toContain('- [abgelehnt, 2026-09-01] Atrium ist OIB 2.3.')
    expect(block).toContain('- [abgelehnt] Bundesland fehlt.')
  })

  it('is empty when nothing was rejected', async () => {
    vi.mocked(repository.listRejectedReviewsForDefinition).mockResolvedValueOnce([])

    expect(await previousDecisionsBlock(definition)).toBe('')
  })

  it('never stops a run from firing', async () => {
    vi.mocked(repository.listRejectedReviewsForDefinition).mockRejectedValueOnce(new Error('db gone'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(await previousDecisionsBlock(definition)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// The delegated kinds (ADR-0051)
// ---------------------------------------------------------------------------

/** A run delegated from chat: no schedule, its own definition, its own backend id. */
const delegated = (overrides: Partial<TaskRun> = {}): TaskRun => {
  const row = {
    ...run,
    kind: 'document',
    trigger: 'delegated',
    title: 'Dokument: Aktenvermerk Fluchtweg',
    conversationId: 's_conv_2',
    plan: { prompt: 'Schreibe …', skill: emptySkill, dataSources: null, goal: 'Schreib den Aktenvermerk' },
    ...overrides,
  } as TaskRun
  let current = row
  vi.mocked(repository.updateRun).mockImplementation(async (_id, _org, patch) => {
    current = { ...current, ...patch } as TaskRun
    return current
  })
  return row
}

describe('completeRunForOutcome, by kind', () => {
  it('files a `document` run as a new draft and submits it to the requester', async () => {
    vi.mocked(fileAgentDocumentDraft).mockResolvedValue({
      documentId: 'doc-7',
      version: { id: 'ver-1' } as never,
      alreadyFiled: false,
    })
    vi.mocked(findDocumentInOrg).mockResolvedValue({ filename: 'aktenvermerk-2026-09-10.md' } as never)

    const { filed } = await completeRunForOutcome(delegated(), { status: 'success', report: '# Aktenvermerk' })

    // The run's own id as the reference, so a retried outcome updates the
    // document the first one made rather than filing a second.
    expect(vi.mocked(fileAgentDocumentDraft).mock.calls[0][0]).toMatchObject({
      projectId: 'proj-1',
      ref: 'task-run-1',
      content: '# Aktenvermerk',
      actingHuman: false,
    })
    expect(transitionDocumentVersion).toHaveBeenCalledWith(expect.anything(), 'doc-7', 'ver-1', 'submit', {
      reviewerUserIds: ['user_owner'],
      // The run's own submission, like the filing one line up. The flag is what
      // the publish door reads and what migration 0085 records.
      actingHuman: false,
    })
    expect(filed).toEqual({ documentId: 'doc-7', filename: 'aktenvermerk-2026-09-10.md' })
  })

  it('does not submit a `document` run twice when the reference was already filed', async () => {
    vi.mocked(fileAgentDocumentDraft).mockResolvedValue({
      documentId: 'doc-7',
      version: { id: 'ver-1' } as never,
      alreadyFiled: true,
    })
    vi.mocked(findDocumentInOrg).mockResolvedValue({ filename: 'aktenvermerk-2026-09-10.md' } as never)

    await completeRunForOutcome(delegated(), { status: 'success', report: '# Aktenvermerk' })
    expect(transitionDocumentVersion).not.toHaveBeenCalled()
  })

  it('writes a `revision` run over the open draft of the SAME document and submits it back', async () => {
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
        skill: emptySkill,
        dataSources: null,
        goal: 'Die Fluchtweglänge stimmt nicht',
        subject: { documentId: 'doc-3', versionId: 'ver-1', comment: 'Die Fluchtweglänge stimmt nicht' },
      },
    })

    const { filed } = await completeRunForOutcome(revision, { status: 'success', report: '# Befund, überarbeitet' })

    // The If-Match is the hash the LIFECYCLE reported, never one computed here:
    // a self-computed hash agrees with itself and overwrites a reviewer.
    expect(vi.mocked(replaceVersionContent).mock.calls[0].slice(1)).toEqual([
      'doc-3',
      'ver-2',
      '# Befund, überarbeitet',
      'sha256:abc',
      // A run is not a person, on both halves of the filing.
      { actingHuman: false },
    ])
    // Back to the person who asked for the changes: they are the one waiting.
    expect(transitionDocumentVersion).toHaveBeenCalledWith(
      expect.anything(),
      'doc-3',
      'ver-2',
      'submit',
      { reviewerUserIds: ['user_reviewer'], actingHuman: false },
    )
    // The SAME document, never a second one.
    expect(filed).toEqual({ documentId: 'doc-3', filename: 'befund.md' })
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })

  it('records a revision run with no subject as a failed filing rather than throwing', async () => {
    const broken = delegated({ kind: 'revision', plan: { prompt: 'x', skill: emptySkill, dataSources: null } })
    const { run: closed } = await completeRunForOutcome(broken, { status: 'success', report: '# x' })
    expect(closed.filingStatus).toBe('failed')
  })

  it('files nothing for a `compliance_check` or an `einreichcheck`', async () => {
    // Their result IS the conversation the run wrote into; filing the prose as
    // a second document would put a copy of the thread in Berichte.
    for (const kind of ['compliance_check', 'einreichcheck'] as const) {
      vi.clearAllMocks()
      const { filed } = await completeRunForOutcome(delegated({ kind }), { status: 'success', report: '# Ergebnis' })
      expect(filed).toBeNull()
      expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
      expect(fileResearchReport).not.toHaveBeenCalled()
    }
  })
})

describe('recordRunOutcome', () => {
  it('closes the run and tells the requester, with the run and the thread on the row', async () => {
    vi.mocked(emitInboxItems).mockResolvedValue(1)
    vi.mocked(fileAgentDocumentDraft).mockResolvedValue({
      documentId: 'doc-7',
      version: { id: 'ver-1' } as never,
      alreadyFiled: false,
    })
    vi.mocked(findDocumentInOrg).mockResolvedValue({ filename: 'aktenvermerk.md' } as never)

    const { notified, filed } = await recordRunOutcome(delegated(), { status: 'success', report: '# x' })

    expect(notified).toBe(true)
    expect(filed).toEqual({ documentId: 'doc-7', filename: 'aktenvermerk.md' })
    const [[emission]] = vi.mocked(emitInboxItems).mock.calls
    expect(emission[0]).toMatchObject({
      recipientUserId: 'user_owner',
      type: 'job.completed',
      resourceType: 'project',
      resourceId: 'proj-1',
      // The work was Piloti's, and a row whose actor is its recipient is
      // dropped — which a run somebody delegated to themselves always would be.
      actorUserId: null,
    })
    expect(emission[0].payload).toMatchObject({
      // The run is the task now: taskId and runId name the same row.
      taskId: 'run-1',
      runId: 'run-1',
      conversationId: 's_conv_2',
      filedDocumentId: 'doc-7',
      jobId: 'job-1',
    })
  })

  it('settles the run’s block before it closes the row, whoever reported the ending', async () => {
    // The reaper's and the cancel route's reports carry no ledger op: there is
    // no worker left to send one. Before, the row closed and the block read
    // „läuft" for good.
    const row = delegated()
    const order: string[] = []
    vi.mocked(settleRunLedger).mockImplementation(async () => {
      order.push('block')
      return true
    })
    const update = vi.mocked(repository.updateRun).getMockImplementation()
    vi.mocked(repository.updateRun).mockImplementation(async (...args) => {
      order.push('row')
      return update!(...args)
    })

    await recordRunOutcome(row, { status: 'interrupted' })

    expect(settleRunLedger).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }), { status: 'interrupted' })
    // Block first: a failure between the two leaves the row active, and the
    // retry (the worker's, or the reconciler's) does both.
    expect(order[0]).toBe('block')
    expect(order).toContain('row')
  })

  it('closes nothing when the block cannot be written, so the report is retried whole', async () => {
    vi.mocked(settleRunLedger).mockRejectedValueOnce(new Error('db down'))
    await expect(recordRunOutcome(delegated(), { status: 'failure' })).rejects.toThrow('db down')
    expect(repository.updateRun).not.toHaveBeenCalled()
  })

  it('tells the requester about a failure too, and files nothing', async () => {
    vi.mocked(emitInboxItems).mockResolvedValue(1)
    await recordRunOutcome(delegated(), { status: 'failure', error: 'Budget exhausted' })

    const [[emission]] = vi.mocked(emitInboxItems).mock.calls
    expect(emission[0].type).toBe('job.failed')
    expect(fileAgentDocumentDraft).not.toHaveBeenCalled()
  })

  describe('onlyIfActive — the run reconciler’s mode', () => {
    it('closes through the conditional write and then does everything the worker’s report does', async () => {
      vi.mocked(emitInboxItems).mockResolvedValue(1)
      vi.mocked(repository.closeActiveRun).mockImplementation(
        async (_id, _org, patch) => ({ ...run, ...patch }) as TaskRun,
      )

      const result = await recordRunOutcome(run, { status: 'success', report: '# Bericht' }, { onlyIfActive: true })

      expect(result.closed).toBe(true)
      expect(repository.closeActiveRun).toHaveBeenCalledWith(
        'run-1',
        'org_1',
        expect.objectContaining({ status: 'succeeded', error: null }),
      )
      expect(recordAuditEvent).toHaveBeenCalledTimes(1)
      expect(queueResearchReportFiling).toHaveBeenCalledTimes(1)
      expect(emitInboxItems).toHaveBeenCalledTimes(1)
    })

    it('does nothing past the close when the row had already ended — the requester hears once', async () => {
      vi.mocked(repository.closeActiveRun).mockResolvedValue(null)

      const result = await recordRunOutcome(run, { status: 'success', report: '# Bericht' }, { onlyIfActive: true })

      expect(result).toEqual({ notified: false, filed: null, closed: false })
      expect(repository.updateRun).not.toHaveBeenCalled()
      expect(recordAuditEvent).not.toHaveBeenCalled()
      expect(fileResearchReport).not.toHaveBeenCalled()
      expect(emitInboxItems).not.toHaveBeenCalled()
    })

    it('settles the block even when the row had already ended — a closed run is never left „läuft"', async () => {
      vi.mocked(repository.closeActiveRun).mockResolvedValue(null)
      await recordRunOutcome(run, { status: 'failure', error: 'Job timed out' }, { onlyIfActive: true })
      expect(settleRunLedger).toHaveBeenCalledWith(run, { status: 'failure', error: 'Job timed out' })
    })

    it('the worker’s own report still closes unconditionally, so a retried report reaches the inbox', async () => {
      vi.mocked(emitInboxItems).mockResolvedValue(1)
      const result = await recordRunOutcome({ ...run, status: 'succeeded' } as TaskRun, { status: 'success' })
      expect(repository.closeActiveRun).not.toHaveBeenCalled()
      expect(result).toMatchObject({ notified: true, closed: true })
    })
  })
})
