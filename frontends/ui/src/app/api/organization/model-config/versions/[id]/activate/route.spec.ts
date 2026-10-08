/**
 * @vitest-environment node
 */
/**
 * Rollback activates a stored version only after the ZDR check. A version saved
 * before zero data retention was on, or before its model lost its ZDR endpoint,
 * would otherwise put models OpenRouter refuses back into production. Under ZDR
 * each model must have a ZDR endpoint serving its group, and nothing else about
 * rollback changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'admin@grid.com',
  role: 'admin',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
  authzErrorResponse: vi.fn().mockReturnValue(null),
}))

const VERSION_ID = '11111111-2222-3333-4444-555555555555'

/** The row the service reads; `activateVersion` hands THIS row to `validate`, then "writes". */
let storedRow: { id: string; overrides: Record<string, { model: string }> } | null = null
const written: Array<string | null> = []

vi.mock('@/lib/model-config/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/model-config/service')>()),
  activateVersion: vi.fn(
    async (params: { versionId: string | null; validate?: (row: never) => Promise<void> }) => {
      if (params.versionId === null) {
        written.push(null)
        return null
      }
      if (!storedRow) throw new Error('not found: version does not exist for this organization')
      await params.validate?.(storedRow as never)
      written.push(params.versionId)
      return storedRow
    }
  ),
}))

vi.mock('@/lib/model-config/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/model-config/openrouter')>()),
  fetchZdrEndpoints: vi.fn(),
}))
vi.mock('@/lib/model-config/org-catalog', () => ({ isZdrApplicableForOrg: vi.fn() }))
vi.mock('@/lib/organizations/service', () => ({ isZdrOnlyForOrg: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))

import { POST } from './route'
import { fetchZdrEndpoints, ZdrListUnavailableError, type ZdrIndex } from '@/lib/model-config/openrouter'
import { isZdrApplicableForOrg } from '@/lib/model-config/org-catalog'
import { isZdrOnlyForOrg } from '@/lib/organizations/service'

const zdrIndex = (...endpoints: Array<{ modelId: string; supportedParameters?: string[] }>): ZdrIndex =>
  new Map(
    endpoints.map(({ modelId, supportedParameters = ['tools'] }) => [
      modelId,
      [{ modelId, supportedParameters, contextLength: 200000 }],
    ])
  )

const activate = (id: string): Promise<Response> =>
  POST(new Request(`http://localhost/api/organization/model-config/versions/${id}/activate`, { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })

describe('POST /api/organization/model-config/versions/[id]/activate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    written.length = 0
    storedRow = { id: VERSION_ID, overrides: { deep_research: { model: 'vendor/capable' } } }
    vi.mocked(isZdrOnlyForOrg).mockResolvedValue(true)
    vi.mocked(isZdrApplicableForOrg).mockResolvedValue(true)
    vi.mocked(fetchZdrEndpoints).mockResolvedValue(zdrIndex({ modelId: 'vendor/capable' }))
  })

  it('refuses, under ZDR, a version whose model has no ZDR endpoint (422, not_zdr), writing nothing', async () => {
    vi.mocked(fetchZdrEndpoints).mockResolvedValue(zdrIndex({ modelId: 'vendor/other' }))
    const res = await activate(VERSION_ID)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { details: Record<string, { code: string }[]> }
    expect(body.details.deep_research.map((r) => r.code)).toEqual(['not_zdr'])
    expect(written).toEqual([])
  })

  it('refuses a model whose ZDR endpoints cannot serve the group (zdr_endpoint_lacks_capability)', async () => {
    vi.mocked(fetchZdrEndpoints).mockResolvedValue(zdrIndex({ modelId: 'vendor/capable', supportedParameters: [] }))
    const body = (await (await activate(VERSION_ID)).json()) as { details: Record<string, { code: string }[]> }
    expect(body.details.deep_research.map((r) => r.code)).toEqual(['zdr_endpoint_lacks_capability'])
  })

  it('activates the very row it validated', async () => {
    expect((await activate(VERSION_ID)).status).toBe(200)
    expect(written).toEqual([VERSION_ID])
  })

  it('checks ZDR only: a model outside the catalog or short on context is not a rollback refusal', async () => {
    // Rollback does not validate catalog membership or capabilities, and the ZDR
    // check must not start doing so under its own name. Only the ZDR list decides
    // here.
    storedRow = { id: VERSION_ID, overrides: { deep_research: { model: 'vendor/retired-from-catalog' } } }
    vi.mocked(fetchZdrEndpoints).mockResolvedValue(zdrIndex({ modelId: 'vendor/retired-from-catalog' }))
    expect((await activate(VERSION_ID)).status).toBe(200)
  })

  it('ignores a retired group in a saved version: the runtime drops it too', async () => {
    storedRow = {
      id: VERSION_ID,
      overrides: { deep_research: { model: 'vendor/capable' }, intent: { model: 'vendor/whatever' } },
    }
    expect((await activate(VERSION_ID)).status).toBe(200)
  })

  it('refuses when the ZDR list cannot be read (503, fail closed)', async () => {
    vi.mocked(fetchZdrEndpoints).mockRejectedValue(new ZdrListUnavailableError('HTTP 503'))
    const res = await activate(VERSION_ID)
    expect(res.status).toBe(503)
    expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe('zdr_list_unavailable')
    expect(written).toEqual([])
  })

  it('does not touch the ZDR list for an org whose own key is on another provider', async () => {
    vi.mocked(isZdrApplicableForOrg).mockResolvedValue(false)
    expect((await activate(VERSION_ID)).status).toBe(200)
    expect(fetchZdrEndpoints).not.toHaveBeenCalled()
  })

  it('does not check anything when the org opted out of ZDR', async () => {
    vi.mocked(isZdrOnlyForOrg).mockResolvedValue(false)
    expect((await activate(VERSION_ID)).status).toBe(200)
    expect(isZdrApplicableForOrg).not.toHaveBeenCalled()
    expect(fetchZdrEndpoints).not.toHaveBeenCalled()
  })

  it('answers 403 for a version of another org, through the not-found mapping', async () => {
    storedRow = null
    expect((await activate(VERSION_ID)).status).toBe(403)
    expect(fetchZdrEndpoints).not.toHaveBeenCalled()
  })

  it('never refuses a reset to the inherited defaults', async () => {
    expect((await activate('none')).status).toBe(200)
    expect(written).toEqual([null])
    expect(isZdrOnlyForOrg).not.toHaveBeenCalled()
  })
})
