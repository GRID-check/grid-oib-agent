/**
 * Voice dictation: the bounds and formats the browser and the BFF agree on.
 *
 * Imported by both sides, so it imports nothing. The design, and the parts
 * still unverified against a live provider, are in
 * `docs/architecture/voice-dictation.md`.
 */

/** A recording stops on its own after this long. */
export const MAX_DICTATION_SECONDS = 45

/**
 * The largest recording the BFF accepts, in bytes. 45 seconds at the 64 kbit/s
 * the recorder asks for is about 360 KB; the ceiling leaves room for a browser
 * that ignores the requested bitrate. The Python route re-applies the same
 * number (`MAX_DICTATION_AUDIO_BYTES` in `aiq_api/models/requests.py`).
 */
export const MAX_DICTATION_AUDIO_BYTES = 4 * 1024 * 1024

/** The bitrate the recorder asks for. Speech needs no more. */
export const DICTATION_AUDIO_BITS_PER_SECOND = 64_000

/** How the transcription endpoint names each container a browser records. */
export type DictationAudioFormat = 'webm' | 'ogg' | 'm4a'

/**
 * The recorder MIME types tried in order, with the format each is sent as.
 * Chromium and Firefox record WebM/Opus (Firefox also Ogg), Safari records MP4/AAC.
 */
export const DICTATION_RECORDING_TYPES: ReadonlyArray<{ mimeType: string; format: DictationAudioFormat }> = [
  { mimeType: 'audio/webm;codecs=opus', format: 'webm' },
  { mimeType: 'audio/webm', format: 'webm' },
  { mimeType: 'audio/mp4', format: 'm4a' },
  { mimeType: 'audio/ogg;codecs=opus', format: 'ogg' },
]

/** The wire format for a recorded blob's MIME type, or null when it is not one we send. */
export function dictationFormatOf(mimeType: string): DictationAudioFormat | null {
  const base = mimeType.split(';')[0]?.trim().toLowerCase()
  if (base === 'audio/webm' || base === 'video/webm') return 'webm'
  if (base === 'audio/mp4' || base === 'video/mp4' || base === 'audio/x-m4a' || base === 'audio/aac') return 'm4a'
  if (base === 'audio/ogg') return 'ogg'
  return null
}

/** The BFF's answer: the cleaned transcript, empty when nothing was said. */
export interface DictationResult {
  text: string
}
