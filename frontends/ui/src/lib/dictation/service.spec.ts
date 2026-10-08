import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthorizedSession } from '@/lib/auth/types'
import { MAX_DICTATION_AUDIO_BYTES, dictationFormatOf } from './contract'
import { transcribeDictation } from './service'

vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))

const session = {
  userId: 'user_1',
  organizationId: 'org_1',
} as unknown as AuthorizedSession

const fetchMock = vi.fn<typeof fetch>()

function webm(bytes = 16): Blob {
  return new Blob([new Uint8Array(bytes)], { type: 'audio/webm;codecs=opus' })
}

function backendReply(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dictationFormatOf', () => {
  test.each([
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/mp4', 'm4a'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/wav', null],
    ['', null],
  ])('%s is sent as %s', (mimeType, format) => {
    expect(dictationFormatOf(mimeType)).toBe(format)
  })
})

describe('transcribeDictation', () => {
  test('sends the recording, the member and the UI language, never a fixed transcription language', async () => {
    fetchMock.mockResolvedValue(backendReply({ text: 'Prüf das Stiegenhaus, the fire rating.' }))

    const result = await transcribeDictation(session, { audio: webm(), durationMs: 4200, locale: 'de' })

    expect(result).toEqual({ text: 'Prüf das Stiegenhaus, the fire rating.' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://backend:8000/v1/dictation')
    const headers = init?.headers as Record<string, string>
    expect(headers['x-grid-organization-id']).toBe('org_1')
    expect(headers['x-grid-user-id']).toBe('user_1')
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({ format: 'webm', duration_ms: 4200, locale: 'de' })
    expect(body).not.toHaveProperty('language')
    expect(Buffer.from(body.audio_base64, 'base64')).toHaveLength(16)
  })

  test('silence comes back as empty text, not an error', async () => {
    fetchMock.mockResolvedValue(backendReply({ text: '', error: null }))
    await expect(transcribeDictation(session, { audio: webm(), durationMs: 900, locale: null })).resolves.toEqual({
      text: '',
    })
  })

  test('refuses an oversized or unknown recording before calling the backend', async () => {
    const large = new Blob([new Uint8Array(MAX_DICTATION_AUDIO_BYTES + 1)], { type: 'audio/webm' })
    await expect(transcribeDictation(session, { audio: large, durationMs: null, locale: null })).rejects.toMatchObject(
      { status: 413 },
    )
    const wav = new Blob([new Uint8Array(8)], { type: 'audio/wav' })
    await expect(transcribeDictation(session, { audio: wav, durationMs: null, locale: null })).rejects.toMatchObject({
      status: 400,
    })
    const empty = new Blob([], { type: 'audio/webm' })
    await expect(transcribeDictation(session, { audio: empty, durationMs: null, locale: null })).rejects.toMatchObject(
      { status: 400 },
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    ['transcription_failed', 502],
    ['transcription_not_configured', 503],
    ['audio_too_large', 413],
    ['audio_invalid', 400],
  ])('the backend code %s fails open as HTTP %i', async (code, status) => {
    fetchMock.mockResolvedValue(backendReply({ text: '', error: code }))
    await expect(transcribeDictation(session, { audio: webm(), durationMs: 1000, locale: 'en' })).rejects.toMatchObject(
      { status },
    )
  })

  test('an unreachable or broken backend is an upstream error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    await expect(transcribeDictation(session, { audio: webm(), durationMs: 1000, locale: 'en' })).rejects.toMatchObject(
      { status: 502 },
    )
    fetchMock.mockResolvedValueOnce(backendReply({ detail: 'boom' }, 500))
    await expect(transcribeDictation(session, { audio: webm(), durationMs: 1000, locale: 'en' })).rejects.toMatchObject(
      { status: 502 },
    )
  })
})
