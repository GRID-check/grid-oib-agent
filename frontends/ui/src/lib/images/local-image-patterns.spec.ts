/**
 * @vitest-environment node
 */

/**
 * Every URL we hand `next/image` must be one the optimizer will actually serve.
 *
 * This is the test that would have caught the blank previews. The Next 16
 * upgrade did not change any of our code: it changed the default of
 * `images.localPatterns` to `[{ pathname: '**', search: '' }]`, which rejects
 * any local `src` carrying a query string — which is every signed document
 * image we build. The route was fine. The optimizer answered
 * `"url" parameter is not allowed` and 400 before the route was reached, so
 * nothing in our own logs or route tests could see it.
 *
 * So the assertion here is deliberately NOT "our config contains the entry we
 * wrote". It runs a real URL from `buildDocumentImageUrl` through
 * `hasLocalMatch` — the exact function `next/dist/server/image-optimizer`
 * calls to decide — loaded from the installed Next. A future upgrade that
 * changes the rules again breaks this test rather than the app.
 */

import { hasLocalMatch } from 'next/dist/shared/lib/match-local-pattern'
import { beforeAll, describe, expect, it } from 'vitest'

import nextConfig from '../../../next.config'
import { buildDocumentImageUrl } from './signed-image-url'
import { isOptimizerEligible, LOCAL_IMAGE_PATTERNS } from './optimizable'

/**
 * The patterns as the optimizer will see them.
 *
 * Read off the real config rather than the constant, so a `next.config.ts` that
 * stops using `LOCAL_IMAGE_PATTERNS` — or drops `localPatterns` altogether, the
 * exact state that caused the outage — is caught here too. `undefined` is a
 * meaningful value to `hasLocalMatch` (it allows everything), so it is passed
 * through unchanged rather than defaulted away.
 */
const configuredPatterns = nextConfig.images?.localPatterns

beforeAll(() => {
  // The signing secret gates URL building; any non-default value will do.
  process.env.GRID_INTERNAL_API_TOKEN = 'test-secret-for-local-pattern-check'
})

describe('images.localPatterns admits the URLs we actually render', () => {
  it('is configured at all — an absent allow-list is not the same as an open one', () => {
    // Next fills in a restrictive default when this is unset, so "we did not
    // configure it" reads as "query strings are banned", not "anything goes".
    expect(configuredPatterns).toEqual(LOCAL_IMAGE_PATTERNS.map((pattern) => ({ ...pattern })))
  })

  it.each(['original', 'thumb'] as const)('accepts a signed %s document image', (variant) => {
    const url = buildDocumentImageUrl('org_123', 'doc_456', variant)
    expect(url).not.toBeNull()
    // The query string is the whole point: this is what the default rejected.
    expect(url).toContain('?')
    expect(hasLocalMatch(configuredPatterns, url!)).toBe(true)
  })

  it('still accepts ordinary local images, which the default allowed', () => {
    // Replacing `localPatterns` REPLACES Next's default rather than extending
    // it, so forgetting the `**` entry would break `/public` and static imports
    // while fixing document images.
    expect(hasLocalMatch(configuredPatterns, '/logo.svg')).toBe(true)
    expect(hasLocalMatch(configuredPatterns, '/_next/static/media/hero.a1b2c3.png')).toBe(true)
  })

  it('does not open the optimizer to arbitrary query strings', () => {
    // The reason Next tightened the default: an unconstrained local pattern
    // lets a stranger enumerate `?id=1`, `?id=2`, … through the optimizer and
    // fill its cache. Our one exception is signature-verified; nothing else is.
    expect(hasLocalMatch(configuredPatterns, '/api/projects/list?page=2')).toBe(false)
    expect(hasLocalMatch(configuredPatterns, '/logo.svg?v=2')).toBe(false)
    // Neighbouring paths under the same prefix are not covered by `*`, which
    // does not cross a `/`.
    expect(hasLocalMatch(configuredPatterns, '/api/documents/doc_1/download?x=1')).toBe(false)
    expect(hasLocalMatch(configuredPatterns, '/api/documents/a/b/image?x=1')).toBe(false)
  })
})

describe('isOptimizerEligible agrees with the optimizer', () => {
  /**
   * The call-site check and the config are two encodings of one rule, and they
   * fail in opposite directions: a src the config rejects but this accepts is a
   * blank image, and one the config accepts but this rejects is a silently
   * unoptimized one. Both are invisible without a test that compares them.
   */
  const localCases = [
    '/logo.svg',
    '/logo.svg?v=2',
    '/_next/static/media/hero.a1b2c3.png',
    '/api/documents/doc_1/image?org=o&v=thumb&exp=1&sig=deadbeef',
    '/api/documents/doc_1/image',
    '/api/documents/doc_1/download?x=1',
    '/api/documents/a/b/image?x=1',
    '/api/projects/list?page=2',
  ]

  it.each(localCases)('reaches the same verdict as hasLocalMatch for %s', (src) => {
    expect(isOptimizerEligible(src)).toBe(hasLocalMatch(configuredPatterns, src))
  })

  it('rejects what is not a local path at all, which hasLocalMatch never sees', () => {
    // The optimizer routes absolute and protocol-relative URLs to the REMOTE
    // allow-list instead, so these must be refused before that comparison —
    // they are the presigned object-store fallback, and asking the optimizer
    // for one yields a broken image.
    expect(isOptimizerEligible('https://storage.internal/bucket/doc.png?sig=x')).toBe(false)
    expect(isOptimizerEligible('//storage.internal/bucket/doc.png')).toBe(false)
    expect(isOptimizerEligible(null)).toBe(false)
    expect(isOptimizerEligible('')).toBe(false)
  })
})
