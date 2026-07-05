/**
 * GRID purger service.
 *
 * Dedicated container (frontend image, `node purger/index.js`) that polls the
 * deletion_queue in grid_app and hard-deletes soft-deleted entities across all
 * stores after their grace period. See
 * docs/superpowers/specs/2026-07-05-deletion-pipeline-design.md.
 *
 * Environment:
 *   GRID_APP_DATABASE_URL   - grid_app Postgres DSN
 *   BACKEND_URL             - aiq-agent base URL (Python-side purge endpoint)
 *   GRID_INTERNAL_API_TOKEN - shared token for the internal endpoint
 *   MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_BUCKET
 *   WORKOS_API_KEY          - WorkOS API key (FGA resource cleanup)
 *   PURGER_POLL_INTERVAL_MS - poll interval (default 60000)
 */

const { WorkOS } = require('@workos-inc/node')
const {
  claimNext,
  createSql,
  markFailed,
  markFailedPermanent,
  markPurged,
  releaseHeld,
} = require('./db')
const { createS3Client, deleteMinioPrefix } = require('./minio')
const { LEGAL_HOLD_CODE, purgeProject } = require('./purge-project')

const pollIntervalMs = parseInt(process.env.PURGER_POLL_INTERVAL_MS || '60000', 10)

const sql = createSql()
const s3 = createS3Client()
const workos = new WorkOS(process.env.WORKOS_API_KEY)

const deps = {
  backendUrl: (process.env.BACKEND_URL || 'http://aiq-agent:8000').replace(/\/$/, ''),
  internalToken: process.env.GRID_INTERNAL_API_TOKEN || '',
  bucket: process.env.MINIO_BUCKET || 'grid-documents',
  workos,
  deleteMinioPrefix: (bucket, prefix) => deleteMinioPrefix(s3, bucket, prefix),
}

const purgers = {
  project: purgeProject,
  // document / conversation / organization / user: later phases
}

async function processOne() {
  // Phase A: claim (own transaction so the claim + attempts survive failures).
  const claimed = await sql.begin(async (tx) => claimNext(tx))
  if (!claimed) return false

  // Phase B: purge. grid_app row deletes are atomic within this transaction;
  // external steps are idempotent so a mid-flight crash re-runs safely after
  // the 15-minute stale-claim window.
  // Unsupported entity types are a config/programming error, not a transient
  // failure: fail the row permanently instead of burning MAX_ATTEMPTS retries.
  const purge = purgers[claimed.entity_type]
  if (!purge) {
    const reason = `no purger registered for entity_type '${claimed.entity_type}'`
    console.error(`[purger] ${reason} (queue row ${claimed.id}) — marking failed, no retry`)
    await markFailedPermanent(sql, claimed.id, reason).catch((e) =>
      console.error('[purger] failed to record error:', e),
    )
    return true
  }

  try {
    await sql.begin(async (tx) => purge(tx, claimed, deps))
    await markPurged(sql, claimed.id)
    console.log(`[purger] purged ${claimed.entity_type} ${claimed.entity_id} ("${claimed.display_name}")`)
    return true
  } catch (error) {
    if (error && error.code === LEGAL_HOLD_CODE) {
      // A hold appeared between claim and purge: not a failure. Release the
      // row back to 'pending'; claimNext skips it while the hold is active.
      console.warn(
        `[purger] legal hold blocked purge of ${claimed.entity_type} ${claimed.entity_id} — releasing back to pending`,
      )
      await releaseHeld(sql, claimed.id).catch((e) =>
        console.error('[purger] failed to release held row:', e),
      )
      return true
    }
    console.error('[purger] purge failed:', error)
    await markFailed(sql, claimed.id, error.message || error).catch((e) =>
      console.error('[purger] failed to record error:', e),
    )
    return false
  }
}

let running = false
async function tick() {
  if (running) return
  running = true
  try {
    // Drain everything due, one at a time.
    while (await processOne()) {
      /* keep going */
    }
  } finally {
    running = false
  }
}

console.log(`[purger] started, polling every ${pollIntervalMs}ms`)
void tick()
setInterval(() => void tick(), pollIntervalMs)
