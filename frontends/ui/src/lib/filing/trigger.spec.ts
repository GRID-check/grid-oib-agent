/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: (_scope: unknown, run: () => unknown) => run() }))

import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { enqueueJob } from '@/lib/jobs-queue/enqueue'
import { filingSuggestionsEnabled, queueFilingReview, queueFilingReviewsAfterSettle } from './trigger'

const SESSION = {
  userId: 'uploader',
  email: 'a@buero.at',
  name: null,
  accessToken: '',
  organizationId: 'org-1',
  organizationMembershipId: 'om-1',
  role: 'member',
  permissions: ['project:documents:write'],
  featureFlags: null,
}

const BATCH = { id: '00000000-0000-4000-8000-0000000000b1', scope: 'project' as const, createdBy: 'uploader', reviewsFiling: true }

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(SESSION)
})

describe('queueFilingReview', () => {
  it('queues the name review at the seal as the uploader, ahead of bulk work', async () => {
    expect(await queueFilingReview('org-1', BATCH, 'name')).toBe(true)
    expect(enqueueJob).toHaveBeenCalledWith({
      kind: 'filing_review',
      organizationId: 'org-1',
      payload: {
        batchId: BATCH.id,
        basis: 'name',
        requester: {
          userId: 'uploader',
          email: 'a@buero.at',
          organizationMembershipId: 'om-1',
          role: 'member',
          permissions: ['project:documents:write'],
        },
      },
      priority: 0,
    })
  })

  it('queues one content review per settled batch, as bulk work', async () => {
    await queueFilingReviewsAfterSettle('org-1', [BATCH, { ...BATCH, id: '00000000-0000-4000-8000-0000000000b2' }])
    expect(vi.mocked(enqueueJob).mock.calls.map(([job]) => [job.payload, job.priority])).toEqual([
      [expect.objectContaining({ basis: 'content' }), 1],
      [expect.objectContaining({ basis: 'content' }), 1],
    ])
  })

  it('queues nothing for a chat’s attachments, a person who left, or a deployment that switched it off', async () => {
    expect(await queueFilingReview('org-1', { ...BATCH, scope: 'session' }, 'name')).toBe(false)
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValueOnce(null)
    expect(await queueFilingReview('org-1', BATCH, 'name')).toBe(false)
    vi.stubEnv('GRID_FILING_SUGGESTIONS', 'off')
    expect(await queueFilingReview('org-1', BATCH, 'name')).toBe(false)
    expect(enqueueJob).not.toHaveBeenCalled()
  })

  // Migration 0185: a batch a person placed on purpose (a mail they filed) is
  // not re-judged, at the seal or at the settle, and its neighbours still are.
  it('queues neither review for a batch opened without filing reviews', async () => {
    const quiet = { ...BATCH, id: '00000000-0000-4000-8000-0000000000b3', reviewsFiling: false }
    expect(await queueFilingReview('org-1', quiet, 'name')).toBe(false)
    expect(await queueFilingReview('org-1', quiet, 'content')).toBe(false)
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()

    await queueFilingReviewsAfterSettle('org-1', [quiet, BATCH])
    expect(vi.mocked(enqueueJob).mock.calls.map(([job]) => (job.payload as { batchId: string }).batchId)).toEqual([BATCH.id])
  })

  it('never throws into the upload when the queue refuses', async () => {
    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error('db down'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await queueFilingReview('org-1', BATCH, 'name')).toBe(false)
  })

  it('is on unless switched off', () => {
    expect(filingSuggestionsEnabled({})).toBe(true)
    expect(filingSuggestionsEnabled({ GRID_FILING_SUGGESTIONS: 'OFF' })).toBe(false)
    expect(filingSuggestionsEnabled({ GRID_FILING_SUGGESTIONS: 'on' })).toBe(true)
  })
})
