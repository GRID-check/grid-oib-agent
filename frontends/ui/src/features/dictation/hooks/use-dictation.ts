'use client'

/**
 * One microphone button's lifecycle: check support, record up to 45 seconds,
 * send, hand the text back. The composer only ever sees `onTranscript` with
 * text to insert, or `onError` with a message key; it never sees audio.
 *
 * Silence is decided here, before anything is sent: a recording shorter than
 * {@link MIN_RECORDING_MS}, or whose loudest moment stayed under
 * {@link SILENCE_RMS}, inserts nothing and costs nothing. Transcription models
 * invent text over silence (subtitle credits, "Thank you."), so not sending it
 * is the reliable half; the backend drops the known phrases as the other.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { DICTATION_AUDIO_BITS_PER_SECOND, MAX_DICTATION_SECONDS } from '@/lib/dictation/contract'
import { requestDictation, type DictationFailure } from '../lib/client'
import {
  detectRecordingSupport,
  isMicrophoneDenied,
  type DictationUnavailableReason,
  type RecordingSupport,
} from '../lib/recording-support'

/** Below this peak RMS level (of 1.0) a recording held no speech. Speech into a laptop mic peaks well above 0.05. */
export const SILENCE_RMS = 0.01
/** A press-and-release this short is a misclick, not an utterance. */
export const MIN_RECORDING_MS = 400
/** How often the level is read: the silence gate's sample rate and the waveform's frame rate. */
const LEVEL_SAMPLE_MS = 60
/** How many recent levels the waveform shows. */
export const WAVE_BARS = 14
/** The RMS a raised voice reaches; the waveform's full height. */
const WAVE_FULL_RMS = 0.25

/** A raw RMS reading as a bar height from 0 to 1. Square-rooted, so quiet speech still moves the bars. */
export function waveHeight(rms: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, rms) / WAVE_FULL_RMS))
}

const SILENT_WAVE: readonly number[] = Array.from({ length: WAVE_BARS }, () => 0)

export type DictationErrorKey = DictationFailure | 'noMicrophone' | 'denied'

export type DictationState =
  | { phase: 'checking' }
  | { phase: 'unavailable'; reason: DictationUnavailableReason }
  | { phase: 'idle' }
  | { phase: 'starting' }
  | {
      phase: 'recording'
      elapsedSeconds: number
      /** The last {@link WAVE_BARS} levels, 0 to 1, oldest first: the live waveform. */
      levels: readonly number[]
    }
  | { phase: 'transcribing' }

export interface UseDictationOptions {
  /** The UI language, sent as a wording hint. Never fixes the transcription language. */
  locale: string
  onTranscript: (text: string) => void
  onError: (key: DictationErrorKey) => void
}

interface LevelMeter {
  context: AudioContext
  read: () => number
}

interface RecordingSession {
  stream: MediaStream | null
  recorder: MediaRecorder | null
  meter: LevelMeter | null
  chunks: Blob[]
  startedAt: number
  peak: number
  ticker: ReturnType<typeof setInterval> | null
  limit: ReturnType<typeof setTimeout> | null
  cancelled: boolean
}

type AudioContextConstructor = new () => AudioContext

/** Created inside the click, before any await: Safari starts a context made later suspended. */
function createAudioContext(): AudioContext | null {
  const scope = window as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor }
  const Context = scope.AudioContext ?? scope.webkitAudioContext
  if (!Context) return null
  try {
    return new Context()
  } catch {
    return null
  }
}

function attachMeter(context: AudioContext | null, stream: MediaStream): LevelMeter | null {
  if (!context) return null
  try {
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    context.createMediaStreamSource(stream).connect(analyser)
    void context.resume().catch(() => {})
    const samples = new Float32Array(analyser.fftSize)
    return {
      context,
      read: () => {
        analyser.getFloatTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) sum += sample * sample
        return Math.sqrt(sum / samples.length)
      },
    }
  } catch {
    return null
  }
}

function release(session: RecordingSession): void {
  if (session.ticker) clearInterval(session.ticker)
  if (session.limit) clearTimeout(session.limit)
  session.stream?.getTracks().forEach((track) => track.stop())
  void session.meter?.context.close().catch(() => {})
}

/** Whether a finished recording held speech worth sending. */
export function heldSpeech(durationMs: number, peak: number, meterTrusted: boolean): boolean {
  if (durationMs < MIN_RECORDING_MS) return false
  // A meter that never ran (no Web Audio, a suspended context) proves nothing: send.
  return !meterTrusted || peak >= SILENCE_RMS
}

function startErrorKey(error: unknown): DictationErrorKey {
  const name = error instanceof DOMException || error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'noMicrophone'
  return 'failed'
}

