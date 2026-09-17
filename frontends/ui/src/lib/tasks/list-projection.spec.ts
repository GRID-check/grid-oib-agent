/**
 * @vitest-environment node
 */
/**
 * The run summary on a task row: derived the way the block derives it, looked
 * up in ONE bounded query, and only for the rows whose card shows it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/conversations/repository', () => ({ listRunLedgersByMessageIds: vi.fn() }))

import { listRunLedgersByMessageIds } from '@/lib/conversations/repository'
import type { TaskRun } from '@/lib/db/schema'
import type { RunLedger } from '@/lib/runs/run-ledger-types'
import { loadRunSummaries, runSummaryOf, toTaskWireRow } from './list-projection'

const T0 = '2026-09-16T08:00:00.000Z'

const run = (overrides: Partial<TaskRun> = {}): TaskRun =>
  ({
    id: 'run-1',
    definitionId: 'job-1',
    organizationId: 'org_1',
    projectId: 'proj-1',
    kind: 'compliance_check',
    title: 'Normprüfung: Fluchtwege',
    plan: { prompt: 'Prüfe …', goal: 'Fluchtwege prüfen' },
    requesterUserId: 'user_owner',
    requesterEmail: 'owner@grid.test',
    trigger: 'delegated',
    status: 'running',
    backendJobId: 'backend-1',
    conversationId: 's_conv',
    runMessageId: 'msg-1',
    review: null,
    reviewReason: null,
    filedDocumentId: null,
    error: null,
    createdAt: new Date(T0),
    finishedAt: null,
    ...overrides,
  }) as TaskRun

const ledger = (overrides: Partial<RunLedger> = {}): RunLedger => ({
  runId: 'run-1',
  status: 'laeuft',
  phases: [
    { phase: 'planen', startedAt: T0, endedAt: '2026-09-16T08:00:12.000Z' },
    { phase: 'recherchieren', startedAt: '2026-09-16T08:00:12.000Z' },
  ],
  steps: [
    {
      id: 'b1',
      phase: 'recherchieren',
      intent: 'OIB 2 auf Fluchtweglängen prüfen',
      startedAt: '2026-09-16T08:00:20.000Z',
      docs: [
        { name: 'OIB-RL_2.pdf', loci: ['Pkt. 4.2'] },
        { name: 'BO_Wien.pdf', loci: ['§ 108'] },
      ],
    },
    {
      id: 'b2',
      phase: 'recherchieren',
      intent: 'Landesabweichung Wien',
      startedAt: '2026-09-16T08:01:00.000Z',
      docs: [{ name: 'OIB-RL_2.pdf', loci: ['S. 18'], repeat: true }],
    },
  ],
  startedAt: T0,
  updatedAt: '2026-09-16T08:01:00.000Z',
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listRunLedgersByMessageIds).mockResolvedValue(new Map())
})

describe('runSummaryOf', () => {
  it('names the display status and counts rounds and DISTINCT documents', () => {
    expect(runSummaryOf(ledger())).toEqual({ status: 'laeuft', rounds: 2, docs: 2 })
  })

  it('counts nothing for a run that has not started, and nothing for no ledger', () => {
    expect(runSummaryOf(ledger({ phases: [], steps: [], status: 'angelegt' }))).toEqual({
      status: 'angelegt',
      rounds: 0,
      docs: 0,
    })
    expect(runSummaryOf(null)).toBeNull()
  })
})

describe('loadRunSummaries', () => {
  it('looks up every row that has a run message, finished or not, in one query bounded to the page', async () => {
    vi.mocked(listRunLedgersByMessageIds).mockResolvedValue(
      new Map([
        ['msg-1', ledger()],
        ['msg-2', ledger({ status: 'fertig' })],
      ]),
    )

    const summaries = await loadRunSummaries([
      run(),
      run({ id: 'run-2', status: 'succeeded', runMessageId: 'msg-2' }),
      run({ id: 'run-3', status: 'queued', runMessageId: null }),
      run({ id: 'run-4', status: 'queued', runMessageId: 'msg-4' }),
    ])

    expect(listRunLedgersByMessageIds).toHaveBeenCalledTimes(1)
    expect(listRunLedgersByMessageIds).toHaveBeenCalledWith(['msg-1', 'msg-2', 'msg-4'])
    expect(summaries.get('run-1')).toEqual({ status: 'laeuft', rounds: 2, docs: 2 })
    // A finished row keeps its tallies: that is how much work stands behind it.
    expect(summaries.get('run-2')).toEqual({ status: 'fertig', rounds: 2, docs: 2 })
    // A row whose ledger is missing simply has no entry.
    expect(summaries.has('run-4')).toBe(false)
  })

  it('makes no query when nothing on the page has a run message', async () => {
    const summaries = await loadRunSummaries([
      run({ status: 'succeeded', runMessageId: null }),
      run({ id: 'r2', status: 'failed', runMessageId: null }),
    ])

    expect(summaries.size).toBe(0)
    expect(listRunLedgersByMessageIds).not.toHaveBeenCalled()
  })

  it('re-sanitises what the column holds, so a row from another build yields no line', async () => {
    vi.mocked(listRunLedgersByMessageIds).mockResolvedValue(new Map([['msg-1', 'lief gut']]))

    const summaries = await loadRunSummaries([run()])

    expect(summaries.size).toBe(0)
  })
})

describe('toTaskWireRow', () => {
  it('carries the summary, and null when there is none', () => {
    const summary = { status: 'laeuft' as const, phase: 'recherchieren' as const, rounds: 2, docs: 2 }
    expect(toTaskWireRow(run(), 'Anna', summary).runSummary).toEqual(summary)
    expect(toTaskWireRow(run(), 'Anna').runSummary).toBeNull()
  })
})
