/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/platform', () => ({
  requirePlatformPermission: vi.fn(),
}))
vi.mock('@/lib/db/tenant-context', () => ({
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => unknown) => await fn()),
}))
vi.mock('@/lib/organizations/repository', () => ({ findOrganization: vi.fn() }))
vi.mock('./announce', () => ({ announceProductFeedback: vi.fn() }))
vi.mock('./repository', () => ({
  PRODUCT_FEEDBACK_LIST_LIMIT: 2,
  insertProductFeedback: vi.fn(),
  listProductFeedback: vi.fn(),
  getProductFeedback: vi.fn(),
  countProductFeedbackByStatus: vi.fn(),
  updateProductFeedbackStatus: vi.fn(),
}))

import type { AuthorizedSession } from '@/lib/auth/types'
import { requirePlatformPermission } from '@/lib/authz/platform'
import type { ProductFeedback } from '@/lib/db/schema'
import { findOrganization } from '@/lib/organizations/repository'
import { announceProductFeedback } from './announce'
import * as repository from './repository'
import {
  decodeCursor,
  encodeCursor,
  getProductFeedbackForPlatform,
  listProductFeedbackForPlatform,
  submitProductFeedback,
  triageProductFeedback,
} from './service'

const session: AuthorizedSession = {
  userId: 'user_reporter',
  email: 'maria@buero.test',
  name: 'Maria Huber',
  accessToken: 'token',
  organizationId: 'org_tenant',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

const at = new Date('2026-09-29T08:00:00Z')

function stored(overrides: Partial<ProductFeedback> = {}): ProductFeedback & { organizationName: string | null } {
  return {
    id: '7b6a2c1e-0000-4000-8000-000000000001',
    organizationId: 'org_tenant',
    organizationName: 'Büro Nord',
    userId: 'user_reporter',
    userName: 'Maria Huber',
    userEmail: 'maria@buero.test',
    kind: 'bug',
    message: 'Der Upload bleibt bei 99 % stehen.',
    pagePath: '/app/projects',
    context: { viewport: '1440x900' },
    allowContact: true,
    status: 'new',
    triagedBy: null,
    triagedAt: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requirePlatformPermission).mockResolvedValue(undefined)
  vi.mocked(repository.insertProductFeedback).mockResolvedValue(stored())
  vi.mocked(findOrganization).mockResolvedValue({ displayName: 'Büro Nord' } as never)
  vi.mocked(announceProductFeedback).mockResolvedValue({ status: 'announced', recipients: 2 })
  vi.mocked(repository.countProductFeedbackByStatus).mockResolvedValue({
    new: 1,
    in_progress: 0,
    resolved: 0,
    dismissed: 0,
  })
})

describe('submitProductFeedback', () => {
  const input = {
    kind: 'bug' as const,
    message: 'Der Upload bleibt bei 99 % stehen.',
    pagePath: '/app/projects',
    allowContact: true,
    context: { viewport: '1440x900' },
  }

  it('stores the report as the caller, in the caller organization', async () => {
    await submitProductFeedback(session, input)

    expect(repository.insertProductFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_tenant',
        userId: 'user_reporter',
        userName: 'Maria Huber',
        userEmail: 'maria@buero.test',
        kind: 'bug',
      }),
    )
  })

  it('announces the stored report with the organization name, and answers with its id only', async () => {
    const view = await submitProductFeedback(session, input)

    expect(announceProductFeedback).toHaveBeenCalledWith(stored(), 'Büro Nord')
    expect(view).toEqual({ id: stored().id, kind: 'bug', createdAt: at.toISOString() })
  })

  it('still announces when the organization row cannot be read', async () => {
    vi.mocked(findOrganization).mockRejectedValue(new Error('boom'))

    await submitProductFeedback(session, input)

    expect(announceProductFeedback).toHaveBeenCalledWith(stored(), null)
  })
})

describe('the platform half is gated in the service, not only on the route', () => {
  it('reads with settings:view', async () => {
    vi.mocked(repository.listProductFeedback).mockResolvedValue([])
    await listProductFeedbackForPlatform(session, {})
    expect(requirePlatformPermission).toHaveBeenCalledWith(session, 'platform:settings:view')
  })

  it('triages with settings:manage and refuses before touching a row', async () => {
    vi.mocked(requirePlatformPermission).mockRejectedValue(new Error('denied'))

    await expect(triageProductFeedback(session, stored().id, 'resolved')).rejects.toThrow('denied')
    expect(requirePlatformPermission).toHaveBeenCalledWith(session, 'platform:settings:manage')
    expect(repository.updateProductFeedbackStatus).not.toHaveBeenCalled()
  })

  it('attributes a triage to the caller', async () => {
    vi.mocked(repository.updateProductFeedbackStatus).mockResolvedValue(stored({ status: 'resolved' }))
    vi.mocked(repository.getProductFeedback).mockResolvedValue(
      stored({ status: 'resolved', triagedBy: 'maria@buero.test', triagedAt: at }),
    )

    const view = await triageProductFeedback(session, stored().id, 'resolved')

    expect(repository.updateProductFeedbackStatus).toHaveBeenCalledWith(
      stored().id,
      'resolved',
      'maria@buero.test',
    )
    expect(view.status).toBe('resolved')
  })

  it('answers not found for an unknown report', async () => {
    vi.mocked(repository.getProductFeedback).mockResolvedValue(null)
    await expect(getProductFeedbackForPlatform(session, stored().id)).rejects.toThrow(/Unknown/)
  })
})

describe('the triage view', () => {
  it('withholds the address of a reporter who did not agree to be contacted', async () => {
    vi.mocked(repository.getProductFeedback).mockResolvedValue(stored({ allowContact: false }))

    const view = await getProductFeedbackForPlatform(session, stored().id)

    expect(view.reporter).toEqual({ userId: 'user_reporter', name: 'Maria Huber', email: null })
  })
})

describe('paging', () => {
  it('hands out a cursor only when the page is full', async () => {
    vi.mocked(repository.listProductFeedback).mockResolvedValue([stored(), stored({ id: 'b'.repeat(8) + '-0000-4000-8000-000000000002' })])
    const full = await listProductFeedbackForPlatform(session, {})
    expect(full.nextCursor).not.toBeNull()

    vi.mocked(repository.listProductFeedback).mockResolvedValue([stored()])
    const partial = await listProductFeedbackForPlatform(session, {})
    expect(partial.nextCursor).toBeNull()
  })

  it('round-trips a cursor and rejects junk', () => {
    const cursor = encodeCursor(stored())
    expect(decodeCursor(cursor)).toEqual({ createdAt: at, id: stored().id })
    expect(decodeCursor('not-a-cursor')).toBeUndefined()
    expect(decodeCursor(`${at.toISOString()}|'; drop table`)).toBeUndefined()
  })
})
