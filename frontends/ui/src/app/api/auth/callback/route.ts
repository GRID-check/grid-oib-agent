import { handleAuth } from '@workos-inc/authkit-nextjs'
import { type NextRequest, NextResponse } from 'next/server'
import { tenantSlotRoute } from '@/lib/db/tenant-context'

/**
 * Post-login redirect base.
 *
 * The frontend runs behind a proxy (Coolify/Traefik) with Next.js on an
 * internal address. Without a baseURL, authkit builds the post-callback
 * redirect from the request origin, which leaks the internal host
 * (e.g. https://0.0.0.0:3001/app/projects) instead of the public domain.
 *
 * The configured redirect URI is already the public callback URL, so its
 * origin is the correct public base. authkit overrides the pathname with
 * returnPathname, so only the origin of baseURL is used. Unset (auth disabled)
 * → undefined → authkit falls back to the request URL.
 *
 * Prefer the plain WORKOS_REDIRECT_URI (a normal server env var, read at
 * runtime) over NEXT_PUBLIC_WORKOS_REDIRECT_URI, which Next can inline at build
 * time and would be empty when the value is only supplied at deploy time.
 */
const redirectUri = process.env.WORKOS_REDIRECT_URI ?? process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI
const baseURL = redirectUri ? new URL(redirectUri).origin : undefined

const authkitCallback = handleAuth({ returnPathname: '/app/projects', baseURL })

/**
 * A request that carries neither `code` nor `state` is not a returning
 * sign-in: it is a crawler or a bookmarked callback URL (#724 was
 * meta-externalagent). AuthKit logs every such request with `console.error`
 * before any `onError` could lower it, which files an issue, and answers 500.
 * It is sent to sign in instead and noted at debug. A request with `state` goes
 * to AuthKit as before, because AuthKit also clears that flow's PKCE cookie.
 */
async function callback(request: NextRequest): Promise<Response> {
  const { searchParams } = new URL(request.url)
  if (!searchParams.has('code') && !searchParams.has('state')) {
    console.debug('[auth] callback without code or state; redirecting to sign-in', {
      userAgent: request.headers.get('user-agent') ?? undefined,
    })
    return NextResponse.redirect(new URL('/api/auth/signin', baseURL ?? request.url))
  }
  return authkitCallback(request)
}

// Wrapped like every other route: this one runs BEFORE a session exists, so
// inheriting a tenant from the previous request on this socket would be
// especially wrong (ADR-0041).
export const GET = tenantSlotRoute(callback)
