/**
 * @vitest-environment node
 *
 * The office → PDF rendition (ADR-0070). The object's existence is its only
 * state, so these pin the three things that make that safe: an existing
 * rendition is reused and never re-converted, a failed conversion writes
 * nothing, and concurrent readers share one conversion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'

vi.mock('server-only', () => ({}))

const send = vi.hoisted(() => vi.fn())
vi.mock('@/lib/s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/s3')>()),
  s3Client: { send: (...args: unknown[]) => send(...args) },
}))

import { NotFoundError } from '@/lib/api/errors'
import {
  RenditionFailedError,
  RenditionUnavailableError,
  ensureRendition,
  extractsFromRendition,
  isRenditionEnabled,
} from './rendition'

const INPUT = {
  bucket: 'test-bucket',
  storageKey: 'org/org-1/project/proj-1/doc/doc-1/v1/Baubeschreibung.docx',
  filename: 'Baubeschreibung.docx',
}
const RENDITION_KEY = 'org/org-1/project/proj-1/doc/doc-1/v1/_render.pdf'
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n…')
const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04])

const commands = () => send.mock.calls.map(([command]) => command as unknown)
const puts = () => commands().filter((c): c is PutObjectCommand => c instanceof PutObjectCommand)

/** No rendition yet; the original is readable. */
const storeWithoutRendition = () => {
  send.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) throw Object.assign(new Error('NotFound'), { name: 'NotFound' })
    if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => DOCX_BYTES } }
    return {}
  })
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubEnv('GOTENBERG_URL', 'http://gotenberg:3000/')
  fetchSpy = vi.fn().mockResolvedValue(new Response(PDF_BYTES, { status: 200 }))
  vi.stubGlobal('fetch', fetchSpy)
  storeWithoutRendition()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('isRenditionEnabled', () => {
  it('follows GOTENBERG_URL', () => {
    expect(isRenditionEnabled()).toBe(true)
    vi.stubEnv('GOTENBERG_URL', '')
    expect(isRenditionEnabled()).toBe(false)
    vi.stubEnv('GOTENBERG_URL', '   ')
    expect(isRenditionEnabled()).toBe(false)
  })
})

describe('extractsFromRendition', () => {
  // The list itself is `preview-types.spec.ts`'s subject. Pinned here is the
  // one boundary the dispatch turns on: Word and decks read the PDF, a modern
  // workbook keeps its structure-preserving extractor (ADR-0071).
  it('sends Word and presentation files to the rendition and keeps .xlsx on its own extractor', () => {
    expect(extractsFromRendition('Baubeschreibung.docx')).toBe(true)
    expect(extractsFromRendition('piloti/doc-1/Präsentation.PPTX')).toBe(true)
    expect(extractsFromRendition('Kosten.xlsx')).toBe(false)
    expect(extractsFromRendition('Kosten.xlsm')).toBe(false)
    expect(extractsFromRendition('plan.pdf')).toBe(false)
  })
})

