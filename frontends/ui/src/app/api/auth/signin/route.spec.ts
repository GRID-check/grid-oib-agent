/**
 * Sign-in entry route.
 *
 * The root page only redirects here. AuthKit's PKCE cookie write is forbidden
 * during Server Component rendering and legal in a Route Handler, so the
 * authorization URL is resolved here, never inside the root page's render.
 */

import { describe, test, expect, vi } from 'vitest'

const SIGN_IN_URL = 'https://api.workos.com/user_management/authorize?client_id=test&screen_hint=sign-in'
const getSignInUrl = vi.fn<() => Promise<string>>()

vi.mock('@workos-inc/authkit-nextjs', () => ({ getSignInUrl: () => getSignInUrl() }))
vi.mock('@/lib/db/tenant-context', () => ({ tenantSlotRoute: (handler: never) => handler }))

const { GET } = await import('./route')

describe('GET /api/auth/signin', () => {
  test('redirects to the WorkOS authorization URL', async () => {
    getSignInUrl.mockResolvedValue(SIGN_IN_URL)

    const response = await GET()

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(SIGN_IN_URL)
  })

  test('propagates an AuthKit failure as a thrown error, not a silent bounce', async () => {
    getSignInUrl.mockRejectedValue(new Error('WORKOS_REDIRECT_URI missing'))

    await expect(GET()).rejects.toThrow('WORKOS_REDIRECT_URI missing')
  })
})
