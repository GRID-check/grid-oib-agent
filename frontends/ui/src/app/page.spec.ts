/**
 * Home page redirect contract.
 *
 * Regression cover for the sign-in loop: the landing site's only link back to
 * the app is its "Sign in" button, so if `/` bounced *every* logged-out visitor
 * to GRID_LANDING_URL the button returned the visitor to the page they came
 * from and the app had no reachable entry point.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import type { GridSession } from '@/lib/auth/types'

const SIGN_IN_URL = 'https://api.workos.com/user_management/authorize?screen_hint=sign-in'
const LANDING_URL = 'https://dev.piloti.at'

const redirect = vi.fn((url: string): never => {
  // Mirrors next/navigation: redirect() throws to unwind the render, so the
  // page never falls through to a later redirect() call.
  throw new Error(`NEXT_REDIRECT:${url}`)
})
const getGridSession = vi.fn<() => Promise<GridSession | null>>()

vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))
vi.mock('@workos-inc/authkit-nextjs', () => ({ getSignInUrl: async () => SIGN_IN_URL }))
vi.mock('@/lib/auth/session', () => ({ getGridSession: () => getGridSession() }))

const { default: HomePage } = await import('./page')

const session: GridSession = {
  userId: 'user_1',
  email: 'planer@example.at',
  name: 'Test Planer',
  accessToken: 'token',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

/** Run the page and return the URL it redirected to. */
const visit = async (searchParams: { 'sign-in'?: string } = {}): Promise<string> => {
  try {
    await HomePage({ searchParams: Promise.resolve(searchParams) })
  } catch (error) {
    const message = (error as Error).message
    if (message.startsWith('NEXT_REDIRECT:')) return message.slice('NEXT_REDIRECT:'.length)
    throw error
  }
  throw new Error('HomePage returned without redirecting')
}

const originalEnv = process.env

describe('HomePage redirect', () => {
  beforeEach(() => {
    process.env = { ...originalEnv, REQUIRE_AUTH: 'true', GRID_LANDING_URL: LANDING_URL }
    redirect.mockClear()
    getGridSession.mockReset()
    getGridSession.mockResolvedValue(null)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  test('sends a logged-out visitor to the landing site', async () => {
    expect(await visit()).toBe(LANDING_URL)
  })

  test('sends a logged-out visitor who asked to sign in to WorkOS', async () => {
    // The regression: without this the landing "Sign in" button bounces back
    // to the landing site and the app is unreachable.
    expect(await visit({ 'sign-in': '' })).toBe(SIGN_IN_URL)
  })

  test('falls back to WorkOS when no landing site is configured', async () => {
    delete process.env.GRID_LANDING_URL

    expect(await visit()).toBe(SIGN_IN_URL)
  })

  test('sends a signed-in visitor to the workspace', async () => {
    getGridSession.mockResolvedValue(session)

    expect(await visit()).toBe('/app/projects')
  })

  test('sends a signed-in visitor to the workspace even with ?sign-in', async () => {
    getGridSession.mockResolvedValue(session)

    expect(await visit({ 'sign-in': '' })).toBe('/app/projects')
  })

  test('skips auth entirely when REQUIRE_AUTH is off', async () => {
    process.env.REQUIRE_AUTH = 'false'

    expect(await visit()).toBe('/app/projects')
    expect(getGridSession).not.toHaveBeenCalled()
  })
})
