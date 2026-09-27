/**
 * @vitest-environment node
 */
/**
 * The run reconciler: which runs it closes, how, and that doing it twice is
 * doing it once.
 *
 * The decision is a pure function of the run's age, the job store's answer and
 * the clock, so its table is pinned case by case. The moves are then pinned
 * against the three functions the worker's own writes reach — the reconciler
 * must be a second caller of the same path, never a second path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/tasks/repository', () => ({ claimRunsToReconcile: vi.fn() }))
vi.mock('@/lib/tasks/service', () => ({ recordRunOutcome: vi.fn() }))
vi.mock('./service', () => ({
  applyRunLedgerOp: vi.fn(),
  readRunMessage: vi.fn(),
  writeRunReport: vi.fn(),
}))
vi.mock('@/lib/jobs/backend-client', () => ({ fetchBackendJobOutcome: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({
  withTenant: vi.fn(async (_scope: unknown, run: () => Promise<unknown>) => run()),
  withPlatformAccess: vi.fn(async (_why: string, run: () => Promise<unknown>) => run()),
}))

import { NotFoundError } from '@/lib/api/errors'
import type { TaskRun } from '@/lib/db/schema'
import { emptySkillSnapshot } from '@/lib/jobs/types'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { fetchBackendJobOutcome, type BackendJobOutcome } from '@/lib/jobs/backend-client'
import { claimRunsToReconcile } from '@/lib/tasks/repository'
import { recordRunOutcome } from '@/lib/tasks/service'
import { emptyRunLedger, finishRun } from './run-ledger'
import {
  decideReconciliation,
  LOST_JOB_REASON,
  NEVER_SUBMITTED_REASON,
  readReconcileConfig,
  reconcileRun,
  reconcileStaleRuns,
  type JobProbe,
} from './reconcile'
import { applyRunLedgerOp, readRunMessage, writeRunReport } from './service'

const NOW = new Date('2026-09-27T12:00:00.000Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)
const CONFIG = { staleMinutes: 10, unknownGraceMinutes: 120, batch: 25 }

function makeRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'run-1',
    organizationId: 'org_1',
    projectId: 'project-1',
    definitionId: null,
    kind: 'deep-research',
    title: 'Brandschutz',
    plan: { prompt: 'p', skill: emptySkillSnapshot(), dataSources: null, goal: 'p', subject: null },
    requesterUserId: 'user_1',
    requesterEmail: 'a@example.com',
    trigger: 'delegated',
    triggeredBy: 'user_1',
    status: 'running',
    error: null,
    skillSnapshot: emptySkillSnapshot(),
    backendJobId: 'job-1',
    conversationId: 's_conv_1',
    runMessageId: 'msg-1',
    filedDocumentId: null,
    filingStatus: null,
    filingDetail: null,
    review: null,
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    createdAt: minutesAgo(30),
    startedAt: minutesAgo(30),
    finishedAt: null,
    updatedAt: minutesAgo(30),
    reconcileCheckedAt: null,
    ...overrides,
  } as TaskRun
}

function outcome(overrides: Partial<BackendJobOutcome> = {}): BackendJobOutcome {
  return { status: 'success', error: null, report: '# Bericht', cards: null, message: null, ...overrides }
}

const found = (o: Partial<BackendJobOutcome> = {}): JobProbe => ({ kind: 'found', outcome: outcome(o) })

describe('decideReconciliation', () => {
  const run = makeRun()

  it('closes a finished job exactly as its outcome says', () => {
    const message = { content: '# Bericht', metadata: { job_id: 'job-1' } }
    const decision = decideReconciliation(run, found({ cards: [{ type: 'x' }], message }), NOW, CONFIG)
    expect(decision).toEqual({
      kind: 'close',
      outcome: { status: 'success', error: null, report: '# Bericht', cards: [{ type: 'x' }] },
      message,
      ledger: { op: 'finish', result: { filedAt: NOW.toISOString() } },
    })
  })

  it('settles the ledger the way the worker’s fold would, per ending', () => {
    const failed = decideReconciliation(run, found({ status: 'failure', error: 'boom', report: null }), NOW, CONFIG)
    expect(failed).toMatchObject({ outcome: { status: 'failure', error: 'boom' }, ledger: { op: 'finish', error: { reason: 'boom' } } })

    // A cancel has no finish op; „abgebrochen" travels as a status (ADR-0062).
    const cancelled = decideReconciliation(run, found({ status: 'interrupted', report: null }), NOW, CONFIG)
    expect(cancelled).toMatchObject({ outcome: { status: 'interrupted' }, ledger: { op: 'append', status: 'abgebrochen' } })

    const silent = decideReconciliation(run, found({ status: 'failure', error: null, report: null }), NOW, CONFIG)
    expect(silent).toMatchObject({ ledger: { op: 'finish', error: { reason: 'Der Lauf ist fehlgeschlagen.' } } })
  })

  it('leaves a job that is still working alone', () => {
    expect(decideReconciliation(run, found({ status: 'running' }), NOW, CONFIG)).toEqual({ kind: 'wait', why: 'still-running' })
    expect(decideReconciliation(run, found({ status: 'submitted' }), NOW, CONFIG)).toEqual({ kind: 'wait', why: 'still-running' })
  })

  it('never closes a run because the backend could not be reached', () => {
    const ancient = makeRun({ startedAt: minutesAgo(10_000) })
    expect(decideReconciliation(ancient, { kind: 'unreachable' }, NOW, CONFIG)).toEqual({ kind: 'wait', why: 'unreachable' })
  })

  it('waits out the grace before failing a job the store cannot find', () => {
    const young = makeRun({ startedAt: minutesAgo(119) })
    expect(decideReconciliation(young, { kind: 'not-found' }, NOW, CONFIG)).toEqual({ kind: 'wait', why: 'within-grace' })

    const old = makeRun({ startedAt: minutesAgo(121) })
    expect(decideReconciliation(old, { kind: 'not-found' }, NOW, CONFIG)).toMatchObject({
      kind: 'close',
      outcome: { status: 'failure', error: LOST_JOB_REASON },
      message: null,
      ledger: { op: 'finish', error: { reason: LOST_JOB_REASON } },
    })
  })

  it('judges a run that never started by when it was created, and says it never reached the worker', () => {
    const queued = makeRun({ status: 'queued', backendJobId: null, startedAt: null, createdAt: minutesAgo(200) })
    expect(decideReconciliation(queued, { kind: 'no-job' }, NOW, CONFIG)).toMatchObject({
      kind: 'close',
      outcome: { status: 'failure', error: NEVER_SUBMITTED_REASON },
    })
    const fresh = makeRun({ status: 'queued', backendJobId: null, startedAt: null, createdAt: minutesAgo(5) })
    expect(decideReconciliation(fresh, { kind: 'no-job' }, NOW, CONFIG)).toEqual({ kind: 'wait', why: 'within-grace' })
  })
})

describe('readReconcileConfig', () => {
  it('defaults to a ten-minute window and a two-hour grace', () => {
    expect(readReconcileConfig({})).toEqual({ staleMinutes: 10, unknownGraceMinutes: 120, batch: 25 })
  })

  it('reads the two knobs and never lets the grace be shorter than the window', () => {
    expect(
      readReconcileConfig({ GRID_RUN_RECONCILE_STALE_MINUTES: '15', GRID_RUN_RECONCILE_UNKNOWN_GRACE_MINUTES: '60' }),
    ).toMatchObject({ staleMinutes: 15, unknownGraceMinutes: 60 })
    expect(
      readReconcileConfig({ GRID_RUN_RECONCILE_STALE_MINUTES: '30', GRID_RUN_RECONCILE_UNKNOWN_GRACE_MINUTES: '5' }),
    ).toMatchObject({ staleMinutes: 30, unknownGraceMinutes: 30 })
    expect(readReconcileConfig({ GRID_RUN_RECONCILE_STALE_MINUTES: '0' }).staleMinutes).toBe(10)
  })
})

describe('reconcileRun', () => {
  const message = { content: '# Bericht', metadata: { job_id: 'job-1' } }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(recordRunOutcome).mockResolvedValue({ notified: true, filed: null, closed: true })
    vi.mocked(fetchBackendJobOutcome).mockResolvedValue(outcome({ message }))
  })

  it('asks the job store with the run’s own backend id and organization', async () => {
    vi.mocked(readRunMessage).mockResolvedValue(null)
    await reconcileRun(makeRun(), CONFIG, NOW)
    expect(fetchBackendJobOutcome).toHaveBeenCalledWith('job-1', 'org_1')
  })

  it('fills an empty message, settles a live ledger, then closes the row through the one outcome recorder', async () => {
    vi.mocked(readRunMessage).mockResolvedValue({ content: '', ledger: emptyRunLedger('run-1', minutesAgo(30)) })
    const order: string[] = []
    vi.mocked(writeRunReport).mockImplementation(async () => {
      order.push('message')
      return { runId: 'run-1', conversationId: 's_conv_1', messageId: 'msg-1' }
    })
    vi.mocked(applyRunLedgerOp).mockImplementation(async () => {
      order.push('ledger')
      return { runId: 'run-1', ledger: emptyRunLedger('run-1') }
    })
    vi.mocked(recordRunOutcome).mockImplementation(async () => {
      order.push('row')
      return { notified: true, filed: null, closed: true }
    })

    const run = makeRun()
    expect(await reconcileRun(run, CONFIG, NOW)).toBe('closed')

    expect(writeRunReport).toHaveBeenCalledWith('job-1', message)
    expect(applyRunLedgerOp).toHaveBeenCalledWith('run-1', { op: 'finish', result: { filedAt: NOW.toISOString() } }, NOW)
    expect(recordRunOutcome).toHaveBeenCalledWith(
      run,
      { status: 'success', error: null, report: '# Bericht', cards: null },
      { onlyIfActive: true },
    )
    // The row last: a sweep that fails halfway leaves it active for the next one.
    expect(order).toEqual(['message', 'ledger', 'row'])
  })

  it('touches neither the message nor the ledger when the worker’s writes did land', async () => {
    const settled = finishRun(emptyRunLedger('run-1', minutesAgo(30)), { filedAt: minutesAgo(1).toISOString() }, minutesAgo(1))
    vi.mocked(readRunMessage).mockResolvedValue({ content: '# Bericht', ledger: settled })

    await reconcileRun(makeRun(), CONFIG, NOW)

    expect(writeRunReport).not.toHaveBeenCalled()
    expect(applyRunLedgerOp).not.toHaveBeenCalled()
    expect(recordRunOutcome).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a run another path closed first is reported as already closed and nothing more', async () => {
    vi.mocked(readRunMessage).mockResolvedValue({ content: '# Bericht', ledger: null })
    vi.mocked(applyRunLedgerOp).mockResolvedValue({ runId: 'run-1', ledger: emptyRunLedger('run-1') })
    vi.mocked(recordRunOutcome).mockResolvedValue({ notified: false, filed: null, closed: false })

    expect(await reconcileRun(makeRun(), CONFIG, NOW)).toBe('already-closed')
  })

  it('writes nothing at all for a job still running', async () => {
    vi.mocked(fetchBackendJobOutcome).mockResolvedValue(outcome({ status: 'running', report: null }))

    expect(await reconcileRun(makeRun(), CONFIG, NOW)).toBe('waiting')
    expect(readRunMessage).not.toHaveBeenCalled()
    expect(recordRunOutcome).not.toHaveBeenCalled()
  })

  it('treats an unreachable backend as a reason to wait, not to fail the run', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(fetchBackendJobOutcome).mockRejectedValue(new Error('ECONNREFUSED'))

    expect(await reconcileRun(makeRun({ startedAt: minutesAgo(10_000) }), CONFIG, NOW)).toBe('waiting')
    expect(recordRunOutcome).not.toHaveBeenCalled()
  })

  it('closes a run with no message of its own through the row alone', async () => {
    vi.mocked(readRunMessage).mockResolvedValue(null)
    expect(await reconcileRun(makeRun({ conversationId: null, runMessageId: null }), CONFIG, NOW)).toBe('closed')
    expect(writeRunReport).not.toHaveBeenCalled()
    expect(applyRunLedgerOp).not.toHaveBeenCalled()
  })

  it('still closes the row when the message refuses a ledger, but not when the ledger write breaks', async () => {
    vi.mocked(readRunMessage).mockResolvedValue({ content: '# Bericht', ledger: null })
    vi.mocked(applyRunLedgerOp).mockRejectedValueOnce(new NotFoundError('no message'))
    expect(await reconcileRun(makeRun(), CONFIG, NOW)).toBe('closed')

    vi.mocked(recordRunOutcome).mockClear()
    vi.mocked(applyRunLedgerOp).mockRejectedValueOnce(new Error('db down'))
    await expect(reconcileRun(makeRun(), CONFIG, NOW)).rejects.toThrow('db down')
    expect(recordRunOutcome).not.toHaveBeenCalled()
  })
})

describe('reconcileStaleRuns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(readRunMessage).mockResolvedValue(null)
    vi.mocked(recordRunOutcome).mockResolvedValue({ notified: true, filed: null, closed: true })
  })

  it('claims under platform access with the stale cutoff, then works each run inside its own organization', async () => {
    const runs = [makeRun({ id: 'a', organizationId: 'org_a' }), makeRun({ id: 'b', organizationId: 'org_b', backendJobId: 'job-b' })]
    vi.mocked(claimRunsToReconcile).mockResolvedValue(runs)
    vi.mocked(fetchBackendJobOutcome).mockImplementation(async (jobId) =>
      jobId === 'job-b' ? outcome({ status: 'running', report: null }) : outcome(),
    )

    const result = await reconcileStaleRuns(NOW, CONFIG)

    expect(withPlatformAccess).toHaveBeenCalledTimes(1)
    expect(claimRunsToReconcile).toHaveBeenCalledWith(minutesAgo(10), 25)
    expect(vi.mocked(withTenant).mock.calls.map(([scope]) => scope)).toEqual([
      { organizationId: 'org_a' },
      { organizationId: 'org_b' },
    ])
    expect(result).toEqual({ checked: 2, closed: 1, alreadyClosed: 0, waiting: 1, failed: 0 })
  })

  it('one run’s failure costs no other run its turn', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(claimRunsToReconcile).mockResolvedValue([makeRun({ id: 'a' }), makeRun({ id: 'b' })])
    vi.mocked(fetchBackendJobOutcome).mockResolvedValue(outcome())
    vi.mocked(recordRunOutcome)
      .mockRejectedValueOnce(new Error('inbox down'))
      .mockResolvedValueOnce({ notified: true, filed: null, closed: true })

    expect(await reconcileStaleRuns(NOW, CONFIG)).toMatchObject({ checked: 2, closed: 1, failed: 1 })
  })

  it('does nothing when nothing is due', async () => {
    vi.mocked(claimRunsToReconcile).mockResolvedValue([])
    expect(await reconcileStaleRuns(NOW, CONFIG)).toEqual({ checked: 0, closed: 0, alreadyClosed: 0, waiting: 0, failed: 0 })
    expect(fetchBackendJobOutcome).not.toHaveBeenCalled()
  })
})
