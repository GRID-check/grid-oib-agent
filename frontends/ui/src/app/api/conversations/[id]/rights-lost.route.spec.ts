/**
 * @vitest-environment node
 */
/**
 * What a chat the reader may no longer read answers over HTTP (ADR-0088): the
 * detail and the messages routes return the typed 403, and nothing of the chat.
 *
 * The client tells this refusal from "not found" and from any other 403 by
 * `code` and `details.reason`, so the envelope is the contract pinned here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const requireAuthorizedSession = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: () => requireAuthorizedSession(),
}))
vi.mock('server-only', () => ({}))

const service = vi.hoisted(() => ({
  getConversation: vi.fn(),
  listConversationMessages: vi.fn(),
}))
vi.mock('@/lib/conversations/service', () => ({
  getConversation: (...args: unknown[]) => service.getConversation(...args),
  listConversationMessages: (...args: unknown[]) => service.listConversationMessages(...args),
  createConversationMessages: vi.fn(),
  deleteConversation: vi.fn(),
  updateConversationEngagement: vi.fn(),
  updateConversationTitle: vi.fn(),
}))

import { ResourceRightsLostError } from '@/lib/api/errors'
import { GET as getDetail } from './route'
import { GET as getMessages } from './messages/route'

const context = { params: Promise.resolve({ id: 's_secret' }) }
const request = (path: string): Request => new Request(`https://grid.test/api/conversations/s_secret${path}`)

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthorizedSession.mockResolvedValue({
    userId: 'user_me',
    organizationId: 'org_1',
    organizationMembershipId: 'om_1',
    role: 'member',
    permissions: [],
  })
  service.getConversation.mockRejectedValue(new ResourceRightsLostError('conversation'))
  service.listConversationMessages.mockRejectedValue(new ResourceRightsLostError('conversation'))
})

describe.each([
  ['the detail', () => getDetail(request(''), context)],
  ['the messages', () => getMessages(request('/messages'), context)],
])('GET %s of a chat the reader may no longer read', (_name, call) => {
  it('is a typed 403, distinguishable from "not found" and from a missing permission', async () => {
    const response = await call()

    expect(response.status).toBe(403)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      code: 'RESOURCE_RIGHTS_LOST',
      details: { reason: 'rights-lost', resourceType: 'conversation' },
    })
  })

  it('carries nothing of the chat: no title, no message, no folder', async () => {
    const body = JSON.stringify(await (await call()).json())

    expect(body).not.toMatch(/title|folder|Honorar|Müller/i)
  })
})
