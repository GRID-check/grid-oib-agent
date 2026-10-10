// @ts-check
/**
 * The purge of a folder from the Papierkorb (`entity_type = 'folder'`), once
 * its grace period (`FOLDER_PURGE_GRACE_DAYS`) is over.
 *
 * Like a chat's erasure, the steps live in the BFF (`purgeBinnedFolder`,
 * `src/lib/projects/folder-bin.ts`): each document goes by the document
 * delete's own steps (chunks, every version's objects, renditions, thumbnails,
 * grants, the row), what was derived from the folder is marked, and removed
 * when the organization's setting asks („Mit dem Ordner entfernen“), and the folders are
 * marked purged last, leaving tombstones with their grants. A JavaScript copy
 * here would be a second deletion path to keep in step. So the purger
 * contributes the claim, the backoff, the legal-hold guard and `failed` after
 * MAX_ATTEMPTS, and asks: `POST /api/internal/folders/<id>/purge`.
 *
 * What it adds is the store the BFF never reaches: the Langfuse traces of the
 * conversations whose derived content was removed. Only this pod and the
 * scheduler hold Langfuse's keys and may reach it, so „Endgültig löschen",
 * which purges in the BFF's request, hands its row here when traces are owed;
 * the BFF then answers `already-purged` with those conversations. Then it
 * merges the counts into the queue row's payload, the record of the purge.
 */

const { LEGAL_HOLD_CODE, assertNoHold } = require('./purge-project')
const { PERMANENT_FAILURE_CODE } = require('./purge-conversation')

/** @typedef {import('./types').Tx} Tx */
/** @typedef {import('./types').QueueEntry} QueueEntry */
/** @typedef {import('./types').PurgeDeps} PurgeDeps */

// Must match src/lib/internal-auth.ts INTERNAL_TOKEN_HEADER.
const INTERNAL_TOKEN_HEADER = 'x-grid-internal-token'

// Under the 15-minute stale-claim window (`purger/db.js`). A large folder is
// many documents, each a few store calls; a purge that does not finish here
// fails the attempt, and the retry carries on where it stopped (every step is
// idempotent, the folders are marked last).
const PURGE_TIMEOUT_MS = 10 * 60_000

/**
 * @param {Tx} tx
 * @param {QueueEntry} entry
 * @param {PurgeDeps} deps
 * @returns {Promise<void>}
 */
async function purgeFolder(tx, entry, deps) {
  const fetchImpl = deps.fetchImpl || fetch

  // The TOCTOU re-check every purger makes before its first destructive step.
  // The BFF checks once more.
  await assertNoHold(tx, entry)

  const res = await fetchImpl(
    `${deps.frontendUrl}/api/internal/folders/${encodeURIComponent(entry.entity_id)}/purge`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: deps.internalToken,
      },
      body: JSON.stringify({ organizationId: entry.organization_id }),
      signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
    },
  )
  /** @type {{ error?: unknown, details?: { reason?: unknown }, counts?: Record<string, unknown>, traceConversationIds?: unknown } | null} */
  const body = typeof res.json === 'function' ? await res.json().catch(() => null) : null

  if (res.ok) {
    const conversations = Array.isArray(body?.traceConversationIds)
      ? body.traceConversationIds.filter((id) => typeof id === 'string')
      : []
    let traces = 0
    for (const conversationId of conversations) {
      // Throws on a Langfuse failure: the row's attempts retry the whole call,
      // and the BFF's steps are no-ops the second time.
      const result = /** @type {{ traces?: number } | undefined} */ (await deps.eraseConversationTraces(conversationId))
      traces += Number(result?.traces ?? 0)
    }
    const counts = { ...(body?.counts ?? {}), tracesErased: traces }
    await tx`
      UPDATE deletion_queue
      SET payload = coalesce(payload, '{}'::jsonb) || ${JSON.stringify({ purged: counts })}::jsonb
      WHERE id = ${entry.id}
    `
    return
  }

  if (res.status === 409 && body?.details?.reason === 'legal_hold') {
    /** @type {import('./types').LegalHoldError} */
    const error = new Error(`legal hold active for folder ${entry.entity_id} — purge deferred`)
    error.code = LEGAL_HOLD_CODE
    throw error
  }
  if (res.status === 409 && body?.details?.reason === 'not_in_bin') {
    // The row names a folder that is not deleted: a restore that raced the
    // claim, or a bug. The BFF refuses it every time, so it fails for good.
    /** @type {import('./types').LegalHoldError} */
    const error = new Error(`folder ${entry.entity_id} is not in the bin — nothing was purged`)
    error.code = PERMANENT_FAILURE_CODE
    throw error
  }
  const detail = typeof body?.error === 'string' ? `: ${body.error}` : ''
  throw new Error(`folder purge answered ${res.status}${detail}`)
}

module.exports = { purgeFolder }
