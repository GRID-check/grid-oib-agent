/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MailImportRequestError, sendMailArchive } from './client'
import type { MailImportUploadPlan } from './types'

function plan(overrides: Partial<MailImportUploadPlan> = {}): MailImportUploadPlan {
  return {
    import: { id: 'imp_1' } as MailImportUploadPlan['import'],
    partSize: 4,
    partCount: 3,
    uploadedParts: [],
    ...overrides,
  }
}

const file = new File([new Uint8Array(10)], 'Büro.pst')

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; size: number | null }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, size: init.body instanceof Blob ? init.body.size : null })
    return handler(url, init)
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sendMailArchive', () => {
  it('sends every part at its size, then completes', async () => {
    const calls = stubFetch((url) => (url.endsWith('/complete') ? Response.json({ id: 'imp_1', status: 'queued' }) : new Response(null, { status: 200 })))
    const progress = vi.fn()

    const view = await sendMailArchive('p1', plan(), file, progress)

    const parts = calls.filter((call) => call.url.includes('/parts/'))
    expect(parts.map((call) => [call.url.split('/').pop(), call.size]).sort()).toEqual([['1', 4], ['2', 4], ['3', 2]])
    expect(calls.at(-1)?.url).toBe('/api/projects/p1/mail-imports/imp_1/complete')
    expect(progress).toHaveBeenCalledWith({ sentBytes: 10, totalBytes: 10, phase: 'sending' })
    expect(progress).toHaveBeenLastCalledWith({ sentBytes: 10, totalBytes: 10, phase: 'joining' })
    expect(view).toMatchObject({ status: 'queued' })
  })

  it('skips the parts the server already holds when resuming', async () => {
    const calls = stubFetch((url) => (url.endsWith('/complete') ? Response.json({}) : new Response(null, { status: 200 })))
    const progress = vi.fn()

    await sendMailArchive('p1', plan({ uploadedParts: [1, 3] }), file, progress)

    expect(calls.filter((call) => call.url.includes('/parts/')).map((call) => call.url.split('/').pop())).toEqual(['2'])
    expect(progress).toHaveBeenNthCalledWith(1, { sentBytes: 6, totalBytes: 10, phase: 'sending' })
  })

  it('sends a part again after a server error', async () => {
    vi.useFakeTimers()
    let failures = 1
    const calls = stubFetch((url) => {
      if (url.endsWith('/complete')) return Response.json({})
      if (url.endsWith('/parts/2') && failures-- > 0) return new Response(null, { status: 503 })
      return new Response(null, { status: 200 })
    })

    const sending = sendMailArchive('p1', plan(), file, () => {})
    await vi.runAllTimersAsync()
    await sending
    expect(calls.filter((call) => call.url.endsWith('/parts/2'))).toHaveLength(2)
    vi.useRealTimers()
  })

  it('keeps a part going through an outage of minutes, and gives up only after its budget', async () => {
    vi.useFakeTimers()
    let failures = 12 // about five minutes of refused connections at the capped backoff
    const calls = stubFetch((url) => {
      if (url.endsWith('/complete')) return Response.json({})
      if (url.endsWith('/parts/1') && failures-- > 0) throw new TypeError('Failed to fetch')
      return new Response(null, { status: 200 })
    })

    const sending = sendMailArchive('p1', plan(), file, () => {})
    await vi.runAllTimersAsync()
    await sending
    expect(calls.filter((call) => call.url.endsWith('/parts/1'))).toHaveLength(13)

    stubFetch((url) => (url.endsWith('/parts/1') ? new Response(null, { status: 503 }) : new Response(null, { status: 200 })))
    const failing = sendMailArchive('p1', plan(), file, () => {})
    const settled = expect(failing).rejects.toMatchObject({ code: 'PART_FAILED', status: 503 })
    await vi.runAllTimersAsync()
    await settled
    vi.useRealTimers()
  })

  it('does not retry a refusal, and carries the server message', async () => {
    stubFetch(() => Response.json({ error: 'Part 1 must be 4 bytes', code: 'BAD_REQUEST' }, { status: 400 }))

    await expect(sendMailArchive('p1', plan({ partCount: 1 }), file, () => {})).rejects.toEqual(
      new MailImportRequestError('Part 1 must be 4 bytes', 400, 'BAD_REQUEST'),
    )
  })
})
