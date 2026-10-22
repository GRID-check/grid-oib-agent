/**
 * @vitest-environment node
 */
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/errors'
import {
  DEV_DEFAULT_SIGNING_SECRET,
  MAX_SIGNATURE_LIFETIME_S,
  requireInternalSignature,
  SignatureRefusedError,
  usableSigningKeys,
  type SignatureRefusal,
} from './internal-auth'
import {
  contentDigestOf,
  signedHeaders,
  signedRequest,
  TEST_KEY_ID,
  TEST_SIGNING_SECRET,
  type SignedRequestOptions,
} from '@/test-utils/signed-request'

const KEYS_ENV = 'GRID_INBOUND_MAIL_SIGNING_KEYS'
const URL_SIGNED = 'https://app.piloti.test/api/internal/signed/probe'
const NOW = new Date('2026-10-22T12:00:00Z')
const BODY = 'From: a@example.test\r\n\r\nhello'
const ENVELOPE = { 'x-envelope-to': 'p.abc@piloti.test', 'x-envelope-from': 'a@example.test' }
const REQUIREMENT = { keysEnv: KEYS_ENV, components: ['x-envelope-to', 'x-envelope-from'] } as const

function options(overrides: Partial<SignedRequestOptions> = {}): SignedRequestOptions {
  return { url: URL_SIGNED, body: BODY, created: NOW, headers: ENVELOPE, ...overrides }
}

