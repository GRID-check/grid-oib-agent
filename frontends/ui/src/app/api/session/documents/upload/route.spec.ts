/**
 * @vitest-environment node
 */
/**
 * The upload boundary, where the same caller-supplied `conversationId` decides
 * more than the listing's does: it is the conversation row that may be CREATED,
 * the id the document is filed against, and — through `sessionCollectionName` —
 * the retrieval collection the bytes are ingested into. It used to be checked
 * for being a non-empty string.
 *
 * Deliberately not validated as a UUID: an id is `s_<uuid-with-underscores>`,
 * both columns are `text` on purpose, and a `uuid()` rule would refuse every
 * real upload. See `../conversation-id`.
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
  uploadSessionDocument: vi.fn().mockResolvedValue({
    documentId: 'doc_1',
    jobId: null,
    status: 'uploaded',
    filename: 'plan.pdf',
    collectionName: 's_x',
  }),
}))

import { uploadSessionDocument } from '@/lib/session-documents/service'
import { POST } from './route'

const CONVERSATION_ID = 's_3f2504e0_4f89_11d3_9a0c_0305e82c3301'

function upload(conversationId: string | null, options: { withFile?: boolean } = {}) {
  const body = new FormData()
  if (conversationId !== null) body.set('conversationId', conversationId)
  if (options.withFile !== false) {
    body.set('file', new File(['%PDF-1.7'], 'plan.pdf', { type: 'application/pdf' }))
  }
  return POST(
    new Request('https://grid.example/api/session/documents/upload', { method: 'POST', body })
  )
}

describe('POST /api/session/documents/upload', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts a conversation id of the shape the app actually mints', async () => {
    const response = await upload(CONVERSATION_ID)

    expect(response.status).toBe(200)
    expect(uploadSessionDocument).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
      expect.anything()
    )
  })

  it.each([
    ['a bare word', 'nonsense'],
    ['a hyphenated UUID with no prefix', '3f2504e0-4f89-11d3-9a0c-0305e82c3301'],
    ['an id missing its `s_` prefix', '3f2504e0_4f89_11d3_9a0c_0305e82c3301'],
    ['another shelf’s collection name', 'archiv_org_1'],
    ['a path traversal', 's_../../etc/passwd'],
    ['an empty string', ''],
  ])('rejects %s with 400 before anything is stored', async (_label, id) => {
    const response = await upload(id)

    expect(response.status).toBe(400)
    // Nothing is uploaded to SeaweedFS, no conversation row is created, no
    // collection is written to: the refusal happens before the service runs.
    expect(uploadSessionDocument).not.toHaveBeenCalled()
  })

  it('rejects a missing conversationId field', async () => {
    const response = await upload(null)

    expect(response.status).toBe(400)
    expect(uploadSessionDocument).not.toHaveBeenCalled()
  })

  it('still requires a file', async () => {
    const response = await upload(CONVERSATION_ID, { withFile: false })

    expect(response.status).toBe(400)
    expect(uploadSessionDocument).not.toHaveBeenCalled()
  })
})
