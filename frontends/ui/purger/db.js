const postgres = require('postgres')

function createSql() {
  const url = process.env.GRID_APP_DATABASE_URL
  if (!url) throw new Error('GRID_APP_DATABASE_URL is not defined')
  return postgres(url, { prepare: false })
}

const MAX_ATTEMPTS = 10
const STALE_CLAIM_MINUTES = 15

/**
 * Claim one due queue entry. Guards:
 * - legal holds (entity-level, or org-level covering everything in the org)
 * - stale 'purging' rows from a crashed purger are re-claimable after 15 min
 * - retry backoff: a previously-failed row (attempts > 0, claimed_at set by the
 *   failed claim) is only re-eligible after an exponential delay measured from
 *   its last claim: 60s * 2^min(attempts, 6) — i.e. 2m, 4m, 8m, ... capped at
 *   64m. Never-claimed rows (claimed_at IS NULL) are eligible immediately.
 * The row lock (FOR UPDATE SKIP LOCKED) serializes competing purgers and
 * purge-vs-restore races.
 */
async function claimNext(tx) {
  const rows = await tx`
    SELECT q.* FROM deletion_queue q
    WHERE (
        (
          q.status = 'pending' AND q.purge_after <= now()
          AND (
            q.claimed_at IS NULL
            OR now() > q.claimed_at + make_interval(secs => 60 * power(2, least(q.attempts, 6)))
          )
        )
        OR (q.status = 'purging' AND q.claimed_at < now() - make_interval(mins => ${STALE_CLAIM_MINUTES}))
      )
      AND q.attempts < ${MAX_ATTEMPTS}
      AND NOT EXISTS (
        SELECT 1 FROM legal_holds h
        WHERE h.released_at IS NULL
          AND (
            (h.entity_type = q.entity_type AND h.entity_id = q.entity_id)
            OR (h.entity_type = 'organization' AND h.entity_id = q.organization_id)
          )
      )
    ORDER BY q.requested_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  `
  if (rows.length === 0) return null
  const entry = rows[0]
  await tx`
    UPDATE deletion_queue
    SET status = 'purging', claimed_at = now(), attempts = attempts + 1
    WHERE id = ${entry.id}
  `
  return entry
}

/**
 * Re-check legal holds for an already-claimed entry. claimNext also checks,
 * but a hold can be created between claim and purge (TOCTOU); every purger
 * MUST call this inside the purge transaction before its first destructive
 * step. Same predicate as claimNext's NOT EXISTS guard.
 */
async function hasActiveHold(tx, entry) {
  const rows = await tx`
    SELECT 1 FROM legal_holds h
    WHERE h.released_at IS NULL
      AND (
        (h.entity_type = ${entry.entity_type} AND h.entity_id = ${entry.entity_id})
        OR (h.entity_type = 'organization' AND h.entity_id = ${entry.organization_id})
      )
    LIMIT 1
  `
  return rows.length > 0
}

/**
 * Release a claimed entry back to 'pending' because a legal hold appeared
 * after the claim. Not a failure: the attempt is refunded so held rows never
 * drift toward MAX_ATTEMPTS. claimNext skips the row while the hold is active
 * and picks it up again once the hold is released.
 */
async function releaseHeld(sql, entryId) {
  await sql`
    UPDATE deletion_queue
    SET status = 'pending',
        attempts = GREATEST(attempts - 1, 0),
        last_error = 'blocked by active legal hold at purge time'
    WHERE id = ${entryId}
  `
}

async function markPurged(sql, entryId) {
  await sql`
    UPDATE deletion_queue
    SET status = 'purged', purged_at = now(), last_error = NULL
    WHERE id = ${entryId}
  `
}

async function markFailed(sql, entryId, message) {
  await sql`
    UPDATE deletion_queue
    SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
        last_error = ${String(message).slice(0, 2000)}
    WHERE id = ${entryId}
  `
}

/**
 * Terminal failure: no retries. Used for non-transient conditions (e.g. an
 * entity_type with no registered purger) so the row cannot poison the queue
 * with pointless retry loops.
 */
async function markFailedPermanent(sql, entryId, message) {
  await sql`
    UPDATE deletion_queue
    SET status = 'failed',
        last_error = ${String(message).slice(0, 2000)}
    WHERE id = ${entryId}
  `
}

module.exports = {
  claimNext,
  createSql,
  hasActiveHold,
  markFailed,
  markFailedPermanent,
  markPurged,
  releaseHeld,
  MAX_ATTEMPTS,
}
