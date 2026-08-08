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

  test('delegates requests to the authkitMiddleware', async () => {
    const { default: proxy } = await import('./proxy')
    const request = { url: 'http://localhost:3000/api/v1/collections' } as never
    const event = {} as never

    await proxy(request, event)

    expect(mockMiddleware).toHaveBeenCalledWith(request, event)
  })
})
