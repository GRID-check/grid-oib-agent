import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictError } from '@/lib/api/errors'
import { getTenantContext } from '@/lib/db/tenant-context'
import type { BffJobRow } from '@/lib/db/schema'
import { emptyCounts, type ReindexProjectPayload } from './types'

const findClaimedJob = vi.fn()
vi.mock('./repository', () => ({ findClaimedJob: (...args: unknown[]) => findClaimedJob(...args) }))

const runReindexSlice = vi.fn()
const runReingestFailedSlice = vi.fn()
const runBimExtractJob = vi.fn()
const runOfficeRenditionJob = vi.fn()
vi.mock('@/lib/documents/service', () => ({
  runReindexSlice: (...args: unknown[]) => runReindexSlice(...args),
  runReingestFailedSlice: (...args: unknown[]) => runReingestFailedSlice(...args),
  runBimExtractJob: (...args: unknown[]) => runBimExtractJob(...args),
  runOfficeRenditionJob: (...args: unknown[]) => runOfficeRenditionJob(...args),
}))

const runReportFilingJob = vi.fn()
vi.mock('@/lib/tasks/service', () => ({
  runReportFilingJob: (...args: unknown[]) => runReportFilingJob(...args),
}))

const resolvePinnedRequesterSession = vi.fn()
vi.mock('@/lib/auth/pinned-session', () => ({
  resolvePinnedRequesterSession: (...args: unknown[]) => resolvePinnedRequesterSession(...args),
}))

import { runJobSlice } from './run'

const requester = {
  userId: 'user-1',
  email: 'user@example.com',
  organizationMembershipId: 'om-1',
  role: 'admin',
  permissions: ['org:settings:manage'],
}

const payload: ReindexProjectPayload = { projectId: 'p-1', requester, cursor: null, counts: emptyCounts() }

const row = (overrides: Partial<BffJobRow> = {}): BffJobRow => ({
  jobId: 'job-1',
  kind: 'reindex_project',
  lane: 'org-1',
  priority: 1,
  payload,
  status: 'claimed',
  attempts: 1,
  claimedBy: 'w-0',
  claimedAt: new Date(),
  heartbeatAt: new Date(),
  createdAt: new Date(),
  lastError: null,
  notBefore: null,
  deadAt: null,
  ...overrides,
})

beforeEach(() => {
  findClaimedJob.mockReset()
  runReindexSlice.mockReset()
  runReingestFailedSlice.mockReset()
  runBimExtractJob.mockReset()
  runOfficeRenditionJob.mockReset()
  runReportFilingJob.mockReset()
  // Who the identity provider says the requester is today: the role they hold now, not the one they clicked with.
  resolvePinnedRequesterSession.mockReset()
  resolvePinnedRequesterSession.mockImplementation(async ({ userId, email, organizationId }) => ({
    userId,
    email,
    name: null,
    accessToken: '',
    organizationId,
    organizationMembershipId: 'om-now',
    role: 'admin',
    permissions: ['org:settings:manage'],
    featureFlags: null,
  }))
  vi.unstubAllEnvs()
})

