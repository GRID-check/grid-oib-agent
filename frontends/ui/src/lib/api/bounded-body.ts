/**
 * Reading a raw request body that must be exactly what its sender declared.
 *
 * ## Why exact, and why not `request.arrayBuffer()`
 *
 * A route behind the Next proxy does not get an error when the body is larger
 * than `proxyClientMaxBodySize`: Next buffers up to the limit, logs a warning
 * and hands the route the FIRST N bytes as if they were the whole body (see
 * `docs/contributing/gotchas.md`). A length check of the form "at most N" then
 * passes a truncated body. So these readers compare the bytes received with
 * the declared length for EQUALITY, and a short body is a 503 `body-truncated`
 * the sender retries, never a body the route acts on.
 *
 * Reading is bounded before it starts (`maxBytes` against the declared length)
 * and while it runs (never more bytes than declared are accepted), so a body
 * cannot grow memory past what the route agreed to. `streamBodyTo` never holds
 * the body at all: it hands the route a stream that counts and hashes as it
 * flows and that fails, in place of ending, when the count or the RFC 9530
 * `Content-Digest` does not match. A consumer writing to object storage then
 * sees an error at the end rather than a clean finish over bad bytes.
 *
 * The signed internal routes (`internalApiRoute` with `auth.signature`) live
 * under `/api/internal/signed/`, which the proxy matcher excludes, so their
 * bodies are never buffered against the proxy limit in the first place. These
 * checks are what makes that exclusion verifiable rather than assumed.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { parseDictionary } from 'structured-headers'
import { ApiError, BadRequestError, PayloadTooLargeError, ServiceUnavailableError } from './errors'

/** What the body must be. */
export interface BodyExpectation {
  /** The exact byte count, usually a signed or validated `Content-Length`. */
  readonly expectedLength: number
  /** The most this route reads at all. A larger declared length is refused before a byte is read. */
  readonly maxBytes: number
  /**
   * An RFC 9530 `Content-Digest` field value the body must hash to. Omitted,
   * only the length is checked.
   */
  readonly contentDigest?: string
}

/** Why a body was refused. `body-truncated` is the code the operator's alert matches on. */
export type BodyRefusal = 'body-truncated' | 'body-overlong' | 'bad-digest'

/**
 * Fewer bytes arrived than declared: cut off in transit or by a proxy limit.
 * 503, because the sender did nothing wrong and a retry may succeed.
 */
export class BodyTruncatedError extends ServiceUnavailableError {
  readonly reason = 'body-truncated' satisfies BodyRefusal
  constructor(expected: number, received: number) {
    super('Request body is shorter than its declared length', { reason: 'body-truncated', expected, received })
  }
}

/** More bytes arrived than declared. HTTP framing makes this a broken sender, not a network fault. */
export class BodyOverlongError extends BadRequestError {
  readonly reason = 'body-overlong' satisfies BodyRefusal
  constructor(expected: number) {
    super('Request body is longer than its declared length', { reason: 'body-overlong', expected })
  }
}

/**
 * The bytes do not hash to the declared digest, or the digest names no
 * algorithm we verify. 401: on a signed route the digest is what binds the
 * body to the signature, so a mismatch is an unauthenticated body.
 */
export class BadDigestError extends ApiError {
  readonly reason = 'bad-digest' satisfies BodyRefusal
  constructor(why: string) {
    super(401, 'UNAUTHORIZED', `Content-Digest ${why}`, { reason: 'bad-digest' })
  }
}

/**
 * RFC 9530 algorithms we verify, by their registered name, with Node's hash
 * name. Unregistered or deprecated ones (`md5`, `sha`, …) are ignored as the
 * RFC allows; at least one of these must be present.
 */
const DIGEST_ALGORITHMS = { 'sha-256': 'sha256', 'sha-512': 'sha512' } as const
type DigestAlgorithm = keyof typeof DIGEST_ALGORITHMS

/** An algorithm we verify. Own keys only: `in` would take `constructor` for one. */
function isDigestAlgorithm(name: string): name is DigestAlgorithm {
  return Object.hasOwn(DIGEST_ALGORITHMS, name)
}

/**
 * The declared `Content-Length` of `request`, strictly a decimal integer.
 * 411 when absent (a chunked body has no length to hold it to), 400 when not
 * a number.
 */
export function declaredContentLength(request: Request): number {
  const raw = request.headers.get('content-length')
  if (raw === null) throw new ApiError(411, 'LENGTH_REQUIRED', 'Content-Length is required')
  if (!/^\d{1,15}$/.test(raw)) throw new BadRequestError('Content-Length is not a number')
  return Number(raw)
}

