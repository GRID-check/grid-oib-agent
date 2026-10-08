/**
 * Browser-side client for the Outlook archive import (ADR-0085). The import
 * dialog calls these; nothing else in the browser talks to the routes.
 *
 * The archive goes up in parts of the size the server names, a few at a time.
 * A part that fails is sent again (a part sent twice replaces itself), a 429 is
 * waited out with the server's `Retry-After`, and a send that broke off is
 * resumed by asking the server which parts it already holds. Nothing here is
 * held in memory beyond the parts in flight: `File.slice` reads from disk.
 *
 * A send of twenty gigabytes takes hours, so it outlasts the ordinary outage of
 * a laptop: a Wi-Fi roam, a lid closed for a minute, a gateway restarting. A
 * part keeps being retried for {@link PART_RETRY_BUDGET_MS}, and while the
 * browser says it is offline it waits for the connection to come back instead
 * of spending that time. Only a refusal (a 4xx other than 429) ends it at once.
 */

import type { MailImportList, MailImportUploadPlan, MailImportView } from './types'

/** Parts in flight at once. Enough to fill a line; few enough to leave room for the rest of the app. */
const PARALLEL_PARTS = 3
/** How long one part is retried before the send gives up and has to be resumed by hand. */
const PART_RETRY_BUDGET_MS = 15 * 60_000
/** The longest wait between two tries of a part. */
const MAX_RETRY_DELAY_MS = 30_000

export class MailImportRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message)
    this.name = 'MailImportRequestError'
  }
}

function base(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/mail-imports`
}

export async function fetchMailImports(projectId: string, signal?: AbortSignal): Promise<MailImportList> {
  return json(await fetch(base(projectId), { credentials: 'same-origin', signal }))
}

export async function startMailImport(projectId: string, file: File): Promise<MailImportUploadPlan> {
  return json(
    await fetch(base(projectId), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, sizeBytes: file.size }),
    }),
  )
}

export async function resumeMailImport(projectId: string, importId: string): Promise<MailImportUploadPlan> {
  return json(await fetch(`${base(projectId)}/${encodeURIComponent(importId)}`, { credentials: 'same-origin' }))
}

export async function cancelMailImport(projectId: string, importId: string): Promise<MailImportView> {
  return json(
    await fetch(`${base(projectId)}/${encodeURIComponent(importId)}`, { method: 'DELETE', credentials: 'same-origin' }),
  )
}

export interface SendProgress {
  sentBytes: number
  totalBytes: number
  /** `joining` once every part is there and the server joins them, which takes a while for hundreds. */
  phase: 'sending' | 'joining'
}

/**
 * Send every part the plan does not already hold, then complete the upload.
 * Rejects on a part that keeps failing, or when `signal` aborts.
 */
export async function sendMailArchive(
  projectId: string,
  plan: MailImportUploadPlan,
  file: File,
  onProgress: (progress: SendProgress) => void,
  signal?: AbortSignal,
): Promise<MailImportView> {
  const importId = plan.import.id
  const held = new Set(plan.uploadedParts)
  const pending = Array.from({ length: plan.partCount }, (_, i) => i + 1).filter((n) => !held.has(n))
  let sentBytes = [...held].reduce((sum, n) => sum + partBlob(file, plan.partSize, n).size, 0)
  onProgress({ sentBytes, totalBytes: file.size, phase: 'sending' })

  // One part that keeps failing stops the others too, instead of letting them
  // send the rest of a 25 GB archive for a send that has already failed.
  const stop = new AbortController()
  const parts = signal ? anySignal([signal, stop.signal]) : stop.signal
  const next = () => (parts.aborted ? undefined : pending.shift())
  const worker = async (): Promise<void> => {
    for (let part = next(); part !== undefined; part = next()) {
      const blob = partBlob(file, plan.partSize, part)
      await sendPart(`${base(projectId)}/${encodeURIComponent(importId)}/parts/${part}`, blob, parts)
      sentBytes += blob.size
      onProgress({ sentBytes, totalBytes: file.size, phase: 'sending' })
    }
  }
  try {
    await Promise.all(Array.from({ length: PARALLEL_PARTS }, worker))
  } catch (error) {
    stop.abort()
    throw error
  }

  onProgress({ sentBytes, totalBytes: file.size, phase: 'joining' })
  return json(
    await fetch(`${base(projectId)}/${encodeURIComponent(importId)}/complete`, {
      method: 'POST',
      credentials: 'same-origin',
      signal,
    }),
  )
}

function partBlob(file: File, partSize: number, partNumber: number): Blob {
  const start = (partNumber - 1) * partSize
  return file.slice(start, Math.min(file.size, start + partSize))
}

async function sendPart(url: string, blob: Blob, signal?: AbortSignal): Promise<void> {
  const giveUpAt = Date.now() + PART_RETRY_BUDGET_MS
  for (let attempt = 1; ; attempt += 1) {
    await whileOffline(signal)
    const response = await fetch(url, { method: 'PUT', credentials: 'same-origin', body: blob, signal }).catch(
      (error: unknown) => {
        if (signal?.aborted) throw error
        return null
      },
    )
    if (response?.ok) return
    if (response && response.status !== 429 && response.status < 500) await json(response)
    const delay = retryDelayMs(response, attempt)
    if (Date.now() + delay > giveUpAt) {
      throw new MailImportRequestError('A part of the archive could not be sent.', response?.status ?? 0, 'PART_FAILED')
    }
    await wait(delay, signal)
  }
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const header = Number(response?.headers.get('Retry-After'))
  if (Number.isFinite(header) && header > 0) return header * 1000
  return Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** (attempt - 1))
}

/** Resolves once the browser is online (at once when it is, or cannot tell). */
function whileOffline(signal?: AbortSignal): Promise<void> {
  if (typeof navigator === 'undefined' || typeof window === 'undefined' || navigator.onLine !== false) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener('online', done)
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    const aborted = () => {
      window.removeEventListener('online', done)
      reject(signal?.reason)
    }
    window.addEventListener('online', done)
    signal?.addEventListener('abort', aborted, { once: true })
  })
}

/** `AbortSignal.any`, which Safari only has from 17.4. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const combined = new AbortController()
  for (const each of signals) {
    if (each.aborted) {
      combined.abort(each.reason)
      break
    }
    each.addEventListener('abort', () => combined.abort(each.reason), { once: true })
  }
  return combined.signal
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}

/** The body as `T`, or a {@link MailImportRequestError} carrying the server's message. */
async function json<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T
  const body = (await response.json().catch(() => null)) as { error?: string; code?: string } | null
  throw new MailImportRequestError(body?.error ?? `Request failed (${response.status})`, response.status, body?.code ?? null)
}