async function refusal(request: Request, requirement = REQUIREMENT): Promise<SignatureRefusal | number> {
  try {
    await requireInternalSignature(request, 'probe', requirement)
  } catch (error) {
    if (error instanceof SignatureRefusedError) return error.reason
    if (error instanceof ApiError) return error.status
    throw error
  }
  throw new Error('the request was accepted')
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  vi.stubEnv(KEYS_ENV, JSON.stringify({ [TEST_KEY_ID]: TEST_SIGNING_SECRET }))
  vi.stubEnv('WORKOS_REDIRECT_URI', '')
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('requireInternalSignature', () => {
  it('accepts a request the library signed, and returns what the signature vouches for', async () => {
    const verified = await requireInternalSignature(await signedRequest(options()), 'probe', REQUIREMENT)

    expect(verified).toEqual({
      keyId: TEST_KEY_ID,
      created: NOW,
      expires: new Date(NOW.getTime() + MAX_SIGNATURE_LIFETIME_S * 1000),
      contentLength: Buffer.byteLength(BODY),
      contentDigest: contentDigestOf(BODY),
    })
  })

  // The Worker signs with WebCrypto, not with this library. Building the
  // signature base by hand from RFC 9421 §2.5 and MACing it with node:crypto is
  // that second, independent implementation: if the library and the RFC's text
  // disagreed, one of these two specs would fail.
  it('agrees with a signature built by hand from the RFC 9421 §2.5 signature base', async () => {
    const created = Math.floor(NOW.getTime() / 1000)
    const params = `("@method" "@target-uri" "content-digest" "content-length" "x-envelope-to" "x-envelope-from");created=${created};expires=${created + 300};keyid="${TEST_KEY_ID}";alg="hmac-sha256"`
    const base = [
      `"@method": POST`,
      `"@target-uri": ${URL_SIGNED}`,
      `"content-digest": ${contentDigestOf(BODY)}`,
      `"content-length": ${Buffer.byteLength(BODY)}`,
      `"x-envelope-to": ${ENVELOPE['x-envelope-to']}`,
      `"x-envelope-from": ${ENVELOPE['x-envelope-from']}`,
      `"@signature-params": ${params}`,
    ].join('\n')
    const mac = createHmac('sha256', Buffer.from(TEST_SIGNING_SECRET, 'base64')).update(base).digest('base64')

    const libraryHeaders = await signedHeaders(options())
    expect(libraryHeaders['Signature-Input']).toBe(`sig=${params}`)
    expect(libraryHeaders.Signature).toBe(`sig=:${mac}:`)

    const handMade = new Request(URL_SIGNED, {
      method: 'POST',
      body: BODY,
      headers: {
        ...ENVELOPE,
        'content-digest': contentDigestOf(BODY),
        'content-length': String(Buffer.byteLength(BODY)),
        'signature-input': `mail=${params}`,
        signature: `mail=:${mac}:`,
      },
    })
    await expect(requireInternalSignature(handMade, 'probe', REQUIREMENT)).resolves.toMatchObject({ keyId: TEST_KEY_ID })
  })

  it('refuses a request without a signature', async () => {
    const request = new Request(URL_SIGNED, { method: 'POST', body: BODY, headers: { 'content-digest': contentDigestOf(BODY) } })
    expect(await refusal(request)).toBe('unsigned')
  })

  it('refuses an expired signature and one created too far in the future', async () => {
    const stale = new Date(NOW.getTime() - (MAX_SIGNATURE_LIFETIME_S + 1) * 1000)
    expect(await refusal(await signedRequest(options({ created: stale })))).toBe('expired')
    const early = new Date(NOW.getTime() + 120_000)
    expect(await refusal(await signedRequest(options({ created: early })))).toBe('expired')
  })

  it('refuses a signature that asks to live longer than five minutes', async () => {
    const expires = new Date(NOW.getTime() + (MAX_SIGNATURE_LIFETIME_S + 1) * 1000)
    expect(await refusal(await signedRequest(options({ expires })))).toBe('malformed')
  })

  it('refuses a keyid the key map does not hold', async () => {
    expect(await refusal(await signedRequest(options({ keyId: 'rotated-out' })))).toBe('unknown-key')
  })

  it('refuses a signature made with another secret under a known keyid', async () => {
    const other = Buffer.alloc(32, 9).toString('base64')
    expect(await refusal(await signedRequest(options({ secret: other })))).toBe('bad-signature')
  })

  it('refuses a request whose covered header was rewritten after signing', async () => {
    const headers = await signedHeaders(options())
    const retargeted = new Request(URL_SIGNED, {
      method: 'POST',
      body: BODY,
      headers: { ...headers, 'x-envelope-to': 'p.other@piloti.test' },
    })
    expect(await refusal(retargeted)).toBe('bad-signature')
  })

  it('refuses a signature for another route', async () => {
    const headers = await signedHeaders(options({ url: 'https://app.piloti.test/api/internal/signed/other' }))
    const moved = new Request(URL_SIGNED, { method: 'POST', body: BODY, headers })
    expect(await refusal(moved)).toBe('bad-signature')
  })

  it('refuses a signature that leaves a required component uncovered', async () => {
    const withoutDigest = options({ components: ['@method', '@target-uri', 'content-length', 'x-envelope-to', 'x-envelope-from'] })
    expect(await refusal(await signedRequest(withoutDigest))).toBe('malformed')
    // The route's own components are required as well.
    const withoutEnvelope = options({ components: ['@method', '@target-uri', 'content-digest', 'content-length'] })
    expect(await refusal(await signedRequest(withoutEnvelope))).toBe('malformed')
  })

  it('refuses more than one signature', async () => {
    const headers = await signedHeaders(options())
    const doubled = new Request(URL_SIGNED, {
      method: 'POST',
      body: BODY,
      headers: {
        ...headers,
        'Signature-Input': `${headers['Signature-Input']}, ${headers['Signature-Input'].replace(/^sig=/, 'two=')}`,
        Signature: `${headers.Signature}, ${headers.Signature.replace(/^sig=/, 'two=')}`,
      },
    })
    expect(await refusal(doubled)).toBe('malformed')
  })

  it('refuses unparseable signature headers', async () => {
    const headers = await signedHeaders(options())
    const garbled = new Request(URL_SIGNED, { method: 'POST', body: BODY, headers: { ...headers, 'Signature-Input': 'sig=(((' } })
    expect(await refusal(garbled)).toBe('malformed')
  })

  it('binds @target-uri to the pinned app origin, not to the URL the request arrived on', async () => {
    vi.stubEnv('WORKOS_REDIRECT_URI', 'https://app.piloti.test/api/auth/callback')
    const headers = await signedHeaders(options())
    // TLS ends at the gateway: Node sees http and the pod's own host.
    const behindGateway = new Request('http://10.0.0.7:3000/api/internal/signed/probe', { method: 'POST', body: BODY, headers })
    await expect(requireInternalSignature(behindGateway, 'probe', REQUIREMENT)).resolves.toMatchObject({ keyId: TEST_KEY_ID })
  })
})

describe('the key map', () => {
  it('accepts both keys of an overlap rotation, and only the new one once the old is removed', async () => {
    const next = Buffer.alloc(32, 3).toString('base64')
    vi.stubEnv(KEYS_ENV, JSON.stringify({ [TEST_KEY_ID]: TEST_SIGNING_SECRET, 'next-2027-01': next }))
    await expect(requireInternalSignature(await signedRequest(options()), 'probe', REQUIREMENT)).resolves.toBeDefined()
    const signedWithNext = await signedRequest(options({ keyId: 'next-2027-01', secret: next }))
    await expect(requireInternalSignature(signedWithNext, 'probe', REQUIREMENT)).resolves.toBeDefined()

    vi.stubEnv(KEYS_ENV, JSON.stringify({ 'next-2027-01': next }))
    expect(await refusal(await signedRequest(options()))).toBe('unknown-key')
  })

  it.each([
    ['unset', undefined],
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['empty', '{}'],
    ['three keys', JSON.stringify({ a: TEST_SIGNING_SECRET, b: TEST_SIGNING_SECRET, c: TEST_SIGNING_SECRET })],
    ['a short secret', JSON.stringify({ a: Buffer.alloc(16, 1).toString('base64') })],
    ['a secret that is not base64', JSON.stringify({ a: 'not base64 at all, but long enough to pass a length check' })],
    ['an invalid keyid', JSON.stringify({ 'a b': TEST_SIGNING_SECRET })],
  ])('disables signed requests (503) when the key map is %s', async (_, value) => {
    vi.stubEnv(KEYS_ENV, value)
    expect(usableSigningKeys(KEYS_ENV, 'probe')).toBeNull()
    expect(await refusal(await signedRequest(options()))).toBe(503)
  })

  it('refuses the well-known dev secret outside a dev environment, and allows it in one', () => {
    vi.stubEnv(KEYS_ENV, JSON.stringify({ dev: DEV_DEFAULT_SIGNING_SECRET }))
    vi.stubEnv('APP_ENV', 'production')
    expect(usableSigningKeys(KEYS_ENV, 'probe')).toBeNull()
    vi.stubEnv('APP_ENV', 'development')
    expect(usableSigningKeys(KEYS_ENV, 'probe')?.has('dev')).toBe(true)
  })
})
