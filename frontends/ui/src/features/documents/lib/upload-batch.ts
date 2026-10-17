/**
 * The browser's half of an upload batch (migration 0110, ADR-0086): open one
 * before the first file goes, seal it after the last answer.
 *
 * Neither call may fail an upload. The files are what the person asked for;
 * the batch is what lets Piloti tell them later that everything was read. A
 * batch that could not be opened means no summary, and the upload goes ahead
 * without one. A seal that never arrives is done by the server's sweep.
 */

import type { NameStopTally } from '@/lib/upload-screening/name-stop'

export type UploadBatchShelf = 'project' | 'archiv' | 'session'

export type UploadBatchExclusion = NameStopTally

/**
 * What the screening kept back, as the batch records it: one entry per term.
 * Names are dropped in the browser — they never reached the server as files
 * and do not reach it as text. The mail import counts its stops by the same rule.
 */
export { exclusionsByTerm } from '@/lib/upload-screening/name-stop'

export interface OpenBatchInput {
  id: string
  scope: UploadBatchShelf
  projectId: string | null
  conversationId: string | null
  expectedCount: number
  excluded: UploadBatchExclusion[]
}

/** Open the batch; the id to stamp uploads with, or null when there is none. Never rejects. */
export async function openUploadBatch(input: OpenBatchInput): Promise<string | null> {
  try {
    const response = await fetch('/api/upload-batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    return response.ok ? input.id : null
  } catch {
    return null
  }
}

/**
 * Seal the batch with the files that wrote no row: unchanged, failed, and the
 * ones the server's name check refused (`excluded`, by term). Never rejects.
 */
export async function sealUploadBatch(
  id: string,
  counts: { unchanged: number; failed: number; excluded?: UploadBatchExclusion[] }
): Promise<void> {
  try {
    await fetch(`/api/upload-batches/${encodeURIComponent(id)}/seal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(counts),
    })
  } catch {
    // The sweep seals a batch its browser never came back to.
  }
}
