/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { authkit } = vi.hoisted(() => ({
  authkit: vi.fn(async (_request: Request) => new Response('authkit', { status: 307 })),
}))
vi.mock('@workos-inc/authkit-nextjs', () => ({ handleAuth: () => authkit }))

import { GET } from './route'

afterEach(() => {
  vi.restoreAllMocks()
  authkit.mockClear()
})

describe('/api/auth/callback', () => {
  it('sends a request with no code and no state to sign in, without an error (#724)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    const res = await GET(
      new NextRequest('https://app.piloti.at/api/auth/callback', {
        headers: { 'user-agent': 'meta-externalagent/1.1' },
      })
    )

    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/api/auth/signin')
    expect(authkit).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('hands a returning sign-in to AuthKit', async () => {
    await GET(new NextRequest('https://app.piloti.at/api/auth/callback?code=c&state=s'))
    expect(authkit).toHaveBeenCalledTimes(1)
  })

  it('hands a flow that came back with state but no code to AuthKit, which clears its PKCE cookie', async () => {
    await GET(new NextRequest('https://app.piloti.at/api/auth/callback?state=s&error=access_denied'))
    expect(authkit).toHaveBeenCalledTimes(1)
  })
})
