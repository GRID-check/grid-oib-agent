/**
 * Timing instrumentation for WorkOS SDK calls on the request hot path.
 *
 * Every WorkOS API call is a network round-trip that is bounded by the SDK's
 * per-request fetch timeout (30s — see `@/lib/workos/client`) but otherwise
 * opaque in production logs. When a project-authz request stalls, we want the
 * frontend logs to name the exact leg that was slow instead of showing an
 * anonymous 100s hang.
 *
 * {@link timedWorkOSCall} measures a single call and emits a `console.warn`
 * (the codebase's logging convention — no structured logger) only when the
 * call is slower than a threshold, so the fast path stays silent.
 */

/** Default slow-call threshold: WorkOS calls above this WARN. */
const DEFAULT_SLOW_CALL_THRESHOLD_MS = 2000

/**
 * Threshold above which a WorkOS call is logged as slow, in ms.
 * `GRID_AUTHZ_SLOW_CALL_MS` tunes it; `0` disables the warning entirely.
 * Read per-call so operators can retune (and tests can flip it) without a
 * process restart.
 */
function slowCallThresholdMs(): number {
  const raw = process.env.GRID_AUTHZ_SLOW_CALL_MS
  if (raw === undefined || raw === '') return DEFAULT_SLOW_CALL_THRESHOLD_MS
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SLOW_CALL_THRESHOLD_MS
}

/**
 * Time a single WorkOS call and WARN when it exceeds the slow threshold.
 *
 * The duration is measured across both success and failure (a 30s timeout that
 * then throws still WARNs, naming the leg), so the next production stall points
 * at the exact call. Returns/rethrows the underlying result unchanged — this is
 * a transparent wrapper.
 */
export async function timedWorkOSCall<T>(label: string, call: () => Promise<T>): Promise<T> {
  const start = Date.now()
  try {
    return await call()
  } finally {
    const durationMs = Date.now() - start
    const threshold = slowCallThresholdMs()
    if (threshold > 0 && durationMs >= threshold) {
      console.warn(`[WorkOS] slow call: ${label} took ${durationMs}ms (threshold ${threshold}ms)`)
    }
  }
}
