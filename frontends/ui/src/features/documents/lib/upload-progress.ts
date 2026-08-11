/**
 * The truth model behind the upload UI.
 *
 * A document does not have "a progress". It passes through phases, and only ONE
 * of them can be measured:
 *
 *   queued      → waiting for a slot                     (no number exists)
 *   uploading   → bytes are leaving the machine          (a real percentage)
 *   processing  → the backend is reading and indexing it (no number exists)
 *   ready / failed / canceled                            (terminal)
 *
 * The old bar drew one determinate track across all four, so it had to invent a
 * value for three of them — it sat at 15% through the entire upload and then at
 * whatever the ingest job last reported through the entire indexing pass. That
 * is the "always stuck on the same thing": not a rendering bug, a modelling one.
 *
 * So: {@link isDeterminate} is the gate. A phase that cannot be measured never
 * gets a percentage — it gets an indeterminate sweep and an elapsed time, which
 * say "working, duration unknown" instead of asserting a false position.
 *
 * Everything here is pure and takes `now` as an argument, so the whole progress
 * surface is testable without a clock or a DOM.
 */

import type { TrackedFile } from '../types'

/** What the user is waiting for, in the order they experience it. */
export type UploadPhase = 'queued' | 'uploading' | 'processing' | 'ready' | 'failed' | 'canceled'

/** The stage the batch as a whole is in — what the tray header speaks about. */
export type TransferStage = 'transferring' | 'processing' | 'settled'

/** The fields of a {@link TrackedFile} this module reads. */
export type ProgressFile = Pick<
  TrackedFile,
  'id' | 'fileName' | 'fileSize' | 'status' | 'progress' | 'bytesUploaded' | 'uploadStartedAt' | 'errorMessage'
>

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/**
 * Which phase a tracked file is in.
 *
 * `uploadStartedAt` — not `bytesUploaded > 0` — separates queued from uploading:
 * with a bounded number of upload slots most of a large batch is genuinely
 * waiting, and a file that has a slot but has not yet fired its first progress
 * event is still uploading. Guessing from the byte count conflates the two and
 * makes the ninth file of nine look like it stalled at zero.
 */
export function uploadPhase(file: ProgressFile): UploadPhase {
  switch (file.status) {
    case 'failed':
      return 'failed'
    case 'canceled':
      return 'canceled'
    case 'success':
      return 'ready'
    case 'uploading':
      return file.uploadStartedAt ? 'uploading' : 'queued'
    default:
      // 'ingesting' and the client-only 'deleting' are both "the server is
      // doing something we cannot see inside".
      return 'processing'
  }
}

/**
 * Whether a phase has a percentage that means anything.
 *
 * Only bytes-in-flight does. This is the single rule that keeps the UI honest;
 * every bar in the upload surface asks it before choosing a track.
 */
export function isDeterminate(phase: UploadPhase): boolean {
  return phase === 'uploading'
}

/** Terminal phases — nothing further will happen without the user acting. */
export function isTerminal(phase: UploadPhase): boolean {
  return phase === 'ready' || phase === 'failed' || phase === 'canceled'
}

/**
 * Percentage of a file's bytes that have left the machine, or `null` when the
 * file is not in a phase where that question has an answer.
 */
export function uploadPercent(file: ProgressFile): number | null {
  if (!isDeterminate(uploadPhase(file))) return null
  if (!file.fileSize || file.fileSize <= 0) return null
  return clamp(Math.round(((file.bytesUploaded ?? 0) / file.fileSize) * 100), 0, 100)
}

/** Bytes of a file that are already on the server. */
export function uploadedBytes(file: ProgressFile): number {
  const phase = uploadPhase(file)
  // Past the upload, every byte is there by definition — the backend has the
  // file. Counting `bytesUploaded` would under-report a file restored from the
  // server (which never had progress events at all) and stall the batch bar.
  if (phase === 'processing' || phase === 'ready') return file.fileSize
  // A failure keeps whatever it managed to send: a file that failed during
  // INGESTION uploaded completely, and zeroing it would run the batch bar
  // backwards at the exact moment the user is being told something went wrong.
  return clamp(file.bytesUploaded ?? 0, 0, file.fileSize)
}

export interface TransferSummary {
  total: number
  queued: number
  uploading: number
  processing: number
  ready: number
  failed: number
  canceled: number
  /** Payload bytes across every file still counted in the batch. */
  totalBytes: number
  uploadedBytes: number
  /** Bytes still to send — the input to an ETA. */
  remainingBytes: number
  /** 0–100 over the batch's BYTES, or `null` when there are no bytes to move. */
  bytesPercent: number | null
  /** How many files have reached a terminal phase. */
  settled: number
  stage: TransferStage
  /** Nothing is in flight: every file is ready, failed or canceled. */
  isSettled: boolean
}

