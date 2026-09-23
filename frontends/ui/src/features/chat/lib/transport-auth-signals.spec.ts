/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'

import { isLikelyAuthRelatedTransportError } from './transport-auth-signals'

describe('isLikelyAuthRelatedTransportError', () => {
  test.each([
    ['HTTP 401 response', 'Upstream returned 401 Unauthorized'],
    ['unauthorized keyword', 'Request was unauthorized'],
    ['token expired', 'token has expired'],
    ['token invalid', 'token is invalid'],
    ['token missing', 'token missing from request'],
    ['session expired', 'session expired'],
    ['session invalid', 'session invalid or revoked'],
    ['authentication keyword', 'authentication failed'],
    ['mixed case', 'Token Expired due to timeout'],
    ['401 in longer message', 'WebSocket closed: 401 Unauthorized - check credentials'],
  ])('returns true for auth-shaped error: %s', (_label, text) => {
    expect(isLikelyAuthRelatedTransportError(text)).toBe(true)
  })

  test.each([
    ['network error', 'Network connection timed out'],
    ['generic server error', 'Internal server error 500'],
    ['DNS failure', 'ENOTFOUND backend.example.com'],
    ['connection refused', 'Connection refused'],
    ['SSE retry', 'SSE connection failed after retries'],
    ['empty string', ''],
    ['random text', 'Something went wrong, please try again'],
    ['403 forbidden (RBAC, not auth)', 'HTTP 403 Forbidden'],
    ['permission denied', 'You do not have permission to access this resource'],
  ])('returns false for non-auth error: %s', (_label, text) => {
    expect(isLikelyAuthRelatedTransportError(text)).toBe(false)
  })
})
