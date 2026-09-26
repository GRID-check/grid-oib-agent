/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'

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
            // The image optimizer re-enters the router in-process, so
            // middleware runs on this route with a cookie-less mocked request.
            '/api/documents/(.*)/image',
          ],
        }),
      })
    )
  })

  test('leaves icons, manifest and robots.txt outside the auth redirect', async () => {
    const { config } = await import('./proxy')
    const matcher = new RegExp(`^${config.matcher[0]}$`)
    const publicFiles = [
      '/favicon.ico',
      '/icon.svg',
      '/apple-icon.png',
      '/manifest.webmanifest',
      '/robots.txt',
      '/icons/icon-192.png',
    ]

    for (const path of publicFiles) expect(matcher.test(path), path).toBe(false)
    expect(matcher.test('/app/projects')).toBe(true)
  })

  test('delegates requests to the authkitMiddleware', async () => {
    const { default: proxy } = await import('./proxy')
    const request = { url: 'http://localhost:3000/api/v1/collections' } as never
    const event = {} as never

    await proxy(request, event)

    expect(mockMiddleware).toHaveBeenCalledWith(request, event)
  })
})
