/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { artImage } from '@/lib/art'

const mockMiddleware = vi.fn()
const mockAuthkitMiddleware = vi.fn(() => mockMiddleware)

vi.doMock('@workos-inc/authkit-nextjs', () => ({
  authkitMiddleware: mockAuthkitMiddleware,
}))

describe('AuthKit v4 proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  test('configures authkitMiddleware with public landing, AuthKit callback, and error pages allow-listed', async () => {
    await import('./proxy')

    expect(mockAuthkitMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({
        middlewareAuth: expect.objectContaining({
          unauthenticatedPaths: [
            '/',
            '/api/healthz',
            '/api/auth/callback',
            '/api/auth/signin',
            '/api/auth/websocket-scope',
            '/auth/error',
            '/api/internal/(.*)',
            // The MCP server checks its own bearer token or envelope (ADR-0122);
            // the OAuth protected-resource metadata is public by RFC 9728.
            '/api/mcp',
            // The A2A server checks the same bearer token (ADR-0124).
            '/api/a2a',
            // The platform door checks a bearer token for its own audience (ADR-0126).
            '/api/platform/mcp',
            // PostHog's poke carries only a ticket id; the route re-reads the
            // thread with its own key and rate-limits (ADR-0118, second amendment).
            '/api/webhooks/posthog-support',
            '/.well-known/(.*)',
            // The image optimizer re-enters the router in-process, so
            // middleware runs on this route with a cookie-less mocked request.
            '/api/documents/(.*)/image',
          ],
        }),
      })
    )
  })

  test('leaves icons, riso art, manifest and robots.txt outside the auth redirect', async () => {
    const { config } = await import('./proxy')
    const matcher = new RegExp(`^${config.matcher[0]}$`)
    const publicFiles = [
      '/favicon.ico',
      '/icon.svg',
      '/apple-icon.png',
      '/manifest.webmanifest',
      '/robots.txt',
      '/sw.js',
      '/icons/icon-192.png',
      // by id, as the app reaches art: a literal /art/ path fails the riso check
      new URL(artImage('vignetten/bauplatz/empty').src, 'http://localhost').pathname,
    ]

    for (const path of publicFiles) expect(matcher.test(path), path).toBe(false)
    expect(matcher.test('/app/projects')).toBe(true)
  })

  // Unescaped and unanchored, `sw.js` let any path starting `sw`, one character,
  // `js` past the session; the same held for every file name in the list.
  test('lets only the exact public file names past, not paths that start like them', async () => {
    const { config } = await import('./proxy')
    const matcher = new RegExp(`^${config.matcher[0]}$`)
    for (const path of ['/sw.jsx', '/swxjs', '/sw.js/x', '/robots.txt.bak', '/favicon.ico/x', '/faviconxico', '/manifest.webmanifest/x']) {
      expect(matcher.test(path), path).toBe(true)
    }
  })

  // The SDK posts from signed-out pages and mid-expiry; AuthKit would answer a
  // beacon with a redirect to the WorkOS login page and lose the event.
  test('leaves the first-party PostHog relay outside the auth redirect', async () => {
    const { config } = await import('./proxy')
    const matcher = new RegExp(`^${config.matcher[0]}$`)

    for (const path of ['/ingest/e/', '/ingest/s/', '/ingest/flags/', '/ingest/static/recorder.js', '/ingest/array/phc_x/config.js']) {
      expect(matcher.test(path), path).toBe(false)
    }
    // Only the relay's prefix: a page that merely starts with the word is still guarded.
    expect(matcher.test('/ingestion')).toBe(true)
    expect(matcher.test('/app/ingest/x')).toBe(true)
  })

  // A proxied body is buffered and, above `proxyClientMaxBodySize`, cut short
  // without an error (docs/contributing/gotchas.md). Signed routes take a raw
  // body from outside the cluster, so the proxy must never see them.
  test('leaves the signed internal routes outside the proxy, and only them', async () => {
    const { config } = await import('./proxy')
    const { SIGNED_INTERNAL_PREFIX } = await import('@/lib/api/handler')
    const matcher = new RegExp(`^${config.matcher[0]}$`)

    for (const path of [`${SIGNED_INTERNAL_PREFIX}inbound-mail`, `${SIGNED_INTERNAL_PREFIX}any/nested/route`]) {
      expect(matcher.test(path), path).toBe(false)
    }
    // The token-guarded internal routes keep the proxy, and so does a sibling
    // that merely starts with the same word.
    for (const path of ['/api/internal/memory', '/api/internal/signedx/inbound-mail', '/api/internal/signed', '/app/api/internal/signed/x']) {
      expect(matcher.test(path), path).toBe(true)
    }
  })

  test('delegates requests to the authkitMiddleware', async () => {
    const { default: proxy } = await import('./proxy')
    const request = { url: 'http://localhost:3000/api/v1/collections' } as never
    const event = {} as never

    await proxy(request, event)

    expect(mockMiddleware).toHaveBeenCalledWith(request, event)
  })
})