export function useDictation({ locale, onTranscript, onError }: UseDictationOptions) {
  const [state, setState] = useState<DictationState>({ phase: 'checking' })
  const supportRef = useRef<RecordingSupport | null>(null)
  const sessionRef = useRef<RecordingSession | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const callbacks = useRef({ locale, onTranscript, onError })
  useEffect(() => {
    callbacks.current = { locale, onTranscript, onError }
  }, [locale, onTranscript, onError])

  useEffect(() => {
    let live = true
    const support = detectRecordingSupport(window)
    supportRef.current = support
    if (!support.available) {
      setState({ phase: 'unavailable', reason: support.reason })
      return
    }
    void isMicrophoneDenied(navigator.permissions).then((denied) => {
      if (live) setState(denied ? { phase: 'unavailable', reason: 'denied' } : { phase: 'idle' })
    })
    return () => {
      live = false
      const session = sessionRef.current
      if (session) {
        session.cancelled = true
        release(session)
      }
      abortRef.current?.abort()
    }
  }, [])

  const send = useCallback(async (audio: Blob, durationMs: number) => {
    const support = supportRef.current
    if (!support?.available) return
    setState({ phase: 'transcribing' })
    const controller = new AbortController()
    abortRef.current = controller
    const outcome = await requestDictation(
      { audio, format: support.format, durationMs, locale: callbacks.current.locale },
      controller.signal,
    )
    if (controller.signal.aborted) return
    setState({ phase: 'idle' })
    if (outcome.ok) callbacks.current.onTranscript(outcome.text)
    else callbacks.current.onError(outcome.reason)
  }, [])

  const finish = useCallback(
    (session: RecordingSession) => {
      const durationMs = Date.now() - session.startedAt
      const meterTrusted = session.meter?.context.state === 'running'
      release(session)
      sessionRef.current = null
      if (session.cancelled) return
      const type = session.recorder?.mimeType || (supportRef.current?.available ? supportRef.current.mimeType : '')
      const audio = new Blob(session.chunks, { type })
      if (audio.size === 0 || !heldSpeech(durationMs, session.peak, meterTrusted)) {
        setState({ phase: 'idle' })
        return
      }
      void send(audio, durationMs)
    },
    [send],
  )

  const stop = useCallback(() => {
    const recorder = sessionRef.current?.recorder
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  }, [])

  const record = useCallback(
    (session: RecordingSession, stream: MediaStream, mimeType: string) => {
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: DICTATION_AUDIO_BITS_PER_SECOND })
      session.recorder = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) session.chunks.push(event.data)
      }
      recorder.onstop = () => finish(session)
      recorder.start()
      session.startedAt = Date.now()
      session.ticker = setInterval(() => {
        const level = session.meter?.read() ?? 0
        session.peak = Math.max(session.peak, level)
        const elapsedSeconds = Math.floor((Date.now() - session.startedAt) / 1000)
        // Only this button re-renders: the state lives here, not in the composer.
        setState((current) => ({
          phase: 'recording',
          elapsedSeconds,
          levels: [...(current.phase === 'recording' ? current.levels : SILENT_WAVE).slice(1), waveHeight(level)],
        }))
      }, LEVEL_SAMPLE_MS)
      session.limit = setTimeout(stop, MAX_DICTATION_SECONDS * 1000)
      setState({ phase: 'recording', elapsedSeconds: 0, levels: SILENT_WAVE })
    },
    [finish, stop],
  )

  const start = useCallback(async () => {
    const support = supportRef.current
    if (!support?.available) return
    const session: RecordingSession = {
      stream: null,
      recorder: null,
      meter: null,
      chunks: [],
      startedAt: Date.now(),
      peak: 0,
      ticker: null,
      limit: null,
      cancelled: false,
    }
    sessionRef.current = session
    const context = createAudioContext()
    setState({ phase: 'starting' })
    try {
      session.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      })
      session.meter = attachMeter(context, session.stream)
      if (!session.meter) void context?.close().catch(() => {})
      if (session.cancelled) return release(session)
      record(session, session.stream, support.mimeType)
    } catch (error) {
      release(session)
      if (!session.meter) void context?.close().catch(() => {})
      sessionRef.current = null
      const key = startErrorKey(error)
      setState(key === 'denied' ? { phase: 'unavailable', reason: 'denied' } : { phase: 'idle' })
      callbacks.current.onError(key)
    }
  }, [record])

  const toggle = useCallback(() => {
    if (state.phase === 'idle') void start()
    else if (state.phase === 'recording') stop()
  }, [state.phase, start, stop])

  return { state, toggle }
}