/**
 * Read the whole body into memory, holding it to `expectation`. For bodies
 * small enough to hold; anything a route forwards to storage goes through
 * {@link streamBodyTo}.
 */
export async function readBoundedBody(request: Request, expectation: BodyExpectation): Promise<Uint8Array> {
  return streamBodyTo(request, expectation, async (body) => {
    const bytes = new Uint8Array(expectation.expectedLength)
    const reader = body.getReader()
    let offset = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return bytes
      bytes.set(value, offset)
      offset += value.byteLength
    }
  })
}

/**
 * Hand the body to `consume` as a stream that is held to `expectation` as it
 * flows, and resolve with what `consume` returns once every check passed.
 *
 * The stream errors (rather than ends) when the body runs past the declared
 * length, ends short of it, or ends with a digest that does not match, so a
 * consumer that propagates stream errors never completes over bad bytes. A
 * consumer that swallows them is still covered: the checks are re-applied
 * after `consume` resolves, and their error wins. Either way, whatever
 * `consume` wrote before the refusal is the caller's to discard.
 *
 * `consume` must read the stream to its end. One that returns early has
 * vouched for bytes nobody checked, which is a bug in the route, and it gets
 * a 500 rather than a result.
 */
export async function streamBodyTo<T>(
  request: Request,
  expectation: BodyExpectation,
  consume: (body: ReadableStream<Uint8Array>) => Promise<T>,
): Promise<T> {
  const { expectedLength, maxBytes } = expectation
  if (expectedLength > maxBytes) throw new PayloadTooLargeError(maxBytes)
  const hashes = expectation.contentDigest === undefined ? null : digestHashes(expectation.contentDigest)
  const meter = new BodyMeter(expectedLength, hashes)
  const source = request.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
  const checked = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        meter.add(chunk)
        controller.enqueue(chunk)
      },
      flush: () => meter.finish(),
    }),
  )
  let result: T
  try {
    result = await consume(checked)
  } catch (error) {
    throw meter.refusal ?? error
  }
  // A consumer that swallowed the stream's error still gets the refusal.
  if (meter.refusal) throw meter.refusal
  if (!meter.finished) throw new Error('streamBodyTo: the consumer returned before reading the whole body')
  return result
}

/** Counts and hashes a body as it passes, and remembers the first refusal. */
class BodyMeter {
  received = 0
  finished = false
  refusal: ApiError | null = null

  constructor(
    private readonly expectedLength: number,
    private readonly hashes: ReadonlyMap<DigestAlgorithm, { expected: Buffer; hash: ReturnType<typeof createHash> }> | null,
  ) {}

  add(chunk: Uint8Array): void {
    this.received += chunk.byteLength
    if (this.received > this.expectedLength) this.refuse(new BodyOverlongError(this.expectedLength))
    for (const { hash } of this.hashes?.values() ?? []) hash.update(chunk)
  }

  finish(): void {
    this.finished = true
    if (this.received < this.expectedLength) this.refuse(new BodyTruncatedError(this.expectedLength, this.received))
    for (const { expected, hash } of this.hashes?.values() ?? []) {
      const actual = hash.digest()
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        this.refuse(new BadDigestError('does not match the body'))
      }
    }
  }

  private refuse(error: ApiError): never {
    this.refusal ??= error
    throw this.refusal
  }
}

/**
 * The hashes to compute for a `Content-Digest` value: one per algorithm we
 * verify, each with the digest it must produce. Every algorithm we know is
 * checked; at least one must be present.
 */
function digestHashes(
  contentDigest: string,
): Map<DigestAlgorithm, { expected: Buffer; hash: ReturnType<typeof createHash> }> {
  let dictionary: ReturnType<typeof parseDictionary>
  try {
    dictionary = parseDictionary(contentDigest)
  } catch {
    throw new BadDigestError('is not a structured dictionary')
  }
  const hashes = new Map<DigestAlgorithm, { expected: Buffer; hash: ReturnType<typeof createHash> }>()
  for (const [name, member] of dictionary) {
    if (!isDigestAlgorithm(name)) continue
    const value = member[0]
    if (!(value instanceof ArrayBuffer)) throw new BadDigestError(`${name} is not a byte sequence`)
    hashes.set(name, { expected: Buffer.from(value), hash: createHash(DIGEST_ALGORITHMS[name]) })
  }
  if (hashes.size === 0) throw new BadDigestError('names no supported algorithm (sha-256, sha-512)')
  return hashes
}
