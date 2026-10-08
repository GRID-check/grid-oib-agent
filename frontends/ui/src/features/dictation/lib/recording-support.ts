/**
 * Whether this browser can dictate, and in which container. Decided once, from
 * what the browser offers, so the button can be disabled and say why before
 * anyone presses it.
 */

import { DICTATION_RECORDING_TYPES, type DictationAudioFormat } from '@/lib/dictation/contract'

/** Why the microphone button is disabled; each has its own hover text. */
export type DictationUnavailableReason = 'unsupported' | 'insecure' | 'noFormat' | 'denied'

export type RecordingSupport =
  | { available: true; mimeType: string; format: DictationAudioFormat }
  | { available: false; reason: DictationUnavailableReason }

/** The slice of `window` the decision reads; injectable for tests. */
export interface RecordingEnvironment {
  isSecureContext?: boolean
  navigator?: { mediaDevices?: { getUserMedia?: unknown } }
  MediaRecorder?: { isTypeSupported?: (mimeType: string) => boolean }
}

export function detectRecordingSupport(env: RecordingEnvironment | undefined): RecordingSupport {
  if (!env) return { available: false, reason: 'unsupported' }
  // Browsers hide `mediaDevices` entirely outside a secure context, so say
  // which of the two it is: one is fixed by the deployment, not the browser.
  if (env.isSecureContext === false) return { available: false, reason: 'insecure' }
  if (typeof env.navigator?.mediaDevices?.getUserMedia !== 'function' || !env.MediaRecorder) {
    return { available: false, reason: 'unsupported' }
  }
  const isTypeSupported = env.MediaRecorder.isTypeSupported
  if (typeof isTypeSupported !== 'function') return { available: false, reason: 'noFormat' }
  const match = DICTATION_RECORDING_TYPES.find(({ mimeType }) => isTypeSupported.call(env.MediaRecorder, mimeType))
  return match ? { available: true, ...match } : { available: false, reason: 'noFormat' }
}

/**
 * Whether the microphone permission is already denied, without prompting.
 * `false` when the browser cannot say (Firefox has no `microphone` permission
 * name): the prompt on first press is then what tells us.
 */
export async function isMicrophoneDenied(
  permissions: { query?: (descriptor: { name: PermissionName }) => Promise<{ state: string }> } | undefined,
): Promise<boolean> {
  if (typeof permissions?.query !== 'function') return false
  try {
    const status = await permissions.query({ name: 'microphone' })
    return status.state === 'denied'
  } catch {
    return false
  }
}
