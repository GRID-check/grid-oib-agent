import { describe, expect, it, vi, beforeEach } from 'vitest'

import { isAuthzError } from '@/lib/auth-utils'

class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT:${url}`)
    this.name = 'RedirectError'
  }
}

vi.mock('./session', () => ({
  requireGridSession: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new RedirectError(url)
  }),
}))

import { requireGridSession } from './session'
import { redirect } from 'next/navigation'
import {
  authzErrorResponse,
  NoOrganizationError,
  requireAuthorizedSession,
  requireAuthorizedPageSession,
} from './require-auth'

const authorizedSession = {
  userId: 'user-1',
  email: 'test@grid.com',
  name: 'Test User',
  accessToken: 'token',
  organizationId: 'org-1',
  organizationMembershipId: 'mem-1',
  role: 'admin',
  permissions: [],
}

const sessionWithoutOrg = {
  ...authorizedSession,
  organizationId: null,
  organizationMembershipId: null,
}

describe('require-auth guards', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requireAuthorizedSession throws a NoOrganizationError treated as authz error when no organization', async () => {
    vi.mocked(requireGridSession).mockResolvedValue(sessionWithoutOrg as any)

    let caught: unknown
    try {
      await requireAuthorizedSession()
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(NoOrganizationError)
    expect(isAuthzError(caught)).toBe(true)
  })

  it('requireAuthorizedPageSession redirects to organization onboarding when no organization', async () => {
    vi.mocked(requireGridSession).mockResolvedValue(sessionWithoutOrg as any)

    await expect(requireAuthorizedPageSession()).rejects.toThrow(RedirectError)
    expect(redirect).toHaveBeenCalledWith('/app/onboarding/organization')
  })

  it('both guards resolve to the session when an organization is selected', async () => {
    vi.mocked(requireGridSession).mockResolvedValue(authorizedSession as any)

    await expect(requireAuthorizedSession()).resolves.toBe(authorizedSession)
    await expect(requireAuthorizedPageSession()).resolves.toBe(authorizedSession)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('requireAuthorizedPageSession rethrows non-org errors without redirecting', async () => {
    vi.mocked(requireGridSession).mockRejectedValue(
      new Error('Unauthorized: Grid session required'),
    )

    await expect(requireAuthorizedPageSession()).rejects.toThrow(
      'Unauthorized: Grid session required',
    )
    expect(redirect).not.toHaveBeenCalled()
  })
})

describe('authzErrorResponse', () => {
  it('maps a NoOrganizationError to a 403 JSON response', async () => {
    const res = authzErrorResponse(new NoOrganizationError())

    expect(res).not.toBeNull()
    expect(res!.status).toBe(403)
    await expect(res!.json()).resolves.toEqual({ error: 'Forbidden' })
  })

  it.each([
    'Unauthorized: Grid session required',
    'Forbidden: insufficient permissions',
    'not found',
  ])('maps authz-style error "%s" to a 403', (message) => {
    const res = authzErrorResponse(new Error(message))
    expect(res?.status).toBe(403)
  })

  it('returns null for a non-authorization error so the caller can rethrow', () => {
    expect(authzErrorResponse(new Error('database connection reset'))).toBeNull()
    expect(authzErrorResponse('not an Error instance')).toBeNull()
  })
})
