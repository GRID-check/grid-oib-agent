/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  BadDigestError,
  BodyOverlongError,
  BodyTruncatedError,
  declaredContentLength,
  readBoundedBody,
  streamBodyTo,
} from './bounded-body'
import { ApiError, PayloadTooLargeError } from './errors'
import { contentDigestOf } from '@/test-utils/signed-request'

const BODY = new TextEncoder().encode('Subject: Stellplatznachweis\r\n\r\nim Anhang')

/** A request whose body arrives in `chunks`, the way a socket delivers it. */
function streamed(chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Request('http://localhost/api/internal/signed/probe', { method: 'POST', body, duplex: 'half' } as RequestInit)
}

async function drain(body: ReadableStream<Uint8Array>): Promise<number> {
  const reader = body.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return total
    total += value.byteLength
  }
}

describe('readBoundedBody', () => {
  it('returns the body when its length and digest are the declared ones', async () => {
    const bytes = await readBoundedBody(streamed([BODY.subarray(0, 5), BODY.subarray(5)]), {
      expectedLength: BODY.byteLength,
      maxBytes: 1024,
      contentDigest: contentDigestOf(BODY),
    })
    expect(Buffer.from(bytes).equals(Buffer.from(BODY))).toBe(true)
  })

  // The proxy failure this exists for: Next hands the route the first N bytes
  // as if they were the whole body. "At most N" passes that; equality does not.
  it('answers a short body with 503 body-truncated, never a shorter result', async () => {
    const short = streamed([BODY.subarray(0, 10)])
    const refused = await readBoundedBody(short, { expectedLength: BODY.byteLength, maxBytes: 1024 }).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(BodyTruncatedError)
    expect(refused).toMatchObject({ status: 503, details: { reason: 'body-truncated', expected: BODY.byteLength, received: 10 } })
  })

  it('refuses a body longer than declared without reading past the declared length', async () => {
    const long = streamed([BODY, BODY])
    await expect(readBoundedBody(long, { expectedLength: BODY.byteLength, maxBytes: 1024 })).rejects.toBeInstanceOf(BodyOverlongError)
  })

  it('refuses a declared length above the route maximum before reading a byte', async () => {
    const request = streamed([BODY])

    await expect(readBoundedBody(request, { expectedLength: 2048, maxBytes: 1024 })).rejects.toBeInstanceOf(PayloadTooLargeError)
    expect(request.bodyUsed).toBe(false)
  })

  it('answers bytes that do not hash to the declared digest with 401 bad-digest', async () => {
    const tampered = new Uint8Array(BODY)
    tampered[0] = 0x73
    const refused = await readBoundedBody(streamed([tampered]), {
      expectedLength: BODY.byteLength,
      maxBytes: 1024,
      contentDigest: contentDigestOf(BODY),
    }).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(BadDigestError)
    expect(refused).toMatchObject({ status: 401, details: { reason: 'bad-digest' } })
  })

  it('checks sha-512 as well, and every supported algorithm the digest names', async () => {
    const both = `${contentDigestOf(BODY, 'sha-512')}, ${contentDigestOf(new Uint8Array([1]), 'sha-256')}`
    await expect(readBoundedBody(streamed([BODY]), { expectedLength: BODY.byteLength, maxBytes: 1024, contentDigest: contentDigestOf(BODY, 'sha-512') })).resolves.toBeDefined()
    await expect(readBoundedBody(streamed([BODY]), { expectedLength: BODY.byteLength, maxBytes: 1024, contentDigest: both })).rejects.toBeInstanceOf(BadDigestError)
  })

  it.each([
    ['names only algorithms we do not verify', 'md5=:AAAA:'],
    ['is not a structured dictionary', 'sha-256=not-bytes ((('],
    ['carries a string where bytes belong', 'sha-256="abc"'],
    // An inherited property of a plain object, not an algorithm: once a 500 from createHash(Object).
    ['names an inherited key, not an algorithm', 'constructor=:AAAA:'],
  ])('refuses a Content-Digest that %s', async (_, contentDigest) => {
    await expect(readBoundedBody(streamed([BODY]), { expectedLength: BODY.byteLength, maxBytes: 1024, contentDigest })).rejects.toBeInstanceOf(BadDigestError)
  })

  it('accepts an empty body declared as empty', async () => {
    const empty = new Request('http://localhost/x', { method: 'POST' })
    expect((await readBoundedBody(empty, { expectedLength: 0, maxBytes: 1024 })).byteLength).toBe(0)
  })
})

describe('streamBodyTo', () => {
  it('hands the consumer the bytes as they arrive and resolves with its result', async () => {
    const result = await streamBodyTo(streamed([BODY.subarray(0, 3), BODY.subarray(3)]), {
      expectedLength: BODY.byteLength,
      maxBytes: 1024,
      contentDigest: contentDigestOf(BODY),
    }, drain)
    expect(result).toBe(BODY.byteLength)
  })

  // A consumer writing to object storage must see an error at the end, not a
  // clean finish it would then commit.
  it('errors the stream itself on a short body, so the consumer fails too', async () => {
    let consumerSaw: unknown = null
    const refused = await streamBodyTo(streamed([BODY.subarray(0, 4)]), { expectedLength: BODY.byteLength, maxBytes: 1024 }, (body) =>
      drain(body).catch((error: unknown) => {
        consumerSaw = error
        throw error
      }),
    ).catch((error: unknown) => error)

    expect(consumerSaw).toBeInstanceOf(BodyTruncatedError)
    expect(refused).toBeInstanceOf(BodyTruncatedError)
  })

  it('still refuses when the consumer swallows the stream error', async () => {
    const refused = await streamBodyTo(
      streamed([BODY]),
      { expectedLength: BODY.byteLength, maxBytes: 1024, contentDigest: contentDigestOf(new Uint8Array([1])) },
      (body) => drain(body).catch(() => -1),
    ).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(BadDigestError)
  })

  it('treats a consumer that returns before the end as a bug, not a result', async () => {
    const refused = await streamBodyTo(streamed([BODY.subarray(0, 4), BODY.subarray(4)]), { expectedLength: BODY.byteLength, maxBytes: 1024 }, async (body) => {
      await body.getReader().read()
      return 'early'
    }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(Error)
    expect(refused).not.toBeInstanceOf(ApiError)
  })
})

describe('declaredContentLength', () => {
  const withLength = (value: string) => new Request('http://localhost/x', { method: 'POST', headers: { 'content-length': value }, body: 'x' })

  it('reads a decimal Content-Length', () => {
    expect(declaredContentLength(withLength('1'))).toBe(1)
  })

  it('refuses a chunked body with 411 and a malformed length with 400', () => {
    const chunked = streamed([BODY])
    expect(() => declaredContentLength(chunked)).toThrow(expect.objectContaining({ status: 411 }))
    expect(() => declaredContentLength(withLength('1e3'))).toThrow(expect.objectContaining({ status: 400 }))
  })
})
