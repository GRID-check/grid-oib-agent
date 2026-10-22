/**
 * The E-Mail-Eingang's client calls the routes the agent operations name, and
 * hands the UI a refusal's code so it can say what to change.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from './api-error'
import { fileInboundMails, inboundMailPartContentUrl, listInboundMails } from './inbound-mail-client'

afterEach(() => vi.unstubAllGlobals())

describe('the inbound mail client', () => {
  it('lists with only the query it was given', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null })))
    vi.stubGlobal('fetch', fetchMock)
    await listInboundMails('p 1', { status: 'handled', outcome: 'filed' })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p%201/inbound-mails?status=handled&outcome=filed', { signal: undefined })
  })

  it('posts a decision as JSON and surfaces the refusal’s code', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: 'changed', code: 'CONFLICT', details: { reason: 'stale' } }), { status: 409 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const error = await fileInboundMails('p1', { mails: [] }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiRequestError)
    expect(error).toMatchObject({ status: 409, reason: 'stale', message: 'changed' })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/inbound-mails/file', expect.objectContaining({ method: 'POST', body: '{"mails":[]}' }))
  })

  it('links bytes rather than fetching them', () => {
    expect(inboundMailPartContentUrl('p1', 'm1', 'x/y')).toBe('/api/projects/p1/inbound-mails/m1/parts/x%2Fy/content')
  })
})
