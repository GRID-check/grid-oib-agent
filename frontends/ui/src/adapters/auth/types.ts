// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Client-side authentication types for the WorkOS AuthKit adapter.
 *
 * These types are consumed by UI features through `@/adapters/auth`. They are
 * intentionally decoupled from the raw `@workos-inc/authkit-nextjs` types so
 * that callers do not depend on AuthKit implementation details.
 */

/**
 * Auth state surfaced by the `useAuth` hook.
 */
export interface AuthState {
  /** Whether the user is authenticated */
  isAuthenticated: boolean
  /** Whether the auth state is still loading */
  isLoading: boolean
  /** Whether authentication is required via REQUIRE_AUTH env var */
  authRequired: boolean
  /** The authenticated user */
  user: {
    id?: string
    email?: string | null
    name?: string | null
    image?: string | null
  } | null
  /** The WorkOS access token for backend API calls */
  accessToken?: string
  /** Backward-compatible alias for the WorkOS access token */
  idToken?: string
  /** Active WorkOS organization id, when one is selected */
  organizationId?: string
  /** Any auth error message */
  error?: string
}

/**
 * Auth actions exposed by the `useAuth` hook.
 */
export interface AuthActions {
  /** Sign in with WorkOS AuthKit */
  signIn: () => Promise<void>
  /** Sign out and clear session */
  signOut: () => Promise<void>
  /** Get a guaranteed-fresh access token (async) */
  getAccessToken?: () => Promise<string | undefined>
}

/**
 * Complete auth context type returned by `useAuth`.
 */
export type AuthContext = AuthState & AuthActions
