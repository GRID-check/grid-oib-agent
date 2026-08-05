/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sever the workos/server-only import chains pulled in transitively.
vi.mock('server-only', () => ({}))
vi.mock('@/lib/backend-proxy', () => ({
  getBackendUrl: vi.fn().mockReturnValue('http://backend:8000'),
}))

const { recordAuditEvent, getPlatformOrganizationId } = vi.hoisted(() => ({
  recordAuditEvent: vi.fn(),
  getPlatformOrganizationId: vi.fn(),
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent }))
vi.mock('@/lib/authz/platform', () => ({ getPlatformOrganizationId }))

import { ConflictError, UpstreamError } from '@/lib/api/errors'
import type { GridSession } from '@/lib/auth/types'
import { getNormRegistry, putNormRegistry, verifyNormPointer } from './service'
import type { NormEntry, NormsFile } from './schemas'

const fetchMock = vi.fn()

const entry: NormEntry = {
  id: 'oib-rl2',
  title: 'OIB-Richtlinie 2',
  short: 'OIB-RL 2',
  rank: 'verordnung',
  bundesland: 'Wien',
  topics: ['Brandschutz'],
  relevance: 'hoch',
  application: 'LrKons',
  document_number: 'NOR1',
  source_url: '',
  citation_url: 'https://a',
  full_law_url: 'https://b',
  aliases: [],
  verified_at: '2026-01-01',
}

const registry: NormsFile = {
  version: 1,
  corpus_collection: 'oib_knowledge',
  language: '',
  states: {},
  corpus_note: '',
  doctrine: '',
  parcel_tags: [],
  entries: [entry],
}

const session: GridSession = {
  userId: 'user_1',
  email: 'admin@grid.at',
  name: 'Admin',
  accessToken: 'tok',
  organizationId: 'org_active',
  organizationMembershipId: 'mem_1',
  role: 'org-platform-owner',
  permissions: [],
  featureFlags: null,
}

describe('norm registry service', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    recordAuditEvent.mockReset()
    recordAuditEvent.mockResolvedValue(undefined)
    getPlatformOrganizationId.mockReset()
    getPlatformOrganizationId.mockResolvedValue('org_platform')
    vi.stubEnv('GRID_ADMIN_TOKEN', 'admin-secret')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('getNormRegistry loads and validates the envelope with the admin token', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ version: 4, registry }), { status: 200 }),
    )

    const result = await getNormRegistry()

    expect(result.version).toBe(4)
    expect(result.registry.entries).toHaveLength(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/v1/admin/norms')
    expect((init?.headers as Record<string, string>)['X-Admin-Token']).toBe('admin-secret')
  })

  it('getNormRegistry throws UpstreamError on a non-OK response', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }))
    await expect(getNormRegistry()).rejects.toBeInstanceOf(UpstreamError)
  })

  it('getNormRegistry throws UpstreamError on an unexpected shape', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ nope: true }), { status: 200 }))
    await expect(getNormRegistry()).rejects.toBeInstanceOf(UpstreamError)
  })

  it('putNormRegistry persists and records a platform-scoped audit event', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ version: 5 }), { status: 200 }))

    const result = await putNormRegistry(session, { version: 4, registry })

    expect(result).toEqual({ version: 5 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/v1/admin/norms')
    expect(init?.method).toBe('PUT')
    expect(recordAuditEvent).toHaveBeenCalledTimes(1)
    const audited = recordAuditEvent.mock.calls[0][0]
    expect(audited.organizationId).toBe('org_platform')
    expect(audited.action).toBe('platform.norm_registry.updated')
    expect(audited.metadata).toEqual({ entries: 1, version: 5 })
  })

  it('putNormRegistry maps a 409 to ConflictError (no audit)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'stale version' }), { status: 409 }))
    await expect(
      putNormRegistry(session, { version: 1, registry }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('putNormRegistry maps a 422 to UnprocessableError carrying the backend detail', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'entry[0].id duplicate' }), { status: 422 }),
    )
    await expect(
      putNormRegistry(session, { version: 4, registry }),
    ).rejects.toMatchObject({ status: 422, message: 'entry[0].id duplicate' })
  })

  it('verifyNormPointer returns candidates', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ title: 'OIB-RL 2', document_number: 'NOR1', citation_url: 'https://a', full_law_url: 'https://b' }],
          verified_at: '2026-07-18',
        }),
        { status: 200 },
      ),
    )

    const result = await verifyNormPointer({ title_query: 'OIB 2', application: 'LrKons' })

    expect(result.candidates).toHaveLength(1)
    expect(result.verified_at).toBe('2026-07-18')
  })

  it('verifyNormPointer maps a 502 (RIS down) to UpstreamError', async () => {
    fetchMock.mockResolvedValue(new Response('bad gateway', { status: 502 }))
    await expect(verifyNormPointer({ title_query: 'x', application: 'LrKons' })).rejects.toBeInstanceOf(UpstreamError)
  })
})
