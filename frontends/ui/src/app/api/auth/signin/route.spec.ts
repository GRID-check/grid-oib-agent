/**
 * Sign-in entry route.
 *
 * Regression cover for the RSC cookie-write bug: /?sign-in used to resolve
 * the AuthKit authorization URL inside the root page's Server Component
 * render — where cookies().set() is forbidden — and every visit threw into
 * the app-wide error boundary instead of reaching WorkOS. The page now only
 * redirects here; this handler performs the actual sign-in initiation in a
 * Route Handler, the context where AuthKit's PKCE cookie write is legal.
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
