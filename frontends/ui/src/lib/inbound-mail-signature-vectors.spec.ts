/**
 * @vitest-environment node
 */
import { createHmac } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SIGNED_INTERNAL_PREFIX } from '@/lib/api/handler'
import { MAX_SIGNATURE_LIFETIME_S, REQUIRED_COVERED_COMPONENTS, requireInternalSignature, SIGNATURE_ALGORITHM } from '@/lib/internal-auth'
import { contentDigestOf, signedHeaders } from '@/test-utils/signed-request'

/**
 * The BFF's half of the inbound-mail signature vectors
 * (`shared/inbound-mail-signature.json`). The Worker's half is
 * `deploy/pulumi/src/platform/inbound-mail-worker.spec.ts`, which makes the
 * Worker's hand-written WebCrypto signer produce every vector's request byte
 * for byte. Here the same requests must pass `requireInternalSignature`, and
 * the library this repo verifies with must produce the same signature from
 * the same inputs. Between them, the Worker and the BFF cannot drift apart
 * without one of the two specs failing.
 *
 * The JSON files live above the app root, outside the image's build context,
 * so they are read at runtime, never imported (`test-utils/card-json-schema.ts`
 * says why).
 */

interface Vector {
  readonly name: string
  readonly keyId: string
  readonly secret: string
  readonly bffUrl: string
  readonly created: number
  readonly envelope: { readonly to: string; readonly from: string }
  readonly bodyBase64: string
  readonly expected: {
    readonly url: string
    readonly headers: Record<string, string>
    readonly signatureBase: string
  }
}

interface Contract {
  readonly path: string
  readonly signedPathPrefix: string
  readonly envelopeToHeader: string
  readonly envelopeFromHeader: string
  readonly contentType: string
  readonly envelopeEncoding: { readonly nullSender: string; readonly cases: ReadonlyArray<{ address: string; header: string }> }
  readonly signatureAlgorithm: string
  readonly signatureLifetimeSeconds: number
  readonly signedComponents: readonly string[]
}

function readShared<T>(file: string): T {
  let dir = process.cwd()
  for (;;) {
    const candidate = join(dir, 'shared', file)
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8')) as T
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`shared/${file} not found in any directory above ${process.cwd()}`)
    dir = parent
  }
}

const VECTORS = readShared<{ vectors: Vector[] }>('inbound-mail-signature.json').vectors
const CONTRACT = readShared<Contract>('inbound-mail-contract.json')
const KEYS_ENV = 'GRID_INBOUND_MAIL_SIGNING_KEYS'
const REQUIREMENT = { keysEnv: KEYS_ENV, components: [CONTRACT.envelopeToHeader, CONTRACT.envelopeFromHeader] } as const

function useVector(vector: Vector, secondsAfterCreated = 1): void {
  vi.useFakeTimers({ now: (vector.created + secondsAfterCreated) * 1000, toFake: ['Date'] })
  vi.stubEnv(KEYS_ENV, JSON.stringify({ [vector.keyId]: vector.secret }))
  vi.stubEnv('WORKOS_REDIRECT_URI', `${vector.bffUrl}/api/auth/callback`)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
}

/** The request the Worker sends, as the vector pins it. `content-length` is set by the runtime. */
function workerRequest(vector: Vector, overrides: Record<string, string> = {}): Request {
  const headers = { ...vector.expected.headers, ...overrides }
  return new Request(vector.expected.url, {
    method: 'POST',
    headers,
    body: new Uint8Array(Buffer.from(vector.bodyBase64, 'base64')),
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the inbound-mail signature vectors, against the BFF', () => {
  it('cover the components the route requires, under the contract the Worker reads', () => {
    expect(CONTRACT.signatureAlgorithm).toBe(SIGNATURE_ALGORITHM)
    expect(CONTRACT.signatureLifetimeSeconds).toBe(MAX_SIGNATURE_LIFETIME_S)
    expect(CONTRACT.signedComponents).toEqual([...REQUIRED_COVERED_COMPONENTS, ...REQUIREMENT.components])
    expect(CONTRACT.signedPathPrefix).toBe(SIGNED_INTERNAL_PREFIX)
    expect(CONTRACT.path.startsWith(SIGNED_INTERNAL_PREFIX)).toBe(true)
    for (const vector of VECTORS) {
      expect(new URL(vector.expected.url).pathname).toBe(CONTRACT.path)
      expect(vector.expected.headers['content-type']).toBe(CONTRACT.contentType)
    }
  })

  it.each(VECTORS)('accepts the request: $name', async (vector) => {
    useVector(vector)
    const body = Buffer.from(vector.bodyBase64, 'base64')

    const verified = await requireInternalSignature(workerRequest(vector), 'inbound-mail-vectors', REQUIREMENT)

    expect(verified).toEqual({
      keyId: vector.keyId,
      created: new Date(vector.created * 1000),
      expires: new Date((vector.created + MAX_SIGNATURE_LIFETIME_S) * 1000),
      contentLength: body.byteLength,
      contentDigest: contentDigestOf(body),
    })
  })

  it.each(VECTORS)('is what the library signs from the same inputs: $name', async (vector) => {
    const headers = await signedHeaders({
      url: vector.expected.url,
      body: Buffer.from(vector.bodyBase64, 'base64'),
      keyId: vector.keyId,
      secret: vector.secret,
      created: new Date(vector.created * 1000),
      headers: {
        [CONTRACT.envelopeToHeader]: vector.expected.headers[CONTRACT.envelopeToHeader],
        [CONTRACT.envelopeFromHeader]: vector.expected.headers[CONTRACT.envelopeFromHeader],
      },
    })
    expect(headers['Signature-Input']).toBe(vector.expected.headers['signature-input'])
    expect(headers.Signature).toBe(vector.expected.headers.signature)
    expect(headers['content-digest']).toBe(vector.expected.headers['content-digest'])
    expect(headers['content-length']).toBe(vector.expected.headers['content-length'])
  })

  it.each(VECTORS)('MACs the signature base the vector states (RFC 9421 §2.5): $name', (vector) => {
    const mac = createHmac('sha256', Buffer.from(vector.secret, 'base64')).update(vector.expected.signatureBase).digest('base64')
    expect(vector.expected.headers.signature).toBe(`sig=:${mac}:`)
  })

  it('refuses a vector replayed to another origin, with a rewritten envelope, or after it expired', async () => {
    const [vector] = VECTORS
    useVector(vector)
    await expect(
      requireInternalSignature(workerRequest(vector, { [CONTRACT.envelopeToHeader]: 'other.k3m7q2xw4pab@piloti.test' }), 'v', REQUIREMENT),
    ).rejects.toMatchObject({ reason: 'bad-signature' })
    vi.stubEnv('WORKOS_REDIRECT_URI', 'https://elsewhere.example/api/auth/callback')
    await expect(requireInternalSignature(workerRequest(vector), 'v', REQUIREMENT)).rejects.toMatchObject({ reason: 'bad-signature' })
    useVector(vector, MAX_SIGNATURE_LIFETIME_S + 1)
    await expect(requireInternalSignature(workerRequest(vector), 'v', REQUIREMENT)).rejects.toMatchObject({ reason: 'expired' })
  })

  it('decodes every envelope case the Worker encodes', () => {
    // The BFF reads the envelope headers back with decodeURIComponent, and a
    // null reverse-path as the contract's marker.
    for (const { address, header } of CONTRACT.envelopeEncoding.cases) {
      expect(header === CONTRACT.envelopeEncoding.nullSender ? '' : decodeURIComponent(header)).toBe(address)
    }
  })
})
