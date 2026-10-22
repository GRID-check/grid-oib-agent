import 'server-only'
/**
 * The quiet upload batch a mail filing files into (D35, `./batch-effects`):
 * opened as the person before the first upload, sealed after the last, so the
 * batch settles with its effects once everything in it was read.
 *
 * **One batch per run, never per decision.** A batch takes its effects when it
 * is opened (`ON CONFLICT DO NOTHING` keeps the first row's), and an upload
 * names a batch only while it is open (`acceptedUploadBatchId` ignores a
 * sealed one). A batch id derived from the decision would be sealed by the
 * first run, so a retry's uploads would carry no batch and set off everything
 * a person's upload does: the tray's summary, Piloti's placement review, the
 * intake reading. A fresh id per run never meets a sealed batch; a run that
 * dies between open and seal leaves an open batch the upload sweep seals.
 */

import { randomUUID } from 'node:crypto'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { UploadBatchEffects } from '@/lib/db/schema'
import { openUploadBatch, sealJobUploadBatch } from '@/lib/upload-batches/service'

/** A quiet batch for this run's uploads into the project, opened as the person. */
export async function openQuietBatch(
  session: AuthorizedSession,
  projectId: string,
  effects: Readonly<UploadBatchEffects>
): Promise<string> {
  const id = randomUUID()
  await openUploadBatch(session, {
    id,
    scope: 'project',
    projectId,
    conversationId: null,
    // Unknown until the run ends; the seal announces what was filed.
    expectedCount: 0,
    excluded: [],
    effects,
  })
  return id
}

/** Seal the run's batch once it has nothing more to send. Never throws: the upload sweep seals what this leaves. */
export async function sealQuietBatch(session: AuthorizedSession, batchId: string): Promise<void> {
  try {
    await sealJobUploadBatch(session.organizationId, batchId, session.userId)
  } catch (error) {
    console.warn(
      `[inbound-mail] could not seal upload batch ${batchId}; the upload sweep will:`,
      error
    )
  }
}
