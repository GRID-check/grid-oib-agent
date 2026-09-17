/**
 * The browser client for the conversation draft-filing API.
 *
 * One base path, spelled once: the unfiled card files its draft through the
 * BFF (`POST /api/conversations/[id]/draft/file`). A wrong URL or verb here
 * is a button that 404s every draft, so the path, the body and the refusal
 * mapping are pinned, not described — and the same-name 409 must keep its
 * details, because they are what the card's explicit confirmation is about.
 */

import { describe, expect, it, vi } from 'vitest'
import { DraftFileError, fileConversationDraft } from './document-draft-filing'

const FILED = {
  documentId: 'doc-1',
  versionId: 'ver-1',
  state: 'draft',
  alreadyFiled: false,
}

function ok(body: unknown) {
  return { ok: true, status: 201, json: async () => body } as Response
}

function refused(status: number, body: unknown) {
  return { ok: false, status, json: async () => body } as Response
}

describe('fileConversationDraft', () => {
  it('files one draft through the BFF file door, encoded', async () => {
    const run = vi.fn(async (_url: string, _init?: RequestInit) => ok(FILED))

    const filed = await fileConversationDraft(
      's_conv 1',
      { path: '/entwuerfe/a b.md', title: 'A b' },
      run,
    )

    expect(filed).toEqual(FILED)
    const [url, init] = run.mock.calls[0]
    // The conversation id is encoded; the path travels in the body, never as
    // route segments.
    expect(url).toBe('/api/conversations/s_conv%201/draft/file')
    expect(init).toMatchObject({ method: 'POST' })
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      path: '/entwuerfe/a b.md',
      title: 'A b',
      force: false,
    })
  })

  it('sends the explicit confirmation as force', async () => {
    const run = vi.fn(async (_url: string, _init?: RequestInit) => ok({ ...FILED, alreadyFiled: false }))

    await fileConversationDraft('conv-1', { path: '/entwuerfe/a.md', title: 'A', force: true }, run)

    const [, init] = run.mock.calls[0]
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ force: true })
  })

  it('carries a same-name 409 with the existing row for the confirmation', async () => {
    const details = { reason: 'same-name', documentId: 'doc-9', displayName: 'A' }
    const run = vi.fn(async () =>
      refused(409, { error: 'A document with this title is already in the project.', code: 'CONFLICT', details }),
    )

    const failure = await fileConversationDraft('conv-1', { path: '/entwuerfe/a.md', title: 'A' }, run).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(DraftFileError)
    expect(failure as DraftFileError).toMatchObject({ status: 409, code: 'CONFLICT', details })
  })

  it('carries other refusals as typed errors, not thrown Responses', async () => {
    const run = vi.fn(async () => refused(502, { error: 'Upstream service error', code: 'UPSTREAM_ERROR' }))

    const failure = await fileConversationDraft('conv-1', { path: '/entwuerfe/a.md', title: 'A' }, run).catch(
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(DraftFileError)
    expect(failure as DraftFileError).toMatchObject({ status: 502, code: 'UPSTREAM_ERROR' })
  })

  it('refuses a body that is not a filing rather than reporting it', async () => {
    const run = vi.fn(async () => ok({ documentId: 'doc-1' }))

    await expect(
      fileConversationDraft('conv-1', { path: '/entwuerfe/a.md', title: 'A' }, run),
    ).rejects.toThrow()
  })
})
