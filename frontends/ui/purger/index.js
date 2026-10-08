// @ts-check
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
 *   BACKEND_URL             - aiq-api base URL (Python-side purge endpoint)
 *   FRONTEND_INTERNAL_URL   - BFF base URL (chat erasure retries, folder purges; default http://frontend:3000)
 *   GRID_INTERNAL_API_TOKEN - shared token for the internal endpoint
 *   SEAWEED_ENDPOINT / SEAWEED_ACCESS_KEY / SEAWEED_SECRET_KEY / SEAWEED_BUCKET
 *   WORKOS_API_KEY          - WorkOS API key (FGA resource cleanup)
 *   LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
 *                           - Langfuse API, to delete an erased chat's traces
 *                             (all three, or the step is a logged no-op)
 *   PURGER_POLL_INTERVAL_MS - poll interval (default 60000)
 */

const { WorkOS } = require('@workos-inc/node')
const {
  claimNext,
  createSql,
  markFailed,
  markFailedPermanent,
  markPurged,
  reapStranded,
  releaseHeld,
} = require('./db')
const { createS3Client, deleteStoragePrefix } = require('./storage')
const { LEGAL_HOLD_CODE, purgeProject } = require('./purge-project')
const { PERMANENT_FAILURE_CODE, purgeConversation } = require('./purge-conversation')
const { purgeFolder } = require('./purge-folder')
const { initOtelLogs } = require('../observability/otel-logs')
const { createConversationTraceEraser, readLangfuseConfig } = require('../workers/langfuse-traces')
// The deletion queue spans every organization, so the purger's transactions
// step up to the BYPASSRLS role (ADR-0041).
const { withPlatformScope } = require('../workers/platform-scope')
const { createFailureStreak, databaseOutage, escalationTicks } = require('../workers/failure-streak')

/** @typedef {import('./types').PurgeDeps} PurgeDeps */
/** @typedef {import('postgres').Sql} Sql */
/** @typedef {import('../workers/failure-streak').FailureStreak} FailureStreak */
/** @typedef {import('../workers/failure-streak').Failure} Failure */

const purgers = {
  project: purgeProject,
  // The retry of a chat erasure its delete request could not finish.
  conversation: purgeConversation,
  // A folder from the Papierkorb, once its grace period is over.
  folder: purgeFolder,
  // document / organization / user: later phases. The organization purge must call
  // `eraseLane` (`workers/job-queue.js`) for the organization's background jobs,
  // as the project purge calls `eraseProject`: their payloads hold its content and
  // nothing cascades to them.
}

/**
 * A queue write that failed after the purge step (recording a failure,
 * releasing a held row). With the database unavailable the row simply stays
 * 'purging' and the stale-claim window re-offers it, so that is a WARN; any
 * other failure is an ERROR.
 *
 * @param {string} what
 * @param {unknown} error
 */
function logQueueWriteFailure(what, error) {
  const outage = databaseOutage(error)
  if (outage) console.warn(`[purger] failed to ${what} (${outage.kind}); the stale-claim window re-offers the row`)
  else console.error(`[purger] failed to ${what}:`, error)
}

/**
 * The purger's loop, over injected clients so the specs can drive a tick.
 *
 * `streak` counts the ticks the database was unavailable for
 * (`workers/failure-streak.js`): a tick whose reap or claim fails that way logs
 * a WARN and retries on the next poll, a streak of about five minutes logs one
 * ERROR, and the first good tick after logs the recovery.
 *
 * @param {{ sql: Sql, deps: PurgeDeps, streak: FailureStreak }} context
 */
function createPurger({ sql, deps, streak }) {
  async function processOne() {
    // Phase A: claim (own transaction so the claim + attempts survive failures).
    const claimed = await withPlatformScope(sql, (tx) => claimNext(tx))
    if (!claimed) return false

    // Phase B: purge. grid_app row deletes are atomic within this transaction;
    // external steps are idempotent so a mid-flight crash re-runs safely after
    // the 15-minute stale-claim window.
    // Unsupported entity types are a config/programming error, not a transient
    // failure: fail the row permanently instead of burning MAX_ATTEMPTS retries.
    const purge = /** @type {Record<string, typeof purgeProject | undefined>} */ (purgers)[
      claimed.entity_type
    ]
    if (!purge) {
      const reason = `no purger registered for entity_type '${claimed.entity_type}'`
      console.error(`[purger] ${reason} (queue row ${claimed.id}) — marking failed, no retry`)
      await markFailedPermanent(sql, claimed.id, reason).catch((e) => logQueueWriteFailure('record error', e))
      return true
    }

    try {
      await withPlatformScope(sql, (tx) => purge(tx, claimed, deps))
      await markPurged(sql, claimed.id)
      console.log(`[purger] purged ${claimed.entity_type} ${claimed.entity_id} ("${claimed.display_name}")`)
      return true
    } catch (error) {
      const failure = /** @type {import('./types').LegalHoldError | undefined} */ (
        error instanceof Error ? error : undefined
      )
      if (failure?.code === LEGAL_HOLD_CODE) {
        // A hold appeared between claim and purge: not a failure. Release the
        // row back to 'pending'; claimNext skips it while the hold is active.
        console.warn(
          `[purger] legal hold blocked purge of ${claimed.entity_type} ${claimed.entity_id} — releasing back to pending`,
        )
        await releaseHeld(sql, claimed.id).catch((e) => logQueueWriteFailure('release held row', e))
        return true
      }
      if (failure?.code === PERMANENT_FAILURE_CODE) {
        // A refusal no retry can change (a chat erasure queued for a live chat):
        // fail it now instead of spending MAX_ATTEMPTS on the same answer.
        console.error(`[purger] ${failure.message} (queue row ${claimed.id}) — marking failed, no retry`)
        await markFailedPermanent(sql, claimed.id, failure.message).catch((e) =>
          logQueueWriteFailure('record error', e),
        )
        return true
      }
      // Stays ERROR even when the cause is an unreachable store: a purge spans
      // the database, the agent, object storage and WorkOS, and a refused
      // connection to any of them looks the same on `cause`. The row's
      // attempts and backoff are the retry.
      console.error('[purger] purge failed:', error)
      await markFailed(sql, claimed.id, failure?.message ?? error).catch((e) => logQueueWriteFailure('record error', e))
      return false
    }
  }

  let running = false
  async function tick() {
    if (running) return
    running = true
    /** @type {Failure | undefined} */
    let outage
    try {
      // Reap rows a crashed purger stranded in 'purging' on their final attempt
      // (claimNext can't re-pick them, and they'd never surface to an admin).
      const reaped = await reapStranded(sql).catch((e) => {
        outage = databaseOutage(e)
        if (!outage) console.error('[purger] failed to reap stranded rows:', e)
        return 0
      })
      if (reaped > 0) {
        console.warn(`[purger] reaped ${reaped} row(s) stranded in 'purging' → 'failed' (see last_error)`)
      }
      // Drain everything due, one at a time.
      //
      // A claim that throws (the database is down, or a migration this image
      // needs — 0093's `grid_legal_hold_blocks` — has not run yet) is logged and
      // retried on the next tick. Unhandled, it was a rejected `void tick()`,
      // which ends the Node process instead of waiting for the database.
      while (await processOne()) {
        /* keep going */
      }
      // The claim reached the database, so it is back, whatever the reap met.
      outage = undefined
    } catch (error) {
      const claimOutage = databaseOutage(error)
      if (claimOutage) outage = claimOutage
      else console.error('[purger] tick failed, retrying on the next poll:', error)
    } finally {
      running = false
    }
    if (outage) streak.failed(outage)
    else streak.succeeded()
  }

  return { processOne, tick }
}

function main() {
  // No-op without OTEL_EXPORTER_OTLP_ENDPOINT (ADR-0029 capability gate).
  initOtelLogs()

  const pollIntervalMs = parseInt(process.env.PURGER_POLL_INTERVAL_MS || '60000', 10)
  const s3 = createS3Client()
  const sharedBucket = process.env.SEAWEED_BUCKET || 'grid-documents'

  /** @type {PurgeDeps} */
  const deps = {
    backendUrl: (process.env.BACKEND_URL || 'http://aiq-api:8000').replace(/\/$/, ''),
    // A chat's erasure runs in the BFF; the purger only retries it
    // (`purge-conversation.js`).
    frontendUrl: (process.env.FRONTEND_INTERNAL_URL || 'http://frontend:3000').replace(/\/$/, ''),
    internalToken: process.env.GRID_INTERNAL_API_TOKEN || '',
    // The deployment's shared bucket. Every OTHER bucket a purge has to sweep is
    // read from the document rows themselves (ADR-0043) rather than derived from
    // the organization id — see the note in `purge-project.js` step 2. That is
    // why this process needs no bucket-naming rule and no feature flag.
    bucket: sharedBucket,
    // The SDK throws at construction without a key, which crash-looped the purger
    // in every stack without WorkOS. Such a stack never created an FGA resource
    // (the BFF needs the key for that too), so there is nothing to delete.
    workos: process.env.WORKOS_API_KEY ? new WorkOS(process.env.WORKOS_API_KEY) : null,
    // A chat's traces: the one store neither the BFF nor the agent erases.
    eraseConversationTraces: createConversationTraceEraser({ env: process.env }),
    deleteStoragePrefix: (/** @type {string} */ bucket, /** @type {string} */ prefix) =>
      deleteStoragePrefix(s3, bucket, prefix),
  }

  const { tick } = createPurger({
    sql: createSql(),
    deps,
    streak: createFailureStreak({ label: '[purger] queue', escalateAfter: escalationTicks(pollIntervalMs) }),
  })

  const langfuse = readLangfuseConfig(process.env)
  console.log(
    `[purger] Langfuse trace erasure: ${langfuse.config ? 'on' : `off (missing ${langfuse.missing.join(', ')})`}`,
  )
  console.log(`[purger] started, polling every ${pollIntervalMs}ms`)
  void tick()
  setInterval(() => void tick(), pollIntervalMs)
}

if (require.main === module) {
  main()
}

module.exports = { createPurger }
