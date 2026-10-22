/**
 * Requests signed the way a signed internal route expects (RFC 9421 + RFC 9530),
 * produced by the maintained libraries rather than by our own code: the
 * signature by `http-message-signatures`, the `Content-Digest` dictionary by
 * `structured-headers`. A spec that verifies these with `@/lib/internal-auth`
 * therefore checks our verifier against an implementation we did not write,
 * which is the point of buying the library (AGENTS.md, "Buy, don't build").
 *
 * Every knob a refusal spec needs is here: the key, the times, the covered
 * components, and the body sent apart from the body signed.
 */

import { createHash } from 'node:crypto'
import { createSigner, httpbis } from 'http-message-signatures'
import { serializeDictionary } from 'structured-headers'
import { REQUIRED_COVERED_COMPONENTS, SIGNATURE_ALGORITHM } from '@/lib/internal-auth'

/** A 32-byte secret, base64, as an operator would generate it (`openssl rand -base64 32`). */
export const TEST_SIGNING_SECRET = Buffer.alloc(32, 7).toString('base64')
export const TEST_KEY_ID = 'test-2026-10'

export interface SignedRequestOptions {
  readonly url: string
  readonly body: Uint8Array | string
  readonly method?: string
  readonly keyId?: string
  /** Base64 secret; {@link TEST_SIGNING_SECRET} by default. */
  readonly secret?: string
  readonly created?: Date
  /** Defaults to `created + 300 s`. */
  readonly expires?: Date
  /** Extra headers, signed when named in `components`. */
  readonly headers?: Record<string, string>
  /** Covered components; the required four plus every extra header by default. */
  readonly components?: readonly string[]
  /** The bytes actually sent, when a spec needs them to differ from the signed ones. */
  readonly sentBody?: Uint8Array | string
  /** Overrides the computed `Content-Digest`. */
  readonly contentDigest?: string
  /** Overrides the computed `Content-Length`. */
  readonly contentLength?: string
}

/** The RFC 9530 `Content-Digest` value for `body`, serialized by `structured-headers`. */
export function contentDigestOf(body: Uint8Array | string, algorithm: 'sha-256' | 'sha-512' = 'sha-256'): string {
  const hash = createHash(algorithm === 'sha-256' ? 'sha256' : 'sha512').update(body).digest()
  return serializeDictionary({ [algorithm]: hash })
}

/** The signed message's headers, for specs that inspect or tamper with them. */
export async function signedHeaders(options: SignedRequestOptions): Promise<Record<string, string>> {
  const bytes = typeof options.body === 'string' ? Buffer.from(options.body) : options.body
  const created = options.created ?? new Date()
  const headers: Record<string, string> = {
    'content-digest': options.contentDigest ?? contentDigestOf(bytes),
    'content-length': options.contentLength ?? String(bytes.byteLength),
    ...options.headers,
  }
  const components = options.components ?? [...REQUIRED_COVERED_COMPONENTS, ...Object.keys(options.headers ?? {})]
  const signed = await httpbis.signMessage(
    {
      key: createSigner(Buffer.from(options.secret ?? TEST_SIGNING_SECRET, 'base64'), SIGNATURE_ALGORITHM, options.keyId ?? TEST_KEY_ID),
      fields: [...components],
      params: ['created', 'expires', 'keyid', 'alg'],
      paramValues: { created, expires: options.expires ?? new Date(created.getTime() + 300_000) },
    },
    { method: options.method ?? 'POST', url: options.url, headers },
  )
  return Object.fromEntries(Object.entries(signed.headers).map(([name, value]) => [name, String(value)]))
}

/** A `Request` carrying the library-made signature over `options`. */
export async function signedRequest(options: SignedRequestOptions): Promise<Request> {
  const headers = await signedHeaders(options)
  const sent = options.sentBody ?? options.body
  return new Request(options.url, {
    method: options.method ?? 'POST',
    headers,
    body: typeof sent === 'string' ? sent : new Uint8Array(sent),
  })
}
