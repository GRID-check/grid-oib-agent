/**
 * Voice dictation, server side: one recording in, the composer's text out.
 *
 * The BFF owns who may dictate and how much; the Python route
 * (`frontends/aiq_api/src/aiq_api/routes/dictation.py`) owns the provider call,
 * because that is where the organization's credential, its data policy and the
 * provider limiter already live. Nothing here touches a budget: dictation is
 * booked on the ledger by the backend as an unbilled activity, and the
 * `DICTATION_LIMIT` rate limit on the route is its bound instead.
 *
 * Every failure is an `ApiError` the composer shows inline; none of them
 * touches the chat.
 */

import 'server-only'
import {
  BadRequestError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  UpstreamError,
} from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getBackendUrl } from '@/lib/backend-proxy'
import { INTERNAL_TOKEN_HEADER } from '@/lib/internal-auth'
import {
  MAX_DICTATION_AUDIO_BYTES,
  dictationFormatOf,
  type DictationResult,
} from './contract'

/** The Python route's bound on a reported duration; a recording stops at 45 s. */
const MAX_REPORTED_DURATION_MS = 120_000

/** Two provider attempts of 25 s each, plus the hop. */
const BACKEND_TIMEOUT_MS = 60_000

export interface DictationInput {
  audio: Blob
  /** What the browser measured; the ledger keeps it when the provider reports no duration. */
  durationMs: number | null
  /** The member's UI language: a wording hint only, never the transcription language. */
  locale: string | null
}

interface BackendDictationResponse {
  text?: string
  error?: string | null
}

/** The backend's failure codes, as the error the composer shows. */
function toApiError(code: string): Error {
  switch (code) {
    case 'audio_too_large':
      return new PayloadTooLargeError(MAX_DICTATION_AUDIO_BYTES)
    case 'audio_invalid':
      return new BadRequestError('The recording could not be read.')
    case 'transcription_not_configured':
      return new ServiceUnavailableError('Voice input is not configured.')
    default:
      return new UpstreamError('The recording could not be transcribed.')
  }
}

function checkedFormat(audio: Blob): string {
  if (audio.size === 0) throw new BadRequestError('The recording is empty.')
  if (audio.size > MAX_DICTATION_AUDIO_BYTES) throw new PayloadTooLargeError(MAX_DICTATION_AUDIO_BYTES)
  const format = dictationFormatOf(audio.type)
  if (!format) throw new BadRequestError('Unsupported audio format.')
  return format
}

async function postToBackend(session: AuthorizedSession, body: object): Promise<Response> {
  try {
    return await fetch(`${getBackendUrl()}/v1/dictation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: process.env.GRID_INTERNAL_API_TOKEN ?? '',
        // Whose credential and data policy, and whose ledger row.
        'x-grid-organization-id': session.organizationId,
        'x-grid-user-id': session.userId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS),
    })
  } catch (error) {
    console.warn('[Dictation] Backend unreachable or timed out:', error)
    throw new UpstreamError('The recording could not be transcribed.')
  }
}

/** Transcribe one recording for the member's composer. Throws an `ApiError` on every failure. */
export async function transcribeDictation(
  session: AuthorizedSession,
  input: DictationInput,
): Promise<DictationResult> {
  const format = checkedFormat(input.audio)
  const audioBase64 = Buffer.from(await input.audio.arrayBuffer()).toString('base64')
  const durationMs =
    input.durationMs === null ? null : Math.min(Math.max(Math.round(input.durationMs), 0), MAX_REPORTED_DURATION_MS)

  const response = await postToBackend(session, {
    audio_base64: audioBase64,
    format,
    duration_ms: durationMs,
    locale: input.locale,
  })
  if (!response.ok) {
    console.error('[Dictation] Backend error:', response.status, await response.text().catch(() => ''))
    throw new UpstreamError('The recording could not be transcribed.')
  }

  const data = (await response.json()) as BackendDictationResponse
  if (data.error) {
    console.warn('[Dictation] Transcription degraded:', data.error)
    throw toApiError(data.error)
  }
  return { text: typeof data.text === 'string' ? data.text : '' }
}
