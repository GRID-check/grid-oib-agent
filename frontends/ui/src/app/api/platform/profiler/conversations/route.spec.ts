/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const isOwner = { value: false }

vi.mock('@/lib/auth/session', () => ({
  getGridSession: vi.fn().mockResolvedValue({ userId: 'user_1', organizationId: 'org_1' }),
}))

vi.mock('@/lib/authz/platform', () => {
  // Defined inside the factory: vi.mock is hoisted above module-level classes.
  class PlatformAccessDeniedError extends Error {
    readonly status = 403
  }
  return {
    PlatformAccessDeniedError,
    requirePlatformPermission: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) throw new PlatformAccessDeniedError()
    }),
  }
})

vi.mock('@/lib/profiler/service', () => ({
  listProfiledConversations: vi.fn().mockResolvedValue({
    capped: false,
    conversations: [
      {
        conversationId: 'conv_1',
        organizationId: 'org_1',
        organizationName: 'Bauwerk GmbH',
        title: 'Bauantrag Wien',
        turnCount: 2,
        totalDurationMs: 4200,
        lastActiveAt: '2026-01-01T00:00:02.000Z',
      },
    ],
  }),
  getConversationTimeline: vi.fn().mockResolvedValue({
    conversationId: 'conv_1',
    turns: [],
    totalTurns: 80,
    capped: true,
  }),
}))

import { GET as listConversations } from './route'
import { GET as getTimeline } from './[conversationId]/route'
import { getConversationTimeline, listProfiledConversations } from '@/lib/profiler/service'

const listRequest = (query = ''): Request =>
  new Request(`http://localhost/api/platform/profiler/conversations${query}`)

const timelineContext = (conversationId: string) => ({
  params: Promise.resolve({ conversationId }),
})

describe('GET /api/platform/profiler/conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner.value = false
  })

  it('rejects callers without the platform permission', async () => {
    expect((await listConversations(listRequest())).status).toBe(403)
    expect(listProfiledConversations).not.toHaveBeenCalled()
  })

  it('returns the directory, organization names included', async () => {
    isOwner.value = true
    const res = await listConversations(listRequest())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.capped).toBe(false)
    expect(body.conversations[0]).toMatchObject({
      conversationId: 'conv_1',
      organizationName: 'Bauwerk GmbH',
    })
  })

  it('passes a trimmed search query through, and none for a blank one', async () => {
    isOwner.value = true
    await listConversations(listRequest('?from=2026-09-01&to=2026-09-30&q=%20100%25%20'))
    expect(listProfiledConversations).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-09-01' }),
      { query: '100%', conversationId: undefined }
    )
    await listConversations(listRequest('?from=2026-09-01&to=2026-09-30&q=%20%20'))
    expect(listProfiledConversations).toHaveBeenLastCalledWith(expect.anything(), {
      query: undefined,
      conversationId: undefined,
    })
  })

  it('passes the scope and the selected conversation through', async () => {
    isOwner.value = true
    await listConversations(
      listRequest(
        '?from=2026-09-01&to=2026-09-30&org=org_1&project=p_1&project=p_2&conversation=conv_1'
      )
    )
    expect(listProfiledConversations).toHaveBeenLastCalledWith(
      {
        from: '2026-09-01',
        to: '2026-09-30',
        organizationIds: ['org_1'],
        projectIds: ['p_1', 'p_2'],
      },
      { query: undefined, conversationId: 'conv_1' }
    )
  })

  it('reads the default range when none is given, so older callers keep working', async () => {
    isOwner.value = true
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T15:00:00Z'))
    try {
      expect((await listConversations(listRequest())).status).toBe(200)
      expect(listProfiledConversations).toHaveBeenLastCalledWith(
        { from: '2026-09-10', to: '2026-10-09', organizationIds: [], projectIds: [] },
        { query: undefined, conversationId: undefined }
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a bad range with 400 and its code', async () => {
    isOwner.value = true
    const res = await listConversations(listRequest('?from=2026-02-30&to=2026-03-01'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      code: 'BAD_REQUEST',
      details: { scope: 'invalid_from' },
    })
    expect(listProfiledConversations).not.toHaveBeenCalled()
  })
})

describe('GET /api/platform/profiler/conversations/[conversationId]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner.value = false
  })

  it('rejects callers without the platform permission', async () => {
    const res = await getTimeline(new Request('http://localhost/x'), timelineContext('conv_1'))
    expect(res.status).toBe(403)
    expect(getConversationTimeline).not.toHaveBeenCalled()
  })

  it('returns the bounded timeline with its cap flag', async () => {
    isOwner.value = true
    const res = await getTimeline(new Request('http://localhost/x'), timelineContext('conv_1'))
    expect(res.status).toBe(200)
    expect(getConversationTimeline).toHaveBeenCalledWith('conv_1')
    expect(await res.json()).toMatchObject({
      conversationId: 'conv_1',
      totalTurns: 80,
      capped: true,
    })
  })
})
