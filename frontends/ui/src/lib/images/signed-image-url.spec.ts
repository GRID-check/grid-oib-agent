import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IMAGE_URL_WINDOW_SECONDS,
  buildDocumentImageUrl,
  imageUrlExpiry,
  resetSigningWarning,
  verifyDocumentImageUrl,
} from './signed-image-url'

const ORG = 'org_01TEST'
const DOC = 'doc-1'
const NOW = Date.UTC(2026, 0, 15, 12, 34, 56)
const DEFAULT_TEST_SECRET = 'test-signing-secret' // pragma: allowlist secret

/** The query of a minted URL, ready to hand to the verifier. */
function paramsOf(url: string): URLSearchParams {
  return new URL(url, 'http://n').searchParams
}

describe('signed document image URLs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetSigningWarning()
  })

  function withSecret(secret = DEFAULT_TEST_SECRET) {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', secret)
  }

  it('mints a root-relative path — the optimizer only treats those as local', () => {
    withSecret()
    const url = buildDocumentImageUrl(ORG, DOC, 'original', NOW)

    expect(url).not.toBeNull()
    expect(url!.startsWith('/api/documents/')).toBe(true)
    expect(url!.startsWith('//')).toBe(false)
  })

  it('round-trips a freshly minted URL', () => {
    withSecret()
    const url = buildDocumentImageUrl(ORG, DOC, 'original', NOW)!

    const result = verifyDocumentImageUrl(DOC, paramsOf(url), NOW)

    expect(result).toEqual({
      ok: true,
      claims: { organizationId: ORG, documentId: DOC, variant: 'original', exp: imageUrlExpiry(NOW) },
    })
  })

  it('gives every viewer in a window the SAME url, so the optimizer cache can hit', () => {
    withSecret()
    const early = buildDocumentImageUrl(ORG, DOC, 'thumb', NOW)
    const later = buildDocumentImageUrl(ORG, DOC, 'thumb', NOW + 60_000)

    expect(early).toEqual(later)
  })

  it('keeps at least a full window of life on every minted url', () => {
    withSecret()
    // Minted in the last second of a window — the naive "now + window" would
    // leave this token ~0s of life and break the image it was just issued for.
    const endOfWindow = Math.ceil(NOW / 1000 / IMAGE_URL_WINDOW_SECONDS) * IMAGE_URL_WINDOW_SECONDS * 1000 - 1000
    const url = buildDocumentImageUrl(ORG, DOC, 'original', endOfWindow)!

    const remainingSeconds = imageUrlExpiry(endOfWindow) - endOfWindow / 1000

    expect(remainingSeconds).toBeGreaterThanOrEqual(IMAGE_URL_WINDOW_SECONDS)
    expect(verifyDocumentImageUrl(DOC, paramsOf(url), endOfWindow).ok).toBe(true)
  })

  it('rejects the token once its expiry passes', () => {
    withSecret()
    const url = buildDocumentImageUrl(ORG, DOC, 'original', NOW)!
    const exp = imageUrlExpiry(NOW)

    expect(verifyDocumentImageUrl(DOC, paramsOf(url), exp * 1000)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('will not let a token be walked onto another document', () => {
    withSecret()
    const url = buildDocumentImageUrl(ORG, DOC, 'original', NOW)!

    expect(verifyDocumentImageUrl('doc-2', paramsOf(url), NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('will not let a token be walked onto another tenant', () => {
    withSecret()
    const url = buildDocumentImageUrl(ORG, DOC, 'original', NOW)!
    const params = paramsOf(url)
    params.set('org', 'org_01OTHER')

    expect(verifyDocumentImageUrl(DOC, params, NOW)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('will not let a thumbnail token be escalated to the full-size original', () => {
    withSecret()
    const url = buildDocumentImageUrl(ORG, DOC, 'thumb', NOW)!
    const params = paramsOf(url)
    params.set('v', 'original')

    expect(verifyDocumentImageUrl(DOC, params, NOW)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('will not let the expiry be extended without resigning', () => {
    withSecret()
    const url = buildDocumentImageUrl(ORG, DOC, 'original', NOW)!
    const params = paramsOf(url)
    params.set('exp', String(imageUrlExpiry(NOW) + 86_400))

    expect(verifyDocumentImageUrl(DOC, params, NOW)).toEqual({ ok: false, reason: 'bad-signature' })
  })

  it('does not verify a token signed with a different secret', () => {
    withSecret('secret-a')
    const url = buildDocumentImageUrl(ORG, DOC, 'original', NOW)!

    withSecret('secret-b')

    expect(verifyDocumentImageUrl(DOC, paramsOf(url), NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    })
  })

  it('rejects a malformed variant rather than treating it as a default', () => {
    withSecret()
    const url = buildDocumentImageUrl(ORG, DOC, 'original', NOW)!
    const params = paramsOf(url)
    params.set('v', 'source')

    expect(verifyDocumentImageUrl(DOC, params, NOW)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('is disabled, not open, when no secret is configured', () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')

    expect(buildDocumentImageUrl(ORG, DOC, 'original', NOW)).toBeNull()
    expect(verifyDocumentImageUrl(DOC, new URLSearchParams(), NOW)).toEqual({
      ok: false,
      reason: 'disabled',
    })
  })

  it('refuses the well-known dev secret outside a dev environment', () => {
    withSecret('grid-internal-dev-token')
    vi.stubEnv('APP_ENV', 'production')

    // Anyone who read the compose file could otherwise mint a URL for any
    // document in any tenant.
    expect(buildDocumentImageUrl(ORG, DOC, 'original', NOW)).toBeNull()
  })

  it('says so in the log when signing is disabled, instead of degrading silently', () => {
    // Falling back to an unoptimized presigned URL is invisible from outside —
    // it renders, it is just slow — so the log line is the only signal an
    // operator gets. Losing it means finding out by eye that a preview does not
    // feel like a WebP.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')

    buildDocumentImageUrl(ORG, DOC, 'original', NOW)

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('DISABLED'))
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('GRID_INTERNAL_API_TOKEN'))

    // Once, not once per image on the page.
    buildDocumentImageUrl(ORG, 'doc-2', 'original', NOW)
    expect(logged).toHaveBeenCalledTimes(1)

    logged.mockRestore()
  })

  it('names the dev-default cause specifically, since APP_ENV is production on dev stacks too', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    withSecret('grid-internal-dev-token')
    vi.stubEnv('APP_ENV', 'production')

    buildDocumentImageUrl(ORG, DOC, 'original', NOW)

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('well-known dev default'))

    logged.mockRestore()
  })

  it('allows the dev secret in development, where it is the configured default', () => {
    withSecret('grid-internal-dev-token')
    vi.stubEnv('APP_ENV', 'development')

    const url = buildDocumentImageUrl(ORG, DOC, 'original', NOW)

    expect(url).not.toBeNull()
    expect(verifyDocumentImageUrl(DOC, paramsOf(url!), NOW).ok).toBe(true)
  })
})
