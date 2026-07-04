/**
 * Client-side authentication hook powered by WorkOS AuthKit v4.
 *
 * Provides a backward-compatible `AuthContext` interface for existing UI
 * features while delegating session handling to AuthKit.
 */

'use client'

import { useCallback, useMemo } from 'react'
import { useAuth as useAuthKit, useAccessToken } from '@workos-inc/authkit-nextjs/components'
import { useAppConfig } from '@/shared/context'
import type { AuthContext } from './types'

/**
 * Default user returned when authentication is disabled.
 */
const DEFAULT_USER = {
  id: 'default-user',
  name: 'Default User',
  email: null,
  image: null,
}

/**
 * Hook for accessing the current authentication state and actions.
 *
 * Automatically handles the disabled-auth case (REQUIRE_AUTH=false) by
 * returning a mock authenticated user without contacting WorkOS.
 *
 * @example
 * ```tsx
 * const { user, isAuthenticated, isLoading, accessToken, signIn, signOut } = useAuth()
 * ```
 */
export const useAuth = (): AuthContext => {
  const { authRequired } = useAppConfig()
  const {
    user,
    organizationId: authKitOrganizationId,
    loading: sessionLoading,
    getAuth,
    signOut: authKitSignOut,
  } = useAuthKit()
  const {
    accessToken,
    loading: tokenLoading,
    error: tokenError,
    getAccessToken,
  } = useAccessToken()

  const handleSignIn = useCallback(async (): Promise<void> => {
    if (!authRequired) return
    await getAuth()
  }, [authRequired, getAuth])

  const handleSignOut = useCallback(async (): Promise<void> => {
    if (!authRequired) return
    await authKitSignOut({ returnTo: '/' })
  }, [authRequired, authKitSignOut])

  const name = useMemo(() => {
    if (!user) return null
    if (user.firstName && user.lastName) {
      return `${user.firstName} ${user.lastName}`
    }
    return user.firstName || user.lastName || user.name || null
  }, [user])

  if (!authRequired) {
    return {
      isAuthenticated: true,
      isLoading: false,
      authRequired: false,
      user: DEFAULT_USER,
      accessToken: undefined,
      idToken: undefined,
      organizationId: undefined,
      error: undefined,
      signIn: async () => {},
      signOut: async () => {},
      getAccessToken: async () => undefined,
    }
  }

  const isLoading = sessionLoading || tokenLoading
  const isAuthenticated = !!user && !!accessToken

  return {
    isAuthenticated,
    isLoading,
    authRequired: true,
    user: user
      ? {
          id: user.id,
          email: user.email,
          name,
          image: user.profilePictureUrl ?? null,
        }
      : null,
    accessToken,
    idToken: accessToken,
    organizationId: authKitOrganizationId,
    error: tokenError?.message,
    signIn: handleSignIn,
    signOut: handleSignOut,
    getAccessToken,
  }
}
