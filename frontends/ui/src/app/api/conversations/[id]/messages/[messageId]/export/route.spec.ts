/**
 * @vitest-environment node
 *
 * The answer-download route.
 *
 * Nothing here is about the document's contents (that is
 * `lib/answer-export/answer-document.spec.ts`) or about who may have it (that is
 * `lib/answer-export/service.spec.ts`). Two things have to hold at this layer:
 * the response must present as a FILE — a browser that renders the bytes inline
 * has silently lost the export — and the ids in the URL must reach the service
 * unchanged, because an export served for the wrong message id is an answer
 * about a different building.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user-1',
    organizationId: 'org-1',
    email: 'planer@example.at',
    role: 'admin',
  }),
}))

vi.mock('@/lib/answer-export/service', () => ({
  exportAnswerDocument: vi.fn().mockResolvedValue({
    filename: 'fluchtwege-bauteil-b-2026-05-04.docx',
    bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    mediaType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }),
}))

import { GET } from './route'
import { exportAnswerDocument } from '@/lib/answer-export/service'

const MESSAGE_ID = '11111111-2222-4333-8444-555555555555'

const call = (messageId: string): Promise<Response> =>
  GET(
    new Request(
      `https://grid.test/api/conversations/conv-1/messages/${messageId}/export`
    ),
    { params: Promise.resolve({ id: 'conv-1', messageId }) }
  )

beforeEach(() => vi.clearAllMocks())

describe('GET /api/conversations/[id]/messages/[messageId]/export', () => {
  it('serves the document as a download named after the thread', async () => {
    const response = await call(MESSAGE_ID)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="fluchtwege-bauteil-b-2026-05-04.docx"'
    )
    // The answer can change after this file was built (a card answered,
    // provenance recorded), so a cached copy would disagree with its thread.
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    )
  })

  it('passes both ids through to the service unchanged', async () => {
    await call(MESSAGE_ID)

    expect(exportAnswerDocument).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
      'conv-1',
      MESSAGE_ID
    )
  })

  it('400s a malformed message id instead of letting it reach SQL', async () => {
    const response = await call('not-a-uuid')

    expect(response.status).toBe(400)
    expect(exportAnswerDocument).not.toHaveBeenCalled()
  })
})
