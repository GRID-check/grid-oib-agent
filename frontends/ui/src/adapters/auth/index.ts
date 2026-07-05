/**
 * Auth Adapters
 *
 * Client-safe authentication exports for use in features.
 * Server-only auth helpers are in `@/lib/auth`.
 */

// Session hooks (client-side)
export { useAuth } from './use-auth'

// Types
export type { AuthState, AuthActions, AuthContext } from './types'
