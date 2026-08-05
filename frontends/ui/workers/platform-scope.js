/**
 * Platform scope for the background workers (ADR-0041).
 *
 * The purger and the scheduler are both cross-tenant by nature: one drains a
 * deletion queue that spans every organization, the other scans every
 * organization's workflows for the ones due now. Neither has a single tenant to
 * answer as, so neither can satisfy the row-level security policies that
 * `grid_app_rw` is subject to.
 *
 * They step up to the BYPASSRLS role instead, per transaction. `SET LOCAL` ends
 * with the transaction, so a pooled connection never carries the privilege to
 * whatever borrows it next, and the step-up is recorded as `current_user` in the
 * query log — the same contract `withPlatformAccess` gives the BFF.
 *
 * This lives in ONE module because the failure mode is silent. A worker that
 * loses its step-up does not crash: row-level security simply hides every row,
 * the queue looks empty, and the worker reports healthy ticks forever while
 * doing nothing. Two copies of that detail is one copy too many.
 *
 * These are CommonJS because the workers are plain Node processes, not part of
 * the Next.js build.
 */

const PLATFORM_ROLE = 'grid_app_platform'

/**
 * Step up inside an OPEN transaction. Must be the first statement, so nothing
 * in the transaction ever runs under the tenant-scoped role.
 *
 * @param {{ unsafe: (sql: string) => Promise<unknown> }} tx open transaction
 */
async function enterPlatformScope(tx) {
  await tx.unsafe(`SET LOCAL ROLE ${PLATFORM_ROLE}`)
}

/**
 * Run `fn` in a transaction that has already stepped up.
 *
 * For the single-statement helpers that previously ran outside a transaction:
 * `SET LOCAL` needs one, and wrapping a lone statement costs nothing because
 * postgres-js pipelines the whole transaction.
 *
 * @param {{ begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> }} sql
 * @param {(tx: unknown) => Promise<unknown>} fn
 */
async function withPlatformScope(sql, fn) {
  return sql.begin(async (tx) => {
    await enterPlatformScope(tx)
    return fn(tx)
  })
}

module.exports = { PLATFORM_ROLE, enterPlatformScope, withPlatformScope }
