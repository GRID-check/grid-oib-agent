/**
 * @vitest-environment node
 */
/**
 * `conversationId` is a caller's string, and the listing hands it straight to a
 * database comparison and to a retrieval collection name. `z.string().min(1)`
 * accepted anything that was not empty.
 *
 * What it is NOT validated as is a UUID. That was the review's suggestion and
 * it would reject every id the product mints: a conversation id is
 * `s_<uuid-with-underscores>`, which is why `conversations.id` and
 * `documents.conversation_id` are both `text`. This spec pins both directions —
 * the real shape is accepted, a UUID is not — so the shape cannot quietly be
 * "tightened" into a rule that breaks the feature.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    role: 'member',
    permissions: [],
  }),
  authzErrorResponse: () => null,
}))

vi.mock('@/lib/session-documents/service', () => ({
  listSessionDocuments: vi.fn().mockResolvedValue({ documents: [], collectionName: 's_x' }),
}))

import { listSessionDocuments } from '@/lib/session-documents/service'
import { GET } from './route'

/** The shape all three minting sites produce (`s_${uuid.replace(/-/g, '_')}`). */
const CONVERSATION_ID = 's_3f2504e0_4f89_11d3_9a0c_0305e82c3301'

const list = (conversationId: string) =>
  GET(
    new Request(
      `https://grid.example/api/session/documents?conversationId=${encodeURIComponent(conversationId)}`
    )
  )

describe('GET /api/session/documents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts a conversation id of the shape the app actually mints', async () => {
    const response = await list(CONVERSATION_ID)

    expect(response.status).toBe(200)
    expect(listSessionDocuments).toHaveBeenCalledWith(expect.anything(), CONVERSATION_ID)
  })

  it.each([
    ['a bare word', 'nonsense'],
    ['a hyphenated UUID with no prefix', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['an id missing its `s_` prefix', '3f2504e0_4f89_11d3_9a0c_0305e82c3301'],
    ['a SQL-ish string', "s_1' OR '1'='1"],
    ['a collection name for another shelf', 'proj_3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['a path traversal', 's_../../etc/passwd'],
    ['a truncated id', 's_3f2504e0_4f89_11d3_9a0c_0305e82c33'],
  ])('rejects %s with 400 and never reaches the service', async (_label, id) => {
    const response = await list(id)

    expect(response.status).toBe(400)
    expect(listSessionDocuments).not.toHaveBeenCalled()
  })

  it('does not demand a UUID, which no conversation id is', async () => {
    // The column is `text` deliberately. A `uuid()` rule here would 400 every
    // real request; this asserts the accepted value is precisely the one a
    // uuid rule would refuse.
    const response = await list(CONVERSATION_ID)

    expect(response.status).toBe(200)
    expect(CONVERSATION_ID).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    )
  })
})
