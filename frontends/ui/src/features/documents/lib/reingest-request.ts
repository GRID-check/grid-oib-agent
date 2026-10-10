/**
 * One request to send a document back through ingestion, and what came of it.
 *
 * Shared by the document's own „Erneut lesen" (`use-document-actions.ts`) and
 * the folder brief's „Alle erneut lesen" (`use-bulk-reingest.ts`), so the two
 * cannot read the server's answer differently. Every refusal is a 409 whose
 * `details.code` says why (`@/lib/documents/reingest-codes`).
 */

import { INGEST_ALREADY_DONE, INGEST_RUNNING } from '@/lib/documents/reingest-codes'

export type ReingestOutcome =
  /** Dispatched; `status` is the row's new status (usually `pending`). */
  | { kind: 'started'; status: string }
  /**
   * Nothing to retry: the row the reader saw was stale — the backend is already
   * reading it, or already has. `status` is the real one when the server said.
   */
  | { kind: 'settled'; code: typeof INGEST_RUNNING | typeof INGEST_ALREADY_DONE; status: string | null }
  /** Refused for another reason, or the request itself failed. */
  | { kind: 'failed' }

async function readReingestRefusal(res: Response): Promise<{ code: string | null; status: string | null } | null> {
  const body: unknown = await res.json().catch(() => null)
  if (!body || typeof body !== 'object') return null
  const details = (body as { details?: unknown }).details
  if (!details || typeof details !== 'object') return null
  const { code, status } = details as { code?: unknown; status?: unknown }
  return {
    code: typeof code === 'string' ? code : null,
    status: typeof status === 'string' ? status : null,
  }
}

export async function requestReingest(documentId: string): Promise<ReingestOutcome> {
  try {
    const res = await fetch(`/api/documents/${documentId}/reingest`, { method: 'POST' })
    if (res.status === 409) {
      const refusal = await readReingestRefusal(res)
      if (refusal?.code === INGEST_RUNNING || refusal?.code === INGEST_ALREADY_DONE) {
        return { kind: 'settled', code: refusal.code, status: refusal.status }
      }
      return { kind: 'failed' }
    }
    if (!res.ok) return { kind: 'failed' }
    const data: unknown = await res.json().catch(() => ({}))
    const status = (data as { status?: unknown } | null)?.status
    return { kind: 'started', status: typeof status === 'string' ? status : 'pending' }
  } catch {
    return { kind: 'failed' }
  }
}
