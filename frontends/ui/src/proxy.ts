// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Next.js Proxy for WorkOS AuthKit v4 Session Management
 *
 * Uses authkitProxy from @workos-inc/authkit-nextjs to:
 * - Decrypt and refresh the encrypted WorkOS session cookie
 * - Attach the encrypted session to downstream requests via the internal
 *   x-workos-session header
 * - Enforce authentication on protected routes when REQUIRE_AUTH=true
 *
 * The Python backend receives the raw WorkOS access token from the v1 API
 * route proxy, which reads the session with withAuth() and forwards it as
 * Authorization: Bearer <access_token>.
 */

import { authkitMiddleware } from '@workos-inc/authkit-nextjs'
import type { NextFetchEvent, NextRequest } from 'next/server'

const isAuthRequired = (): boolean => {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

const middleware = authkitMiddleware({
  debug: process.env.NODE_ENV === 'development',
  middlewareAuth: {
    enabled: isAuthRequired(),
    unauthenticatedPaths: [
      '/api/auth/callback',
      '/api/auth/websocket-scope',
      '/auth/error',
    ],
  },
})

export default async function proxy(request: NextRequest, event: NextFetchEvent) {
  return middleware(request, event)
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     *
     * API auth routes are allow-listed via middlewareAuth.unauthenticatedPaths
     * so AuthKit can complete the OAuth callback without a session.
     */
    '/((?!_next/static|_next/image|favicon.ico|public).*)',
  ],
}
