/**
 * The browser's call to `POST /api/dictation`. Never throws: every outcome is
 * a value the composer can render, because a failed dictation must leave the
 * chat exactly as it was.
 */

import type { DictationAudioFormat, DictationResult } from '@/lib/dictation/contract'

/** Why no text came back; each maps to one inline error message. */
export type DictationFailure = 'rateLimited' | 'tooLarge' | 'notConfigured' | 'failed'

export type DictationOutcome = { ok: true; text: string } | { ok: false; reason: DictationFailure }

export interface DictationRequest {
  audio: Blob
  format: DictationAudioFormat
  durationMs: number
  locale: string
}

function failureFor(status: number): DictationFailure {
  if (status === 429) return 'rateLimited'
  if (status === 413) return 'tooLarge'
  if (status === 503) return 'notConfigured'
  return 'failed'
}

export async function requestDictation(request: DictationRequest, signal?: AbortSignal): Promise<DictationOutcome> {
  const form = new FormData()
  form.append('audio', request.audio, `dictation.${request.format}`)
  form.append('durationMs', String(Math.round(request.durationMs)))
  form.append('locale', request.locale)
  try {
    const response = await fetch('/api/dictation', {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
      signal,
    })
    if (!response.ok) return { ok: false, reason: failureFor(response.status) }
    const data = (await response.json()) as Partial<DictationResult>
    return { ok: true, text: typeof data.text === 'string' ? data.text : '' }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