describe('ensureRendition', () => {
  it('converts the original through Gotenberg and stores the PDF beside it', async () => {
    await expect(ensureRendition(INPUT)).resolves.toBe(RENDITION_KEY)

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://gotenberg:3000/forms/libreoffice/convert')
    expect(init.method).toBe('POST')
    // LibreOffice picks its import filter by extension, so the original name
    // must travel with the bytes.
    const file = (init.body as FormData).get('files') as File
    expect(file.name).toBe('Baubeschreibung.docx')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(DOCX_BYTES)

    const [put] = puts()
    expect(put.input).toMatchObject({ Bucket: 'test-bucket', Key: RENDITION_KEY, ContentType: 'application/pdf' })
    expect(put.input.Body).toEqual(PDF_BYTES)
  })

  it('reuses a rendition that already exists and never calls the converter', async () => {
    send.mockResolvedValue({ ContentLength: 1024 })

    await expect(ensureRendition(INPUT)).resolves.toBe(RENDITION_KEY)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(puts()).toHaveLength(0)
  })

  it('treats an empty object as no rendition and converts again', async () => {
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) return { ContentLength: 0 }
      if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => DOCX_BYTES } }
      return {}
    })

    await ensureRendition(INPUT)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(puts()).toHaveLength(1)
  })

  it('shares one conversion between concurrent callers for the same key', async () => {
    const [a, b] = await Promise.all([ensureRendition(INPUT), ensureRendition(INPUT)])
    expect(a).toBe(RENDITION_KEY)
    expect(b).toBe(RENDITION_KEY)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(puts()).toHaveLength(1)
  })

  it('names the last path segment only, so a Piloti name with slashes stays one part', async () => {
    await ensureRendition({ ...INPUT, filename: 'piloti/doc-1/bericht.docx' })
    const file = ((fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as FormData).get('files') as File
    expect(file.name).toBe('bericht.docx')
  })

  it('is unavailable when conversion is not configured, and touches nothing', async () => {
    vi.stubEnv('GOTENBERG_URL', '')
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(RenditionUnavailableError)
    expect(send).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('is unavailable for a key with no directory to put a sibling in', async () => {
    await expect(ensureRendition({ ...INPUT, storageKey: 'Baubeschreibung.docx' })).rejects.toBeInstanceOf(
      RenditionUnavailableError,
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('fails, and writes nothing, when Gotenberg answers an error', async () => {
    fetchSpy.mockResolvedValue(new Response('LibreOffice crashed', { status: 503 }))
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(RenditionFailedError)
    expect(puts()).toHaveLength(0)
  })

  it('fails when Gotenberg does not answer at all (timeout, refused)', async () => {
    fetchSpy.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(RenditionFailedError)
    expect(puts()).toHaveLength(0)
  })

  it('refuses to store a 200 whose body is not a PDF', async () => {
    fetchSpy.mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }))
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(RenditionFailedError)
    expect(puts()).toHaveLength(0)
  })

  it('is a 404 when the original itself is gone', async () => {
    send.mockImplementation(async (command: unknown) => {
      if (command instanceof GetObjectCommand) throw new Error('NoSuchKey')
      throw Object.assign(new Error('NotFound'), { name: 'NotFound' })
    })
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(NotFoundError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('runs again after a failure — the in-flight entry does not outlive it', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('down', { status: 502 }))
    await expect(ensureRendition(INPUT)).rejects.toBeInstanceOf(RenditionFailedError)
    await expect(ensureRendition(INPUT)).resolves.toBe(RENDITION_KEY)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})

/** A promise and the handle that settles it, for a converter the test answers by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const inputFor = (name: string) => ({
  bucket: 'test-bucket',
  storageKey: `org/org-1/project/proj-1/doc/${name}/v1/${name}.docx`,
  filename: `${name}.docx`,
})

/**
 * A reindex or a folder upload starts hundreds of conversions at once, and
 * Gotenberg runs LibreOffice one at a time with a timeout that counts its own
 * queue. The bound keeps that queue here, where waiting costs no timeout.
 */
describe('ensureRendition under a burst', () => {
  it('runs at most GOTENBERG_MAX_CONCURRENCY conversions at once, and every queued one still succeeds', async () => {
    vi.stubEnv('GOTENBERG_MAX_CONCURRENCY', '2')
    const answers: Array<ReturnType<typeof deferred<Response>>> = []
    let running = 0
    let peak = 0
    fetchSpy.mockImplementation(async () => {
      running += 1
      peak = Math.max(peak, running)
      const answer = deferred<Response>()
      answers.push(answer)
      const response = await answer.promise
      running -= 1
      return response
    })
    const timeouts = vi.spyOn(AbortSignal, 'timeout')

    const burst = Array.from({ length: 7 }, (_, i) => ensureRendition(inputFor(`burst-${i}`)))
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    // The five still queued have not started their clock: a timeout is made
    // only for a request that reaches Gotenberg.
    expect(timeouts).toHaveBeenCalledTimes(2)

    for (let answered = 0; answered < 7; answered += 1) {
      await vi.waitFor(() => expect(answers.length).toBeGreaterThan(answered))
      answers[answered].resolve(new Response(PDF_BYTES, { status: 200 }))
    }

    const keys = await Promise.all(burst)
    expect(keys).toHaveLength(7)
    expect(peak).toBe(2)
    expect(fetchSpy).toHaveBeenCalledTimes(7)
    expect(timeouts).toHaveBeenCalledTimes(7)
    expect(puts()).toHaveLength(7)
    timeouts.mockRestore()
  })

  it('defaults to two at once', async () => {
    const answers: Array<ReturnType<typeof deferred<Response>>> = []
    fetchSpy.mockImplementation(() => {
      const answer = deferred<Response>()
      answers.push(answer)
      return answer.promise
    })

    const burst = Array.from({ length: 4 }, (_, i) => ensureRendition(inputFor(`default-${i}`)))
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 10))
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    for (let answered = 0; answered < 4; answered += 1) {
      await vi.waitFor(() => expect(answers.length).toBeGreaterThan(answered))
      answers[answered].resolve(new Response(PDF_BYTES, { status: 200 }))
    }
    await expect(Promise.all(burst)).resolves.toHaveLength(4)
  })

  it('frees the slot when a conversion fails, so the queue behind it moves on', async () => {
    vi.stubEnv('GOTENBERG_MAX_CONCURRENCY', '1')
    fetchSpy.mockResolvedValueOnce(new Response('down', { status: 503 }))

    const [first, second] = await Promise.allSettled([
      ensureRendition(inputFor('free-0')),
      ensureRendition(inputFor('free-1')),
    ])
    expect(first.status).toBe('rejected')
    expect(second).toEqual({ status: 'fulfilled', value: 'org/org-1/project/proj-1/doc/free-1/v1/_render.pdf' })
  })

  it('puts a reader ahead of the background conversions waiting for a slot', async () => {
    vi.stubEnv('GOTENBERG_MAX_CONCURRENCY', '1')
    const answers: Array<ReturnType<typeof deferred<Response>>> = []
    const order: string[] = []
    fetchSpy.mockImplementation((_url: string, init: RequestInit) => {
      order.push(((init.body as FormData).get('files') as File).name)
      const answer = deferred<Response>()
      answers.push(answer)
      return answer.promise
    })

    const background = [0, 1, 2].map((i) => ensureRendition(inputFor(`queue-${i}`)))
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    const reader = ensureRendition(inputFor('queue-reader'), { readerWaitMs: 60_000 })

    for (let answered = 0; answered < 4; answered += 1) {
      await vi.waitFor(() => expect(answers.length).toBeGreaterThan(answered))
      answers[answered].resolve(new Response(PDF_BYTES, { status: 200 }))
    }
    await Promise.all([...background, reader])
    expect(order).toEqual(['queue-0.docx', 'queue-reader.docx', 'queue-1.docx', 'queue-2.docx'])
  })
})

/**
 * The preview and file routes wait inside a request Cloudflare cuts at ~100s,
 * and a file LibreOffice cannot read is not converted again on every open.
 */
describe('ensureRendition for a reader', () => {
  it('stops waiting after readerWaitMs, while the conversion finishes and is stored for the next open', async () => {
    const answer = deferred<Response>()
    fetchSpy.mockReturnValue(answer.promise)
    const input = inputFor('slow')

    await expect(ensureRendition(input, { readerWaitMs: 20 })).rejects.toBeInstanceOf(RenditionFailedError)
    expect(puts()).toHaveLength(0)

    // The same conversion goes on: a second reader joins it rather than starting another.
    const next = ensureRendition(input, { readerWaitMs: 60_000 })
    answer.resolve(new Response(PDF_BYTES, { status: 200 }))
    await expect(next).resolves.toBe('org/org-1/project/proj-1/doc/slow/v1/_render.pdf')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(puts()).toHaveLength(1)
  })

  it('answers a recent failure at once instead of converting again', async () => {
    const input = inputFor('broken')
    fetchSpy.mockResolvedValue(new Response('cannot convert', { status: 400 }))

    await expect(ensureRendition(input, { readerWaitMs: 60_000 })).rejects.toBeInstanceOf(RenditionFailedError)
    await expect(ensureRendition(input, { readerWaitMs: 60_000 })).rejects.toBeInstanceOf(RenditionFailedError)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('still serves a rendition that appeared since the failure (another replica made it)', async () => {
    const input = inputFor('elsewhere')
    fetchSpy.mockResolvedValueOnce(new Response('down', { status: 503 }))
    await expect(ensureRendition(input, { readerWaitMs: 60_000 })).rejects.toBeInstanceOf(RenditionFailedError)

    send.mockResolvedValue({ ContentLength: 1024 })
    await expect(ensureRendition(input, { readerWaitMs: 60_000 })).resolves.toBe(
      'org/org-1/project/proj-1/doc/elsewhere/v1/_render.pdf',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('lets the background ingest and its retry try again regardless', async () => {
    const input = inputFor('retry')
    fetchSpy.mockResolvedValueOnce(new Response('down', { status: 503 }))
    await expect(ensureRendition(input, { readerWaitMs: 60_000 })).rejects.toBeInstanceOf(RenditionFailedError)

    await expect(ensureRendition(input)).resolves.toBe('org/org-1/project/proj-1/doc/retry/v1/_render.pdf')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    // And a success clears the memory: the reader converts no more, it reads.
    send.mockResolvedValue({ ContentLength: 1024 })
    await expect(ensureRendition(input, { readerWaitMs: 60_000 })).resolves.toBe(
      'org/org-1/project/proj-1/doc/retry/v1/_render.pdf',
    )
  })

  it('forgets a failure after five minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const input = inputFor('forgotten')
      fetchSpy.mockResolvedValueOnce(new Response('down', { status: 503 }))
      await expect(ensureRendition(input, { readerWaitMs: 60_000 })).rejects.toBeInstanceOf(RenditionFailedError)

      vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
      await expect(ensureRendition(input, { readerWaitMs: 60_000 })).resolves.toBe(
        'org/org-1/project/proj-1/doc/forgotten/v1/_render.pdf',
      )
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
