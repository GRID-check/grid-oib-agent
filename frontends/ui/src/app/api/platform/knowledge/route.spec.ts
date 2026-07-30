import { beforeEach, describe, expect, it, vi } from 'vitest'

const isOwner = { value: false }

vi.mock('@/lib/auth/session', () => ({
  getGridSession: vi.fn().mockResolvedValue({ userId: 'user_1', organizationId: 'org_1' }),
}))

vi.mock('@/lib/auth/require-auth', () => ({
  authzErrorResponse: () => null,
}))

vi.mock('@/lib/authz/platform', () => {
  // Defined inside the factory: vi.mock is hoisted above module-level classes.
  class PlatformAccessDeniedError extends Error {
    readonly status = 403
  }
  return {
    PlatformAccessDeniedError,
    requirePlatformOwner: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) {
        throw new PlatformAccessDeniedError()
      }
    }),
  }
})

const uploadMock = vi.hoisted(() => vi.fn())
const deleteMock = vi.hoisted(() => vi.fn())
const syncMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/knowledge/service', () => ({
  uploadKnowledgeBaseDocument: uploadMock,
  deleteKnowledgeBaseDocument: deleteMock,
  syncKnowledgeBase: syncMock,
}))

import { POST as uploadRoute } from './documents/route'
import { DELETE as deleteRoute } from './documents/[fileName]/route'
import { POST as syncRoute } from './sync/route'

function uploadRequest(withFile = true): Request {
  const form = new FormData()
  if (withFile) {
    form.append(
      'file',
      new File([new Uint8Array([1, 2, 3])], 'norm.pdf', { type: 'application/pdf' })
    )
  }
  return new Request('https://grid.example/api/platform/knowledge/documents', {
    method: 'POST',
    body: form,
  })
}

describe('platform knowledge routes', () => {
  beforeEach(() => {
    isOwner.value = false
    uploadMock.mockReset()
    deleteMock.mockReset()
    syncMock.mockReset()
  })

  it('rejects non-owners with 403 on every route', async () => {
    expect((await uploadRoute(uploadRequest())).status).toBe(403)
    expect(
      (
        await deleteRoute(new Request('https://grid.example', { method: 'DELETE' }), {
          params: Promise.resolve({ fileName: 'norm.pdf' }),
        })
      ).status
    ).toBe(403)
    expect((await syncRoute(new Request('https://grid.example', { method: 'POST' }))).status).toBe(
      403
    )
    expect(uploadMock).not.toHaveBeenCalled()
    expect(deleteMock).not.toHaveBeenCalled()
    expect(syncMock).not.toHaveBeenCalled()
  })

  it('uploads a PDF for the platform owner', async () => {
    isOwner.value = true
    uploadMock.mockResolvedValue({ status: 'success', fileName: 'norm.pdf', message: 'ok' })

    const res = await uploadRoute(uploadRequest())

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'success', fileName: 'norm.pdf' })
    expect(uploadMock).toHaveBeenCalledTimes(1)
  })

  it('maps a failed ingestion to 502 so the UI can surface it', async () => {
    isOwner.value = true
    uploadMock.mockResolvedValue({ status: 'failed', fileName: 'norm.pdf', message: 'boom' })

    expect((await uploadRoute(uploadRequest())).status).toBe(502)
  })

  it('rejects an upload without a file', async () => {
    isOwner.value = true
    expect((await uploadRoute(uploadRequest(false))).status).toBe(400)
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('deletes an uploaded document for the platform owner', async () => {
    isOwner.value = true
    deleteMock.mockResolvedValue(undefined)

    const res = await deleteRoute(new Request('https://grid.example', { method: 'DELETE' }), {
      params: Promise.resolve({ fileName: 'norm.pdf' }),
    })

    expect(res.status).toBe(200)
    expect(deleteMock).toHaveBeenCalledWith('norm.pdf')
  })

  it('triggers a corpus sync for the platform owner', async () => {
    isOwner.value = true
    syncMock.mockResolvedValue({ filesAdded: 2, filesTotal: 41, message: 'ok' })

    const res = await syncRoute(new Request('https://grid.example', { method: 'POST' }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ filesAdded: 2, filesTotal: 41 })
  })
})
