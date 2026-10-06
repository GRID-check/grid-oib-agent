import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConflictError } from '@/lib/api/errors'
import { getTenantContext } from '@/lib/db/tenant-context'
import type { BffJobRow } from '@/lib/db/schema'
import { emptyCounts, type ReindexProjectPayload } from './types'

const findClaimedJob = vi.fn()
vi.mock('./repository', () => ({ findClaimedJob: (...args: unknown[]) => findClaimedJob(...args) }))

const runReindexSlice = vi.fn()
const runReingestFailedSlice = vi.fn()
vi.mock('@/lib/documents/service', () => ({
  runReindexSlice: (...args: unknown[]) => runReindexSlice(...args),
  runReingestFailedSlice: (...args: unknown[]) => runReingestFailedSlice(...args),
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
  ...overrides,
})

beforeEach(() => {
  findClaimedJob.mockReset()
  runReindexSlice.mockReset()
  runReingestFailedSlice.mockReset()
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
    // The session is the requester's identity in the LANE's organization, with
    // no access token to forward anywhere.
    expect(runReindexSlice.mock.calls[0][0]).toMatchObject({
      organizationId: 'org-1',
      userId: 'user-1',
      organizationMembershipId: 'om-1',
      role: 'admin',
      permissions: ['org:settings:manage'],
      accessToken: '',
    })
    expect(seenScope!).toMatchObject({ kind: 'tenant', organizationId: 'org-1' })
    expect(runReingestFailedSlice).not.toHaveBeenCalled()
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
    findClaimedJob.mockResolvedValue(row({ kind: 'bim_extract' }))

    await expect(runJobSlice('job-1', 'w-0')).rejects.toThrow(/No handler for job kind "bim_extract"/)
  })

  it('fails the attempt for a payload nobody can read, instead of guessing', async () => {
    findClaimedJob.mockResolvedValue(row({ payload: { projectId: 'p-1' } }))

    await expect(runJobSlice('job-1', 'w-0')).rejects.toThrow()

    expect(runReindexSlice).not.toHaveBeenCalled()
  })
})
