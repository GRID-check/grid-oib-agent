/**
 * The microphone button against a fake browser: a `MediaRecorder` that records
 * whatever the test hands it, a microphone that grants or refuses, and an
 * optional level meter. What it pins is the contract with the composer: text
 * through `onTranscript`, a message through `onError`, nothing for silence.
 */

import { act, fireEvent, render, screen, waitFor } from '@/test-utils'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MAX_DICTATION_SECONDS } from '@/lib/dictation/contract'
import { WAVE_BARS, waveHeight } from '../hooks/use-dictation'
import { DictationButton } from './DictationButton'

class FakeRecorder {
  static supported = ['audio/webm;codecs=opus', 'audio/webm']
  static isTypeSupported = (type: string) => FakeRecorder.supported.includes(type)
  static last: FakeRecorder | null = null
  state: 'inactive' | 'recording' = 'inactive'
  mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null

  constructor(_stream: MediaStream, options: { mimeType: string }) {
    this.mimeType = options.mimeType
    FakeRecorder.last = this
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) })
    this.onstop?.()
  }
}

const track = { stop: vi.fn() }
const stream = { getTracks: () => [track] } as unknown as MediaStream
const getUserMedia = vi.fn(async () => stream)
const fetchMock = vi.fn<typeof fetch>()

function installBrowser() {
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  Object.defineProperty(window.navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true })
  vi.stubGlobal('fetch', fetchMock)
}

/** A Web Audio meter that reads `level` on every sample. */
function installMeter(level: number) {
  class FakeAudioContext {
    state = 'running'
    createAnalyser() {
      return {
        fftSize: 0,
        getFloatTimeDomainData: (samples: Float32Array) => samples.fill(level),
      }
    }
    createMediaStreamSource() {
      return { connect: () => {} }
    }
    resume() {
      return Promise.resolve()
    }
    close() {
      return Promise.resolve()
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
}

function renderButton() {
  const onTranscript = vi.fn()
  const onError = vi.fn()
  render(<DictationButton locale="de" onTranscript={onTranscript} onError={onError} />)
  return { onTranscript, onError }
}

async function recordFor(ms: number) {
  fireEvent.click(await screen.findByTestId('dictation-button'))
  await screen.findByTestId('dictation-recording')
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  FakeRecorder.supported = ['audio/webm;codecs=opus', 'audio/webm']
  getUserMedia.mockReset().mockResolvedValue(stream)
  fetchMock.mockReset()
  installBrowser()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('DictationButton', () => {
  test('records, stops on the second press and hands back the transcript', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: 'Prüf das Stiegenhaus.' })))
    const { onTranscript, onError } = renderButton()

    await recordFor(2000)
    fireEvent.click(screen.getByTestId('dictation-recording'))

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Prüf das Stiegenhaus.'))
    expect(onError).not.toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/dictation')
    const form = init?.body as FormData
    expect((form.get('audio') as File).type).toBe('audio/webm;codecs=opus')
    expect(form.get('locale')).toBe('de')
  })

  test(`stops by itself after ${MAX_DICTATION_SECONDS} seconds`, async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: 'Lang.' })))
    const { onTranscript } = renderButton()

    await recordFor(MAX_DICTATION_SECONDS * 1000 + 50)

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Lang.'))
    expect(FakeRecorder.last?.state).toBe('inactive')
  })

  test('a silent recording is never sent and inserts nothing', async () => {
    installMeter(0.001)
    const { onTranscript, onError } = renderButton()

    await recordFor(3000)
    fireEvent.click(screen.getByTestId('dictation-recording'))

    await screen.findByTestId('dictation-button')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onTranscript).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  test('speech above the silence floor is sent', async () => {
    installMeter(0.2)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ text: 'Laut genug.' })))
    const { onTranscript } = renderButton()

    await recordFor(1500)
    fireEvent.click(screen.getByTestId('dictation-recording'))

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('Laut genug.'))
  })

  test('the waveform follows the microphone while recording', async () => {
    installMeter(0.25)
    renderButton()

    await recordFor(1000)

    const bars = screen.getByTestId('dictation-recording').querySelectorAll('[aria-hidden="true"] > span')
    expect(bars).toHaveLength(WAVE_BARS)
    // The newest sample is on the right and is a raised voice: full height.
    expect((bars[bars.length - 1] as HTMLElement).style.transform).toBe('scaleY(1.00)')
  })

  test('wave heights: silence is flat, quiet speech still moves, loud speech caps', () => {
    expect(waveHeight(0)).toBe(0)
    expect(waveHeight(0.02)).toBeGreaterThan(0.25)
    expect(waveHeight(5)).toBe(1)
  })

  test('a failed transcription is an inline error, never text', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 502 }))
    const { onTranscript, onError } = renderButton()

    await recordFor(1500)
    fireEvent.click(screen.getByTestId('dictation-recording'))

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('The recording could not be transcribed. Your message is unchanged.'),
    )
    expect(onTranscript).not.toHaveBeenCalled()
    await screen.findByTestId('dictation-button')
  })

  test('a refused microphone disables the button and says why', async () => {
    getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    const { onError } = renderButton()

    fireEvent.click(await screen.findByTestId('dictation-button'))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Microphone access was not allowed.'))
    const unavailable = await screen.findByTestId('dictation-unavailable')
    expect(unavailable.querySelector('button')?.disabled).toBe(true)
    expect(unavailable.querySelector('button')?.getAttribute('aria-label')).toMatch(/Microphone access is blocked/)
  })

  test('a browser with no usable audio format gets a disabled button with the reason', async () => {
    FakeRecorder.supported = []
    renderButton()

    const unavailable = await screen.findByTestId('dictation-unavailable')
    expect(unavailable.querySelector('button')?.disabled).toBe(true)
    expect(unavailable.querySelector('button')?.getAttribute('aria-label')).toMatch(
      /records no audio format Piloti can transcribe/,
    )
  })
})
