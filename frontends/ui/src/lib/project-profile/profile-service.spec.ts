import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { checkProjectConsistency } from './profile-service'

const session = { userId: 'user-1', organizationId: 'org-1' } as never

describe('checkProjectConsistency authorization (FB-13)', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ findings: [] }) })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires project:edit — the pre-save check runs only for editors', async () => {
    await checkProjectConsistency(session, 'proj-1', { freeText: [] })

    // Aligned with generateProjectSummary; viewers cannot save the wizard, so the
    // check must not be reachable with the broader project:view.
    expect(requireProjectAccess).toHaveBeenCalledWith(session, 'proj-1', 'project:edit')
  })

  it('propagates an authorization failure and never reaches the backend', async () => {
    vi.mocked(requireProjectAccess).mockRejectedValueOnce(new Error('forbidden'))

    await expect(checkProjectConsistency(session, 'proj-1', { freeText: [] })).rejects.toThrow('forbidden')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('checkProjectConsistency backend fetch is time-bounded (fail-open)', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    // clearAllMocks preserves the module-factory default (requireProjectAccess
    // resolves to undefined); only call history is cleared.
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('carries an AbortSignal so a hung backend cannot block the save', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ findings: [] }) })

    await checkProjectConsistency(session, 'proj-1', { freeText: [] })

    const [, init] = mockFetch.mock.calls[0]
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
  })

  it('degrades a timeout abort to the same fail-open result as a network error', async () => {
    // AbortSignal.timeout() rejects fetch with a DOMException named TimeoutError.
    mockFetch.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))

    const result = await checkProjectConsistency(session, 'proj-1', { freeText: [] })

    // Identical fail-open shape to a plain transport failure — the wizard saves anyway.
    expect(result).toEqual({ findings: null, error: 'check_request_failed' })
  })

  it('a plain network error produces the same fail-open shape (parity baseline)', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await checkProjectConsistency(session, 'proj-1', { freeText: [] })

    expect(result).toEqual({ findings: null, error: 'check_request_failed' })
  })
})
