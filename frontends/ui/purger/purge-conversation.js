// @ts-check
/**
 * The retry of one chat erasure (`entity_type = 'conversation'`).
 *
 * A chat is erased in the delete request itself (`deleteConversation`,
 * `src/lib/conversations/service.ts`), not here: the request marks it deleting,
 * queues this row in the same transaction, erases the attachments, the chat's
 * `s_` collection and the rows, and closes the row. The row is for the request
 * that could not finish — the agent service was down, a store answered 5xx, the
 * process died — which used to leave the chat hidden and half-erased until
 * somebody happened to delete it again.
 *
 * The steps are NOT repeated in this file. They live in the BFF (TypeScript,
 * with the tenant scope, the session-document ledger and the backend clients
 * they need), and a JavaScript copy would be a second deletion path that drifts
 * from the first the day either changes. So the purger contributes what it
 * already does for every entity — the claim, `FOR UPDATE SKIP LOCKED`, attempts
 * with backoff, the legal-hold guard, `failed` after MAX_ATTEMPTS — and asks the
 * BFF to run its one erasure: `POST /api/internal/conversations/<id>/erase`.
 */

const { LEGAL_HOLD_CODE, assertNoHold } = require('./purge-project')

/** @typedef {import('./types').Tx} Tx */
/** @typedef {import('./types').QueueEntry} QueueEntry */
/** @typedef {import('./types').PurgeDeps} PurgeDeps */

// Must match src/lib/internal-auth.ts INTERNAL_TOKEN_HEADER, the header
// `internalApiRoute` reads.
const INTERNAL_TOKEN_HEADER = 'x-grid-internal-token'

// Well under the 15-minute stale-claim window (`purger/db.js`), so a hung call
// is abandoned and recorded as a failed attempt long before another purger
// could re-claim the row it is still working on. The erase itself is a handful
// of backend calls, each with its own timeout in the BFF.
const ERASE_TIMEOUT_MS = 5 * 60_000

/**
 * @param {Tx} tx
 * @param {QueueEntry} entry
 * @param {PurgeDeps} deps
 * @returns {Promise<void>}
 */
async function purgeConversation(tx, entry, deps) {
  const fetchImpl = deps.fetchImpl || fetch

  // The claim already skipped a held row; this is the TOCTOU re-check every
  // purger makes before its first destructive step. The BFF checks once more.
  await assertNoHold(tx, entry)

  const res = await fetchImpl(
    `${deps.frontendUrl}/api/internal/conversations/${encodeURIComponent(entry.entity_id)}/erase`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_TOKEN_HEADER]: deps.internalToken,
      },
      body: JSON.stringify({ organizationId: entry.organization_id }),
      signal: AbortSignal.timeout(ERASE_TIMEOUT_MS),
    },
  )
  if (res.ok) return

  const body = /** @type {{ error?: unknown, details?: { reason?: unknown } } | null} */ (
    typeof res.json === 'function' ? await res.json().catch(() => null) : null
  )
  if (res.status === 409 && body?.details?.reason === 'legal_hold') {
    // Not a failure: the caller puts the row back to 'pending' and refunds the
    // attempt, and the claim skips it until the hold is released.
    /** @type {import('./types').LegalHoldError} */
    const error = new Error(`legal hold active for conversation ${entry.entity_id} — erasure deferred`)
    error.code = LEGAL_HOLD_CODE
    throw error
  }
  const detail = typeof body?.error === 'string' ? `: ${body.error}` : ''
  throw new Error(`conversation erase answered ${res.status}${detail}`)
}

module.exports = { purgeConversation }
