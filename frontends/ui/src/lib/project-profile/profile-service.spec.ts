/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

vi.mock('@/lib/projects/repository', () => ({
  findProjectProfileInOrg: vi.fn(),
  setProjectProfileSummaryInOrg: vi.fn().mockResolvedValue(undefined),
  updateProjectProfileIfVersion: vi.fn(),
}))

vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(),
  invalidateCached: vi.fn().mockResolvedValue(undefined),
}))

import { requireProjectAccess } from '@/lib/authz/projects'
import { invalidateCached } from '@/lib/cache'
import {
  findProjectProfileInOrg,
  setProjectProfileSummaryInOrg,
  updateProjectProfileIfVersion,
} from '@/lib/projects/repository'
import {
  checkProjectConsistency,
  generateProjectSummary,
  patchProjectProfile,
  saveProjectProfile,
} from './profile-service'
import type { ProjectProfile } from './types'

const session = { userId: 'user-1', organizationId: 'org-1' } as never

const storedProfile: ProjectProfile = {
  facts: {
    bundesland: {
      value: 'wien',
      confidence: 'confirmed',
      source: 'onboarding',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  },
  goals: {},
  unknowns: [],
  assumptions: {},
}

const storedState = {
  profile: storedProfile,
  profileVersion: 5,
  profilePromptView: 'PROJECT_CONTEXT v1',
  profileDisplay: { title: 'Project profile', summary: 'Old prose.', keyFacts: [], missingInfo: [] },
  profileUpdatedAt: new Date('2026-01-01T00:00:00.000Z'),
} as never

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

  it('forwards the org id so the backend can resolve the org BYOK credential', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ findings: [] }) })

    await checkProjectConsistency(session, 'proj-1', { freeText: [] })

    const [, init] = mockFetch.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({ 'x-grid-organization-id': 'org-1' })
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

describe('saveProjectProfile optimistic concurrency (If-Match)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findProjectProfileInOrg).mockResolvedValue(storedState)
    vi.mocked(updateProjectProfileIfVersion).mockResolvedValue(storedState)
  })

  it('rejects with a conflict when the client-loaded version is stale', async () => {
    await expect(saveProjectProfile(session, 'proj-1', storedProfile, 4)).rejects.toThrow(/modified since/i)
    expect(updateProjectProfileIfVersion).not.toHaveBeenCalled()
  })

  it('writes when the client-loaded version matches, resetting the stale summary', async () => {
    await saveProjectProfile(session, 'proj-1', storedProfile, 5)

    expect(updateProjectProfileIfVersion).toHaveBeenCalledTimes(1)
    const [, , expectedVersion, values] = vi.mocked(updateProjectProfileIfVersion).mock.calls[0]
    expect(expectedVersion).toBe(5)
    // A full replace invalidates the old prose; the Overview regenerates it.
    expect((values as { profileDisplay: { summary: string } }).profileDisplay.summary).toBe('')
  })

  it('keeps the legacy in-request check when no version is supplied', async () => {
    await saveProjectProfile(session, 'proj-1', storedProfile)
    expect(updateProjectProfileIfVersion).toHaveBeenCalledTimes(1)
  })
})

/**
 * Fix 1 (WP-C): every profile write path must drop BOTH profile-derived caches,
 * not just `promptview:` — otherwise the structured `bundesland` served on the
 * WS handshake stays stale for the 5-min TTL after a location change.
 *
 * `@/lib/cache` is mocked here, so `./prompt-view` runs for real and we assert
 * the EXACT keys handed to `invalidateCached`. (prompt-view.spec.ts additionally
 * proves the same wiring against a real in-memory cache.)
 */
describe('profile writes invalidate both profile-derived cache keys (Fix 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(findProjectProfileInOrg).mockResolvedValue(storedState)
    vi.mocked(updateProjectProfileIfVersion).mockResolvedValue(storedState)
  })

  it('saveProjectProfile drops promptview: AND bundesland:', async () => {
    await saveProjectProfile(session, 'proj-1', storedProfile, 5)

    expect(invalidateCached).toHaveBeenCalledWith('promptview:proj-1')
    expect(invalidateCached).toHaveBeenCalledWith('bundesland:proj-1')
  })

  it('patchProjectProfile drops promptview: AND bundesland:', async () => {
    await patchProjectProfile(session, 'proj-1', [])

    expect(invalidateCached).toHaveBeenCalledWith('promptview:proj-1')
    expect(invalidateCached).toHaveBeenCalledWith('bundesland:proj-1')
  })
})

describe('generateProjectSummary', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mockFetch)
    vi.mocked(findProjectProfileInOrg).mockResolvedValue(storedState)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends the HUMAN-READABLE profile text and locale, and persists the summary', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ summary: 'Ein Wohnprojekt.', error: null }),
    })

    const result = await generateProjectSummary(session, 'proj-1', { locale: 'de' })

    expect(result).toEqual({ summary: 'Ein Wohnprojekt.' })
    const [url, init] = mockFetch.mock.calls[0]
    expect(url).toBe('http://backend:8000/v1/generate-summary')
    const body = JSON.parse(String((init as RequestInit).body))
    // Labels, not machine tokens: "bundesland=wien" must never leak into the prose.
    expect(body.profile_text).toBe('Bundesland: Wien')
    expect(body.locale).toBe('de')
    // The locale is persisted alongside the prose so a later UI language switch
    // can trigger exactly one regeneration.
    expect(setProjectProfileSummaryInOrg).toHaveBeenCalledWith('proj-1', 'org-1', 'Ein Wohnprojekt.', 'de')
  })

  it('persists the summary with the DEFAULT locale (de) when none is supplied', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ summary: 'Ein Wohnprojekt.', error: null }),
    })

    await generateProjectSummary(session, 'proj-1')

    // Mirrors the backend's own default so the stored locale matches the prose.
    expect(setProjectProfileSummaryInOrg).toHaveBeenCalledWith('proj-1', 'org-1', 'Ein Wohnprojekt.', 'de')
  })

  it('degrades a timeout/transport failure to a diagnosable code instead of a 500', async () => {
    mockFetch.mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))

    const result = await generateProjectSummary(session, 'proj-1')

    expect(result).toEqual({ summary: '', error: 'backend_unreachable' })
    expect(setProjectProfileSummaryInOrg).not.toHaveBeenCalled()
  })

  it('degrades a non-2xx backend response the same way', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 502, text: () => Promise.resolve('bad gateway') })

    const result = await generateProjectSummary(session, 'proj-1')

    expect(result).toEqual({ summary: '', error: 'backend_error' })
  })

  it('never persists an empty summary over an existing one', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ summary: '', error: 'llm_not_configured' }),
    })

    const result = await generateProjectSummary(session, 'proj-1')

    expect(result).toEqual({ summary: '', error: 'llm_not_configured' })
    expect(setProjectProfileSummaryInOrg).not.toHaveBeenCalled()
  })

  it('forwards the org id so the backend can resolve the org BYOK credential', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ summary: 'A summary.', error: null }),
    })

    await generateProjectSummary(session, 'proj-1')

    const [, init] = mockFetch.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({ 'x-grid-organization-id': 'org-1' })
  })
})