/**
 * Roll a batch up into the numbers the tray header states.
 *
 * The header's bar tracks BYTES, not file count: a batch of one 150 MB model
 * and eleven 200 KB PDFs would otherwise leap to 92% and then sit there for a
 * minute, which is the same lie in a different costume.
 */
export function summarizeTransfer(files: readonly ProgressFile[]): TransferSummary {
  const summary: TransferSummary = {
    total: files.length,
    queued: 0,
    uploading: 0,
    processing: 0,
    ready: 0,
    failed: 0,
    canceled: 0,
    totalBytes: 0,
    uploadedBytes: 0,
    remainingBytes: 0,
    bytesPercent: null,
    settled: 0,
    stage: 'settled',
    isSettled: true,
  }

  for (const file of files) {
    const phase = uploadPhase(file)
    summary[phase] += 1
    if (isTerminal(phase)) summary.settled += 1
    // A canceled file's bytes are not owed any more, so they leave the
    // denominator too — otherwise cancelling a file freezes the batch bar.
    if (phase === 'canceled') continue
    summary.totalBytes += file.fileSize
    summary.uploadedBytes += uploadedBytes(file)
  }

  summary.remainingBytes = Math.max(0, summary.totalBytes - summary.uploadedBytes)
  summary.bytesPercent =
    summary.totalBytes > 0 ? clamp(Math.round((summary.uploadedBytes / summary.totalBytes) * 100), 0, 100) : null

  if (summary.queued > 0 || summary.uploading > 0) summary.stage = 'transferring'
  else if (summary.processing > 0) summary.stage = 'processing'
  else summary.stage = 'settled'

  summary.isSettled = summary.stage === 'settled'
  return summary
}

/**
 * Minimum byte delta worth pushing into React.
 *
 * The browser fires upload progress every ~50 ms per request; with several
 * concurrent uploads that is a store write and a re-render of the whole tray
 * sixty times a second, to move a bar by a third of a pixel. Coalescing to one
 * percent of the file (floored at 64 KB, so a small file still animates) keeps
 * the motion smooth and the work proportional to what is visible.
 */
const MIN_PROGRESS_STEP_BYTES = 64 * 1024

export function shouldEmitProgress(previous: number, next: number, total: number): boolean {
  if (next <= previous) return false
  if (next >= total) return true
  return next - previous >= Math.max(MIN_PROGRESS_STEP_BYTES, Math.floor(total / 100))
}

/**
 * Split one multi-file request's progress across its files.
 *
 * A multipart body sends its parts in order, so `loaded` fills file 1, then
 * file 2, and so on — attributing it that way is not an approximation, it is
 * what is actually on the wire. `total` exceeds the payload by the multipart
 * framing, so the raw count is scaled back to payload bytes; without that,
 * every file reads a percent or two ahead of the truth.
 */
export function distributeBatchBytes(loaded: number, total: number, sizes: readonly number[]): number[] {
  const payload = sizes.reduce((sum, size) => sum + size, 0)
  if (payload <= 0) return sizes.map(() => 0)
  const scaled = total > 0 ? Math.min(payload, (Math.max(0, loaded) * payload) / total) : 0
  let remaining = scaled
  return sizes.map((size) => {
    const take = Math.min(size, remaining)
    remaining -= take
    return Math.round(take)
  })
}

/**
 * Transfer-rate estimate over a sliding window.
 *
 * Windowed rather than cumulative: an average since the first byte keeps
 * quoting the speed of a connection that has since changed, which is how an ETA
 * ends up counting UP. Deterministic — every method takes the current time, so
 * the estimator is exercised in tests without a clock.
 */
export class TransferRateEstimator {
  private samples: Array<{ at: number; bytes: number }> = []

  constructor(private readonly windowMs: number = 6_000) {}

  reset(): void {
    this.samples = []
  }

  /** Record cumulative bytes transferred at `now` (epoch ms). */
  sample(bytes: number, now: number): void {
    const last = this.samples[this.samples.length - 1]
    // A rewind means a new batch reused the estimator; start over rather than
    // reporting a negative rate.
    if (last && bytes < last.bytes) this.reset()
    this.samples.push({ at: now, bytes })
    const cutoff = now - this.windowMs
    // Keep one sample older than the window so a short window still spans time.
    while (this.samples.length > 2 && this.samples[1].at < cutoff) this.samples.shift()
  }

  /** Bytes per second, or `null` until there is enough signal to say. */
  bytesPerSecond(): number | null {
    if (this.samples.length < 2) return null
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const elapsedMs = last.at - first.at
    if (elapsedMs < 400) return null
    const delta = last.bytes - first.bytes
    if (delta <= 0) return null
    return (delta / elapsedMs) * 1000
  }

  /** Seconds until `remainingBytes` are sent, or `null` when unknowable. */
  etaSeconds(remainingBytes: number): number | null {
    const rate = this.bytesPerSecond()
    if (rate === null || rate <= 0) return null
    if (remainingBytes <= 0) return 0
    return remainingBytes / rate
  }
}
