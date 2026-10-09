/**
 * The upload batches an import files into (ADR-0085, ADR-0086), so the person
 * who started it gets the same „Was ist angekommen?" summary a dropped folder
 * gets: sent once everything the import filed has been read, saying what was
 * held back by the screening and why. `mail_import.completed` says only that
 * filing ended, which is before any of it was read.
 *
 * **Nothing is stored on the import.** A batch's id is derived from the
 * import's id and a generation number, so every slice, the job a passing
 * failure hands the import on to, and the one the sweep requeues all find the
 * same batch without a column for it. The import's batch is the first
 * generation that is not sealed; a batch is opened when the first slice asks.
 *
 * **Rollover.** A batch announces at most {@link UPLOAD_BATCH_MAX_FILES}. When
 * the open one is full it is sealed and the next generation opened, so a large
 * archive yields one summary per ten thousand files. The upload sweep seals a
 * batch nothing has come into for half an hour (a long backoff); the next
 * slice then finds it sealed and opens the next generation the same way.
 *
 * **Ending.** Completed, failed or cancelled, the open batch is sealed; it
 * then completes as its last document is read.
 */

import 'server-only'
import { v5 as uuidv5 } from 'uuid'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { MailImport } from '@/lib/db/schema'
import {
  findJobUploadBatch,
  openUploadBatch,
  sealJobUploadBatch,
  UPLOAD_BATCH_MAX_FILES,
} from '@/lib/upload-batches/service'

/** The namespace import batch ids are derived in. Fixed: changing it orphans every open import's batch. */
const IMPORT_BATCH_NAMESPACE = '6f1d3c52-8a4e-4b7f-9c21-5e0a7d93b4c8'

/** Generations walked before giving up: ten million files, or a batch id someone else took each time. */
const MAX_GENERATIONS = 1_000

/** The batch a slice is filing into, and how many documents carry it so far. */
export interface ImportBatch {
  id: string
  generation: number
  documents: number
}

/** The id of an import's batch of the given generation. */
export function importBatchId(importId: string, generation: number): string {
  return uuidv5(`${importId}:${generation}`, IMPORT_BATCH_NAMESPACE)
}

type Generation = { generation: number; id: string; documents: number | null }

/**
 * The first generation that is not sealed: open (`documents` set), or not
 * opened yet (`documents` null). A batch with this id that is not the
 * starter's (a browser chooses its own batch id) is stepped over like a sealed one.
 */
async function firstUnsealed(row: MailImport): Promise<Generation> {
  for (let generation = 0; generation < MAX_GENERATIONS; generation += 1) {
    const id = importBatchId(row.id, generation)
    const state = await findJobUploadBatch(row.organizationId, id, row.userId)
    if (state.status === 'open') return { generation, id, documents: state.documents }
    if (state.status === 'missing') return { generation, id, documents: null }
  }
  throw new Error(`no free upload batch for import ${row.id} after ${MAX_GENERATIONS} generations`)
}

/** The import's open batch, opened now as the person who started it when there is none. */
export async function openImportBatch(session: AuthorizedSession, row: MailImport): Promise<ImportBatch> {
  const found = await firstUnsealed(row)
  if (found.documents !== null) return { id: found.id, generation: found.generation, documents: found.documents }
  await openUploadBatch(session, {
    id: found.id,
    scope: 'project',
    projectId: row.projectId,
    conversationId: null,
    // Unknown until the import ends; the seal announces what was filed.
    expectedCount: 0,
    excluded: [],
  })
  return { id: found.id, generation: found.generation, documents: 0 }
}

/** `current` while it has room for one more document, else the next generation after sealing it. */
export async function importBatchWithRoom(
  session: AuthorizedSession,
  row: MailImport,
  current: ImportBatch,
): Promise<ImportBatch> {
  if (current.documents < UPLOAD_BATCH_MAX_FILES) return current
  await sealJobUploadBatch(row.organizationId, current.id, row.userId)
  return openImportBatch(session, row)
}

/**
 * Seal the batch the import left open, if any. Never throws: the import's own
 * ending must not fail on its summary, and the upload sweep seals a batch
 * nothing comes into any more.
 */
export async function sealImportBatch(row: MailImport): Promise<void> {
  try {
    const found = await firstUnsealed(row)
    if (found.documents !== null) await sealJobUploadBatch(row.organizationId, found.id, row.userId)
  } catch (error) {
    console.error(`[mail-import] could not seal the upload batch of ${row.id}; the upload sweep will:`, error)
  }
}
