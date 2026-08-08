/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const isOwner = { value: false }

vi.mock('@/lib/auth/session', () => ({
  getGridSession: vi
    .fn()
    .mockResolvedValue({ userId: 'user_1', email: 'owner@example.com', organizationId: null }),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  authzErrorResponse: () => null,
}))

vi.mock('@/lib/authz/platform', () => {
  class PlatformAccessDeniedError extends Error {
    readonly status = 403
  }
  return {
    PlatformAccessDeniedError,
    requirePlatformOwner: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) throw new PlatformAccessDeniedError()
    }),
  }
})

const service = vi.hoisted(() => ({
  listPlatformTemplates: vi.fn(),
  createPlatformTemplate: vi.fn(),
  updatePlatformTemplate: vi.fn(),
  deletePlatformTemplate: vi.fn(),
}))
vi.mock('@/lib/platform-workflow-templates/service', () => service)

import { GET, POST } from './route'
import { PATCH, DELETE } from './[templateId]/route'

const validBody = () => ({
  content: {
    de: {
      name: 'DE',
      description: 'd',
      category: 'C',
      definition: { version: 1, blocks: { objective: 'o' } },
    },
    en: {
      name: 'EN',
      description: 'd',
      category: 'C',
      definition: { version: 1, blocks: { objective: 'o' } },
    },
  },
})

const postRequest = (body: unknown) =>
  new Request('https://grid.example/api/platform/workflow-templates', {
    method: 'POST',
    body: JSON.stringify(body),
  })

const patchRequest = (body: unknown) =>
  new Request('https://grid.example/api/platform/workflow-templates/tpl_1', {
    method: 'PATCH',
    body: JSON.stringify(body),
  })

const itemParams = { params: Promise.resolve({ templateId: 'tpl_1' }) }

describe('platform workflow-templates routes', () => {
  beforeEach(() => {
    isOwner.value = false
    vi.clearAllMocks()
  })

  it('rejects non-owners with 403 on every route', async () => {
    expect((await GET(new Request('http://localhost/api/platform'))).status).toBe(403)
    expect((await POST(postRequest(validBody()))).status).toBe(403)
    expect((await PATCH(patchRequest({ published: true }), itemParams)).status).toBe(403)
    expect(
      (await DELETE(new Request('https://grid.example', { method: 'DELETE' }), itemParams)).status
    ).toBe(403)
    expect(service.createPlatformTemplate).not.toHaveBeenCalled()
    expect(service.deletePlatformTemplate).not.toHaveBeenCalled()
  })

  describe('as platform owner', () => {
    beforeEach(() => {
      isOwner.value = true
    })

    it('creates a template (201) and records the actor', async () => {
      service.createPlatformTemplate.mockResolvedValue({ id: 'tpl_1' })
      const res = await POST(postRequest(validBody()))
      expect(res.status).toBe(201)
      expect(service.createPlatformTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.any(Object) }),
        { userId: 'user_1', email: 'owner@example.com' }
      )
    })

    it('rejects an invalid create body with 400', async () => {
      const res = await POST(postRequest({ content: { de: { name: 'x' } } }))
      expect(res.status).toBe(400)
      expect(service.createPlatformTemplate).not.toHaveBeenCalled()
    })

    it('patches a template (200) and 404s an unknown id', async () => {
      service.updatePlatformTemplate.mockResolvedValueOnce({ id: 'tpl_1', published: true })
      expect((await PATCH(patchRequest({ published: true }), itemParams)).status).toBe(200)

      service.updatePlatformTemplate.mockResolvedValueOnce(null)
      expect((await PATCH(patchRequest({ published: true }), itemParams)).status).toBe(404)
    })

    it('deletes a template (204) and 404s an unknown id', async () => {
      service.deletePlatformTemplate.mockResolvedValueOnce(true)
      expect(
        (await DELETE(new Request('https://grid.example', { method: 'DELETE' }), itemParams)).status
      ).toBe(204)

      service.deletePlatformTemplate.mockResolvedValueOnce(false)
      expect(
        (await DELETE(new Request('https://grid.example', { method: 'DELETE' }), itemParams)).status
      ).toBe(404)
    })
  })
})
