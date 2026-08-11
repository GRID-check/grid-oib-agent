import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { xhrUpload, XhrUploadError } from './xhr-upload'
import { installFakeXhr, type FakeXhrHandle } from '@/test-utils/xhr-mock'

describe('xhrUpload', () => {
  let xhr: FakeXhrHandle

  beforeEach(() => {
    xhr = installFakeXhr()
  })

  afterEach(() => {
    xhr.restore()
  })

  const upload = (overrides: Partial<Parameters<typeof xhrUpload>[0]> = {}) =>
    xhrUpload({ url: '/api/documents/upload', body: new FormData(), ...overrides })

  test('resolves with the response text on 2xx', async () => {
    const pending = upload()
    xhr.last().respond(201, '{"documentId":"doc-1"}')
    await expect(pending).resolves.toBe('{"documentId":"doc-1"}')
  })

  test('reports upload progress only for computable events', async () => {
    const onProgress = vi.fn()
    const pending = upload({ onProgress })
    xhr.last().emitProgress(1_024, 4_096)
    xhr.last().respond(200, '{}')
    await pending

    expect(onProgress).toHaveBeenCalledExactlyOnceWith(1_024, 4_096)
  })

  test('a non-2xx carries the status and the body, so the caller can lift the reason', async () => {
    const pending = upload()
    xhr.last().respond(413, '{"error":"File too large"}')

    await expect(pending).rejects.toBeInstanceOf(XhrUploadError)
    await pending.catch((error: XhrUploadError) => {
      expect(error.status).toBe(413)
      expect(error.responseText).toBe('{"error":"File too large"}')
    })
  })

  test('a network failure is distinguishable from a refusal', async () => {
    const pending = upload()
    xhr.last().failNetwork()
    await expect(pending).rejects.toThrow('network error')
  })

  test('a timeout says so', async () => {
    const pending = upload({ timeoutMs: 5_000 })
    expect(xhr.last().timeout).toBe(5_000)
    xhr.last().timeOut()
    await expect(pending).rejects.toThrow('timed out')
  })

  test('an already-aborted signal never opens a request', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(upload({ signal: controller.signal })).rejects.toThrow(/aborted/i)
    expect(xhr.requests).toHaveLength(0)
  })

  test('aborting mid-flight stops the transfer and rejects with an AbortError', async () => {
    const controller = new AbortController()
    const pending = upload({ signal: controller.signal })
    controller.abort()

    expect(xhr.last().aborted).toBe(true)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('sets the caller headers but leaves Content-Type to the browser', async () => {
    const pending = upload({ headers: { Authorization: 'Bearer token' } })
    xhr.last().respond(200, '{}')
    await pending

    expect(xhr.last().headers).toEqual({ Authorization: 'Bearer token' })
  })
})
