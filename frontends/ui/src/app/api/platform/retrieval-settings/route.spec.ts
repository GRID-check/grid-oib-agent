/**
 * @vitest-environment node
 */
/**
 * The platform retrieval-settings endpoint. The contract worth pinning down:
 * only the platform owner may read or write it, the catalog validates every
 * value server-side (invalid pins surface as 422 with per-key errors), and an
 * omitted key is a *clear*, not a no-op — that is how a count goes back to the
 * build-time config default.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { UnprocessableError } from '@/lib/api/errors'

const session = {
  userId: 'owner-1',
  organizationId: 'org_platform',
  email: 'owner@grid.com',
  role: 'org-platform-owner',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/session', () => ({ getGridSession: async () => session }))
vi.mock('@/lib/auth/require-auth', () => ({ authzErrorResponse: vi.fn().mockReturnValue(null) }))

const requirePlatformOwner = vi.fn().mockResolvedValue(undefined)
const getPlatformOrganizationId = vi.fn().mockResolvedValue('org_platform')
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/authz/platform')>()
  return {
    ...original,
    requirePlatformOwner: (s: unknown) => requirePlatformOwner(s),
    getPlatformOrganizationId: () => getPlatformOrganizationId(),
  }
})

const recordAuditEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (e: unknown) => recordAuditEvent(e) }))

const listPlatformRetrievalSettings = vi.fn().mockResolvedValue([])
const savePlatformRetrievalSettings = vi.fn()
vi.mock('@/lib/retrieval-settings/service', () => ({
  listPlatformRetrievalSettings: () => listPlatformRetrievalSettings(),
  savePlatformRetrievalSettings: (input: unknown) => savePlatformRetrievalSettings(input),
}))

import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { GET, PUT } from './route'

const put = (body: unknown): Promise<Response> =>
  PUT(
    new Request('http://localhost/api/platform/retrieval-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

describe('/api/platform/retrieval-settings', () => {
  beforeEach(() => {
    requirePlatformOwner.mockReset().mockResolvedValue(undefined)
    getPlatformOrganizationId.mockReset().mockResolvedValue('org_platform')
    listPlatformRetrievalSettings.mockReset().mockResolvedValue([])
    savePlatformRetrievalSettings.mockReset().mockResolvedValue([])
    recordAuditEvent.mockReset().mockResolvedValue(undefined)
  })

  it('rejects a caller who is not the platform owner', async () => {
    requirePlatformOwner.mockRejectedValue(new PlatformAccessDeniedError())
    expect((await GET(new Request('http://localhost/api/platform/retrieval-settings'))).status).toBe(
      403
    )
    expect((await put({ settings: {} })).status).toBe(403)
    expect(savePlatformRetrievalSettings).not.toHaveBeenCalled()
  })

  it('reports the catalog definitions alongside the effective values', async () => {
    const body = (await (
      await GET(new Request('http://localhost/api/platform/retrieval-settings'))
    ).json()) as {
      definitions: { key: string }[]
      settings: unknown[]
    }
    expect(body.definitions.map((d) => d.key)).toContain('knowledge.top_k')
    expect(body.definitions).toHaveLength(10)
    expect(body.settings).toEqual([])
  })

  it('saves validated pins and audits the fleet-wide change', async () => {
    const response = await put({
      settings: { 'knowledge.top_k': 12, 'ris.max_results': 20 },
      note: 'mehr Kontext',
    })
    expect(response.status).toBe(200)
    expect(savePlatformRetrievalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { 'knowledge.top_k': 12, 'ris.max_results': 20 },
        note: 'mehr Kontext',
        actorUserId: session.userId,
        actorEmail: session.email,
      })
    )
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.retrieval_settings.updated',
        organizationId: 'org_platform',
        targetType: 'platform_retrieval_settings',
        metadata: expect.objectContaining({ changed: 2, note: 'mehr Kontext' }),
      })
    )
  })

  it('treats an empty settings map as "clear every pin" — back to the config defaults', async () => {
    const response = await put({ settings: {} })
    expect(response.status).toBe(200)
    expect(savePlatformRetrievalSettings).toHaveBeenCalledWith(
      expect.objectContaining({ settings: {} })
    )
  })

  it('rejects a malformed body with 400', async () => {
    const response = await put({ settings: { 'knowledge.top_k': 'acht' } })
    expect(response.status).toBe(400)
    expect(savePlatformRetrievalSettings).not.toHaveBeenCalled()
  })

  it('surfaces catalog rejections as 422 with per-key errors', async () => {
    savePlatformRetrievalSettings.mockRejectedValue(
      new UnprocessableError('Ungültige Abruf-Einstellungen', {
        errors: ['knowledge.top_k: Der Wert muss mindestens 1 sein.'],
      })
    )
    const response = await put({ settings: { 'knowledge.top_k': 0 } })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { details: { errors: string[] } }
    expect(body.details.errors).toHaveLength(1)
  })

  it('saves even when the platform organization cannot be resolved, logging instead of auditing', async () => {
    getPlatformOrganizationId.mockResolvedValue(null)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const response = await put({ settings: { 'web.max_results': 7 } })
    expect(response.status).toBe(200)
    expect(recordAuditEvent).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })
})