describe('runJobSlice', () => {
  it('reads the row only for the worker that holds it, and refuses any other with a 409', async () => {
    findClaimedJob.mockResolvedValue(null)

    await expect(runJobSlice('job-1', 'someone-else')).rejects.toBeInstanceOf(ConflictError)

    expect(findClaimedJob).toHaveBeenCalledWith('job-1', 'someone-else')
    expect(runReindexSlice).not.toHaveBeenCalled()
  })

  it('runs the slice of the row’s kind as the requester, inside the row’s organization', async () => {
    findClaimedJob.mockResolvedValue(row())
    let seenScope: ReturnType<typeof getTenantContext>
    runReindexSlice.mockImplementation(async (_session, state) => {
      seenScope = getTenantContext()
      return { done: false, payload: { ...state, cursor: { createdAt: 'x', id: 'y' } } }
    })

    const outcome = await runJobSlice('job-1', 'w-0')

    expect(outcome.done).toBe(false)
    expect(outcome.payload).toMatchObject({ cursor: { createdAt: 'x', id: 'y' } })
    // The session is the requester's identity in the LANE's organization, as the
    // identity provider has it today (the membership of now, not of the click),
    // with no access token to forward anywhere.
    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith({
      userId: 'user-1',
      email: 'user@example.com',
      organizationId: 'org-1',
    })
    expect(runReindexSlice.mock.calls[0][0]).toMatchObject({
      organizationId: 'org-1',
      userId: 'user-1',
      organizationMembershipId: 'om-now',
      role: 'admin',
      permissions: ['org:settings:manage'],
      accessToken: '',
    })
    expect(seenScope!).toMatchObject({ kind: 'tenant', organizationId: 'org-1' })
    expect(runReingestFailedSlice).not.toHaveBeenCalled()
  })

  it('does not carry on with the rights a requester had when they clicked', async () => {
    findClaimedJob.mockResolvedValue(row())
    resolvePinnedRequesterSession.mockResolvedValue({
      userId: 'user-1',
      email: 'user@example.com',
      name: null,
      accessToken: '',
      organizationId: 'org-1',
      organizationMembershipId: 'om-now',
      role: 'member', // demoted since: the payload still says admin with the permission
      permissions: [],
      featureFlags: null,
    })
    runReindexSlice.mockResolvedValue({ done: true, payload })

    await runJobSlice('job-1', 'w-0')

    expect(runReindexSlice.mock.calls[0][0]).toMatchObject({ role: 'member', permissions: [] })
  })

  it('ends a walk quietly for a requester who is no longer in the organization', async () => {
    findClaimedJob.mockResolvedValue(row({ kind: 'reingest_failed', payload: { requester, cursor: null, counts: emptyCounts() } }))
    resolvePinnedRequesterSession.mockResolvedValue(null)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const outcome = await runJobSlice('job-1', 'w-0')

    expect(outcome.done).toBe(true) // finished, not failed: a retry would be refused the same way
    expect(runReingestFailedSlice).not.toHaveBeenCalled()
    expect(runReindexSlice).not.toHaveBeenCalled()
  })

  it('takes the organization from the lane, never from the payload', async () => {
    findClaimedJob.mockResolvedValue(row({ lane: 'org-lane', payload: { ...payload, requester } }))
    runReindexSlice.mockResolvedValue({ done: true, payload })

    await runJobSlice('job-1', 'w-0')

    expect(runReindexSlice.mock.calls[0][0].organizationId).toBe('org-lane')
  })

  it('dispatches the rescan kind to its own handler', async () => {
    findClaimedJob.mockResolvedValue(
      row({ kind: 'reingest_failed', payload: { requester, cursor: null, counts: emptyCounts() } })
    )
    runReingestFailedSlice.mockResolvedValue({ done: true, payload: {} })

    const outcome = await runJobSlice('job-1', 'w-0')

    expect(outcome.done).toBe(true)
    expect(runReingestFailedSlice).toHaveBeenCalledTimes(1)
    expect(runReindexSlice).not.toHaveBeenCalled()
  })

  it('fails the attempt for a kind it does not know', async () => {
    findClaimedJob.mockResolvedValue(row({ kind: 'make_coffee' }))

    await expect(runJobSlice('job-1', 'w-0')).rejects.toThrow(/No handler for job kind "make_coffee"/)
  })

  describe('the one-step kinds, which run as the system', () => {
    const document = {
      projectId: 'proj-1',
      documentId: 'doc-1',
      filename: 'haus.ifc',
      storageKey: 'org/org-1/project/proj-1/doc/doc-1/haus.ifc',
      storageBucket: null,
      collectionName: 'proj_abc',
    }

    it('runs bim_extract in the lane’s organization and answers done, with no session', async () => {
      findClaimedJob.mockResolvedValue(row({ kind: 'bim_extract', payload: document }))
      let seenScope: ReturnType<typeof getTenantContext>
      runBimExtractJob.mockImplementation(async () => {
        seenScope = getTenantContext()
      })

      const outcome = await runJobSlice('job-1', 'w-0')

      expect(outcome.done).toBe(true)
      expect(runBimExtractJob).toHaveBeenCalledWith('org-1', expect.objectContaining(document), { last: false })
      expect(seenScope!).toMatchObject({ kind: 'tenant', organizationId: 'org-1' })
      expect(runOfficeRenditionJob).not.toHaveBeenCalled()
    })

    it('runs office_rendition with the row’s own file name', async () => {
      findClaimedJob.mockResolvedValue(
        row({ kind: 'office_rendition', payload: { ...document, filename: 'a.docx', fileName: 'a.docx' } })
      )

      const outcome = await runJobSlice('job-1', 'w-0')

      expect(outcome.done).toBe(true)
      expect(runOfficeRenditionJob).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ fileName: 'a.docx' }),
        { last: false }
      )
    })

    it('runs file_research_report for the reader’s identity or the pinned requester alike', async () => {
      const payload = { runId: 'run-1', projectId: 'proj-1', report: '# Bericht', taskRunId: null, requester }
      findClaimedJob.mockResolvedValue(row({ kind: 'file_research_report', payload }))

      expect((await runJobSlice('job-1', 'w-0')).done).toBe(true)
      expect(runReportFilingJob).toHaveBeenCalledWith('org-1', expect.objectContaining(payload), { last: false })

      runReportFilingJob.mockClear()
      findClaimedJob.mockResolvedValue(row({ kind: 'file_research_report', payload: { ...payload, requester: null } }))

      expect((await runJobSlice('job-1', 'w-0')).done).toBe(true)
      expect(runReportFilingJob.mock.calls[0][1].requester).toBeNull()
    })

    it('tells a handler when the attempt it runs is the last one the queue gives', async () => {
      findClaimedJob.mockResolvedValue(row({ kind: 'bim_extract', payload: document, attempts: 3 }))

      await runJobSlice('job-1', 'w-0')
      expect(runBimExtractJob.mock.calls[0][2]).toEqual({ last: true })

      // The runner's own knob, read where the BFF in the same pod can see it.
      vi.stubEnv('GRID_BFF_JOBS_MAX_ATTEMPTS', '5')
      await runJobSlice('job-1', 'w-0')
      expect(runBimExtractJob.mock.calls[1][2]).toEqual({ last: false })
    })

    it('fails the attempt for a payload that does not parse', async () => {
      findClaimedJob.mockResolvedValue(row({ kind: 'bim_extract', payload: { documentId: 'doc-1' } }))

      await expect(runJobSlice('job-1', 'w-0')).rejects.toThrow()

      expect(runBimExtractJob).not.toHaveBeenCalled()
    })

    it('lets a failure of the step reach the runner, which spends the attempt', async () => {
      findClaimedJob.mockResolvedValue(row({ kind: 'bim_extract', payload: document }))
      runBimExtractJob.mockRejectedValue(new Error('object store down'))

      await expect(runJobSlice('job-1', 'w-0')).rejects.toThrow('object store down')
    })
  })

  it('fails the attempt for a payload nobody can read, instead of guessing', async () => {
    findClaimedJob.mockResolvedValue(row({ payload: { projectId: 'p-1' } }))

    await expect(runJobSlice('job-1', 'w-0')).rejects.toThrow()

    expect(runReindexSlice).not.toHaveBeenCalled()
  })
})
