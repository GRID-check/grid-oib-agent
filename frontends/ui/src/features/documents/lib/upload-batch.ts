/**
 * The browser's half of an upload batch (migration 0103, ADR-0077): open one
 * before the first file goes, seal it after the last answer.
 *
 * Neither call may fail an upload. The files are what the person asked for;
 * the batch is what lets Piloti tell them later that everything was read. A
 * batch that could not be opened means no summary, and the upload goes ahead
 * without one. A seal that never arrives is done by the server's sweep.
 */

import type { NameMatch } from '@/lib/upload-screening/name-screen'

export type UploadBatchShelf = 'project' | 'archiv' | 'session'

export interface UploadBatchExclusion {
  term: string
  count: number
}

/**
 * What the screening kept back, as the batch records it: one entry per term,
 * counting the files it caught first. Names are dropped here, in the browser —
 * they never reached the server as files and do not reach it as text.
 */
export function exclusionsByTerm(screened: ReadonlyArray<readonly NameMatch[]>): UploadBatchExclusion[] {
  const counts = new Map<string, number>()
  for (const matches of screened) {
    const term = matches[0]?.term
    if (term) counts.set(term, (counts.get(term) ?? 0) + 1)
  }
  return [...counts].map(([term, count]) => ({ term, count }))
}

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

/** Seal the batch with the files that wrote no row. Never rejects. */
export async function sealUploadBatch(id: string, counts: { unchanged: number; failed: number }): Promise<void> {
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
