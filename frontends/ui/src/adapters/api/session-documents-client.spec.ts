/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteSessionDocument,
  listSessionDocuments,
  sessionDocumentFileStatus,
} from './session-documents-client'

const CHAT = 's_11111111_2222_4333_8444_555555555555'

describe('session documents client', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['pending', 'ingesting'],
    ['processing', 'ingesting'],
    ['completed', 'success'],
    ['uploaded', 'success'],
    ['failed', 'failed'],
    // Undeclared: at rest, or the poll would never end.
    ['something-new', 'success'],
  ])('reads a document row in status %s as %s', (status, expected) => {
    expect(sessionDocumentFileStatus(status)).toBe(expected)
  })

  it('lists a chat first-party, with the document id as the file id', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        collectionName: CHAT,
        documents: [
          {
            id: 'doc-1',
            filename: 'plan.pdf',
            fileSize: 1200,
            status: 'pending',
            collectionName: CHAT,
            createdAt: '2026-09-27T10:00:00.000Z',
            errorMessage: null,
          },
        ],
      }),
    })

    const files = await listSessionDocuments(CHAT)

    expect(fetchMock).toHaveBeenCalledWith(`/api/session/documents?conversationId=${CHAT}`, {
      signal: undefined,
    })
    expect(files).toEqual([
      expect.objectContaining({
        file_id: 'doc-1',
        file_name: 'plan.pdf',
        collection_name: CHAT,
        status: 'ingesting',
        file_size: 1200,
      }),
    ])
  })

  it('answers null for a conversation the server does not have', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 })

    expect(await listSessionDocuments(CHAT)).toBeNull()
  })

  it('deletes by document id, and an already-gone attachment is success', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 })

    await expect(deleteSessionDocument('doc-1')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/session/documents/doc-1', { method: 'DELETE' })
  })

  it('surfaces the server’s reason when a delete is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: 'Legal hold' } }),
    })

    await expect(deleteSessionDocument('doc-1')).rejects.toThrow('Legal hold')
  })
})
