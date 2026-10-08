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
    await listConversations(listRequest('?q=%20100%25%20'))
    expect(listProfiledConversations).toHaveBeenLastCalledWith('100%')
    await listConversations(listRequest('?q=%20%20'))
    expect(listProfiledConversations).toHaveBeenLastCalledWith(undefined)
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
