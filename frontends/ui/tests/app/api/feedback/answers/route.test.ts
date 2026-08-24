/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/feedback/service', () => ({
  submitAnswerFeedback: vi.fn(),
  retractAnswerFeedback: vi.fn(),
  getOwnConversationFeedback: vi.fn(),
}))

import { DELETE, GET, POST } from '@/app/api/feedback/answers/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import {
  getOwnConversationFeedback,
  retractAnswerFeedback,
  submitAnswerFeedback,
} from '@/lib/feedback/service'

const mockSession = vi.mocked(requireAuthorizedSession)
const mockSubmit = vi.mocked(submitAnswerFeedback)
const mockRetract = vi.mocked(retractAnswerFeedback)
const mockGetFeedback = vi.mocked(getOwnConversationFeedback)

const session = {
  userId: 'user_1',
  email: 'user@example.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [] as string[],
  featureFlags: null as string[] | null,
}

const base = 'http://localhost/api/feedback/answers'

function postReq(body: unknown): Request {
  return new Request(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSession.mockResolvedValue({ ...session } as never)
})

afterEach(() => {
  delete process.env.GRID_ENFORCE_FEATURE_FLAGS
})

describe('feature gate (answer-feedback)', () => {
  it('returns 403 feature-disabled when enforcement is on and the flag is not granted', async () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    mockSession.mockResolvedValue({ ...session, featureFlags: [] } as never)

    const res = await POST(postReq({ messageId: 'msg_1', verdict: 'up' }))

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'feature-disabled', feature: 'answer-feedback' })
    expect(mockSubmit).not.toHaveBeenCalled()
  })

  it('passes when enforcement is on and the flag is granted', async () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    mockSession.mockResolvedValue({ ...session, featureFlags: ['answer-feedback'] } as never)
    mockSubmit.mockResolvedValue({ messageId: 'msg_1', verdict: 'up', reason: null, comment: null })

    const res = await POST(postReq({ messageId: 'msg_1', verdict: 'up' }))
    expect(res.status).toBe(200)
  })
})

describe('POST /api/feedback/answers', () => {
  it('upserts a vote and returns the stored view', async () => {
    mockSubmit.mockResolvedValue({
      messageId: 'msg_1',
      verdict: 'down',
      reason: 'wrong_source',
      comment: 'the cited clause is from the wrong OIB guideline',
    })

    const res = await POST(
      postReq({
        messageId: 'msg_1',
        verdict: 'down',
        reason: 'wrong_source',
        comment: 'the cited clause is from the wrong OIB guideline',
        conversationId: 'conv_1',
      }),
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      messageId: 'msg_1',
      verdict: 'down',
      reason: 'wrong_source',
      comment: 'the cited clause is from the wrong OIB guideline',
    })
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      expect.objectContaining({
        messageId: 'msg_1',
        verdict: 'down',
        reason: 'wrong_source',
        comment: 'the cited clause is from the wrong OIB guideline',
      }),
    )
  })

  it('rejects an unknown verdict with 400', async () => {
    const res = await POST(postReq({ messageId: 'msg_1', verdict: 'sideways' }))
    expect(res.status).toBe(400)
    expect(mockSubmit).not.toHaveBeenCalled()
  })

  it('rejects an unknown reason key with 400', async () => {
    const res = await POST(postReq({ messageId: 'msg_1', verdict: 'down', reason: 'because' }))
    expect(res.status).toBe(400)
    expect(mockSubmit).not.toHaveBeenCalled()
  })

  it('rejects a missing messageId with 400', async () => {
    const res = await POST(postReq({ verdict: 'up' }))
    expect(res.status).toBe(400)
    expect(mockSubmit).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/feedback/answers', () => {
  it('retracts the vote and returns 204', async () => {
    mockRetract.mockResolvedValue(undefined)

    const res = await DELETE(new Request(`${base}?messageId=msg_1`, { method: 'DELETE' }))

    expect(res.status).toBe(204)
    expect(mockRetract).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1' }), 'msg_1')
  })

  it('rejects a missing messageId with 400', async () => {
    const res = await DELETE(new Request(base, { method: 'DELETE' }))
    expect(res.status).toBe(400)
    expect(mockRetract).not.toHaveBeenCalled()
  })
})

describe('GET /api/feedback/answers', () => {
  it('returns the caller\'s own feedback for a conversation', async () => {
    mockGetFeedback.mockResolvedValue([{ messageId: 'msg_1', verdict: 'up', reason: null, comment: null }])

    const res = await GET(new Request(`${base}?conversationId=conv_1`))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      feedback: [{ messageId: 'msg_1', verdict: 'up', reason: null, comment: null }],
    })
    expect(mockGetFeedback).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user_1' }), 'conv_1')
  })

  it('rejects a missing conversationId with 400', async () => {
    const res = await GET(new Request(base))
    expect(res.status).toBe(400)
    expect(mockGetFeedback).not.toHaveBeenCalled()
  })
})
