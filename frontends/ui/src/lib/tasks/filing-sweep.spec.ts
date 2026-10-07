/**
 * @vitest-environment node
 *
 * The sweep for report filings left `queued` (ADR-0079): a row never says
 * `queued` for work nothing is doing, and never loses a filing that is still
 * waiting its turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('./repository', () => ({ listRunsWithStaleQueuedFiling: vi.fn(), settleQueuedFiling: vi.fn() }))
vi.mock('@/lib/documents/research-report', () => ({ findFiledResearchReport: vi.fn() }))
vi.mock('@/lib/jobs-queue/repository', () => ({ findOpenJobId: vi.fn(), findDeadJob: vi.fn() }))

import type { TaskRun } from '@/lib/db/schema'
import { getTenantContext } from '@/lib/db/tenant-context'
import { findFiledResearchReport } from '@/lib/documents/research-report'
import { findDeadJob, findOpenJobId } from '@/lib/jobs-queue/repository'
import { FILING_BATCH, FILING_STUCK_AFTER_MINUTES, recoverStuckFilings } from './filing-sweep'
import * as repository from './repository'

const run = (over: Partial<TaskRun> = {}): TaskRun =>
  ({
    id: 'run-1',
    organizationId: 'org_1',
    projectId: 'proj-1',
    backendJobId: 'backend-job-1',
    filingStatus: 'queued',
    ...over,
  }) as TaskRun

const NOW = new Date('2026-10-06T12:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(repository.listRunsWithStaleQueuedFiling).mockResolvedValue([])
  vi.mocked(findOpenJobId).mockResolvedValue(null)
  vi.mocked(findDeadJob).mockResolvedValue(null)
  vi.mocked(findFiledResearchReport).mockResolvedValue(null)
  vi.mocked(repository.settleQueuedFiling).mockResolvedValue({} as TaskRun)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('recoverStuckFilings', () => {
  it('judges only filings that have been queued for a quarter of an hour, a bounded batch', async () => {
    await recoverStuckFilings(NOW)

    expect(repository.listRunsWithStaleQueuedFiling).toHaveBeenCalledWith(
      new Date(NOW.getTime() - FILING_STUCK_AFTER_MINUTES * 60_000),
      FILING_BATCH
    )
  })

  it('leaves a filing alone whose job is still waiting or running', async () => {
    vi.mocked(repository.listRunsWithStaleQueuedFiling).mockResolvedValue([run()])
    vi.mocked(findOpenJobId).mockResolvedValue('job-open')

    const result = await recoverStuckFilings(NOW)

    expect(findOpenJobId).toHaveBeenCalledWith({
      kind: 'file_research_report',
      organizationId: 'org_1',
      matching: { runId: 'backend-job-1' },
    })
    expect(repository.settleQueuedFiling).not.toHaveBeenCalled()
    expect(result).toMatchObject({ checked: 1, waiting: 1, filed: 0, failed: 0 })
  })

  it('says `filed` for a report that turns out to be there, whatever became of its job', async () => {
    vi.mocked(repository.listRunsWithStaleQueuedFiling).mockResolvedValue([run()])
    vi.mocked(findFiledResearchReport).mockResolvedValue({
      documentId: 'doc-9',
      filename: 'bericht.pdf',
      folderId: null,
      alreadyFiled: true,
    })

    const result = await recoverStuckFilings(NOW)

    expect(repository.settleQueuedFiling).toHaveBeenCalledWith('run-1', 'org_1', {
      filingStatus: 'filed',
      filingDetail: null,
      filedDocumentId: 'doc-9',
    })
    expect(result.filed).toBe(1)
  })

  it('says `failed`, with the queue’s own reason, when the job gave up', async () => {
    vi.mocked(repository.listRunsWithStaleQueuedFiling).mockResolvedValue([run()])
    vi.mocked(findDeadJob).mockResolvedValue({ jobId: 'job-dead', lastError: 'object store down' })

    const result = await recoverStuckFilings(NOW)

    expect(repository.settleQueuedFiling).toHaveBeenCalledWith('run-1', 'org_1', {
      filingStatus: 'failed',
      filingDetail: 'the filing job failed every attempt: object store down',
      filedDocumentId: null,
    })
    expect(result.failed).toBe(1)
  })

  it('says `failed` rather than `queued` for a filing nothing is working on and nothing filed', async () => {
    vi.mocked(repository.listRunsWithStaleQueuedFiling).mockResolvedValue([run()])

    await recoverStuckFilings(NOW)

    expect(repository.settleQueuedFiling).toHaveBeenCalledWith(
      'run-1',
      'org_1',
      expect.objectContaining({ filingStatus: 'failed', filingDetail: 'the filing job is gone and the report was never filed' })
    )
  })

  it('judges a run without a backend job id as failed, without asking the queue about nothing', async () => {
    vi.mocked(repository.listRunsWithStaleQueuedFiling).mockResolvedValue([run({ backendJobId: null })])

    await recoverStuckFilings(NOW)

    expect(findOpenJobId).not.toHaveBeenCalled()
    expect(repository.settleQueuedFiling).toHaveBeenCalledWith('run-1', 'org_1', expect.objectContaining({ filingStatus: 'failed' }))
  })

  it('leaves a row alone that the job settled between the read and the write', async () => {
    vi.mocked(repository.listRunsWithStaleQueuedFiling).mockResolvedValue([run()])
    vi.mocked(repository.settleQueuedFiling).mockResolvedValue(null) // no longer `queued`: the job said its own

    const result = await recoverStuckFilings(NOW)

    expect(result).toMatchObject({ checked: 1, filed: 0, failed: 0, settled: 1 })
  })

  it('judges each run inside its own organization, and one failure does not cost the others', async () => {
    vi.mocked(repository.listRunsWithStaleQueuedFiling).mockResolvedValue([
      run({ id: 'a', organizationId: 'org_a' }),
      run({ id: 'b', organizationId: 'org_b' }),
    ])
    const scopes: unknown[] = []
    vi.mocked(findOpenJobId).mockImplementationOnce(async () => {
      throw new Error('database gone')
    })
    vi.mocked(findOpenJobId).mockImplementationOnce(async () => {
      scopes.push(getTenantContext())
      return 'job-open'
    })

    const result = await recoverStuckFilings(NOW)

    expect(scopes).toEqual([expect.objectContaining({ kind: 'tenant', organizationId: 'org_b' })])
    expect(result).toMatchObject({ checked: 2, waiting: 1, errors: 1 })
  })
})
