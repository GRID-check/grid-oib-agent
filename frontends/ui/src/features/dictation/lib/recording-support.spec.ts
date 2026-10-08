import { describe, expect, test } from 'vitest'
import { detectRecordingSupport, isMicrophoneDenied } from './recording-support'

const mic = { mediaDevices: { getUserMedia: () => undefined } }
const recorder = (supported: string[]) => ({ isTypeSupported: (type: string) => supported.includes(type) })

describe('detectRecordingSupport', () => {
  test('Chromium-style browsers record WebM/Opus', () => {
    expect(
      detectRecordingSupport({ navigator: mic, MediaRecorder: recorder(['audio/webm;codecs=opus', 'audio/webm']) }),
    ).toEqual({ available: true, mimeType: 'audio/webm;codecs=opus', format: 'webm' })
  })

  test('Safari-style browsers record MP4, sent as m4a', () => {
    expect(detectRecordingSupport({ navigator: mic, MediaRecorder: recorder(['audio/mp4']) })).toEqual({
      available: true,
      mimeType: 'audio/mp4',
      format: 'm4a',
    })
  })

  test('no supported container disables the button', () => {
    expect(detectRecordingSupport({ navigator: mic, MediaRecorder: recorder(['audio/wav']) })).toEqual({
      available: false,
      reason: 'noFormat',
    })
  })

  test('no microphone API or no recorder is unsupported', () => {
    expect(detectRecordingSupport({ navigator: {}, MediaRecorder: recorder(['audio/webm']) })).toMatchObject({
      reason: 'unsupported',
    })
    expect(detectRecordingSupport({ navigator: mic })).toMatchObject({ reason: 'unsupported' })
    expect(detectRecordingSupport(undefined)).toMatchObject({ reason: 'unsupported' })
  })

  test('an insecure page says so rather than blaming the browser', () => {
    expect(detectRecordingSupport({ isSecureContext: false, navigator: {} })).toMatchObject({ reason: 'insecure' })
  })
})

describe('isMicrophoneDenied', () => {
  test('reads a denied permission without prompting', async () => {
    await expect(isMicrophoneDenied({ query: async () => ({ state: 'denied' }) })).resolves.toBe(true)
    await expect(isMicrophoneDenied({ query: async () => ({ state: 'prompt' }) })).resolves.toBe(false)
  })

  test('a browser that cannot answer is not treated as denied', async () => {
    await expect(isMicrophoneDenied(undefined)).resolves.toBe(false)
    await expect(
      isMicrophoneDenied({
        query: async () => {
          throw new TypeError('microphone is not a valid permission name')
        },
      }),
    ).resolves.toBe(false)
  })
})
