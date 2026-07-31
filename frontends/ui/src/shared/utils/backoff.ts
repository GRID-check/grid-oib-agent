/**
 * Reconnect backoff with jitter.
 *
 * A rolling deploy severs every WebSocket on a pod at once (surge rollout,
 * 30s WS drain — see `ROLLOUT.frontend` in `deploy/pulumi/src/platform/rollout.ts`).
 * Plain exponential backoff bounds the retry rate but does not *desynchronise*
 * it: every client dropped by the same pod comes back on an identical schedule,
 * so the herd lands together on the surviving replicas.
 *
 * That matters here more than in most apps because a WebSocket upgrade is
 * expensive by design — ADR-0020: every upgrade resolves the session, runs FGA
 * checks and reads budgets before the socket is proxied to the backend. The
 * gateway's own rate limiter is keyed on client IP, so it throttles one abusive
 * client and does nothing about a fleet-wide reconnect from thousands of
 * distinct IPs, which is precisely what a rollout produces.
 *
 * Strategy is "equal jitter": keep the exponential growth, then spread each
 * wave uniformly across the back half of its window. A wave that would have
 * arrived as a spike at exactly t=4s instead arrives smeared over t=2s..4s.
 */

export interface BackoffOptions {
  /** Delay for attempt 0, before jitter. */
  baseMs: number
  /** Ceiling for the pre-jitter delay. */
  maxMs: number
  /** Growth factor per attempt. */
  factor?: number
  /**
   * Randomness source, injectable so tests can assert exact values instead of
   * asserting on a range.
   */
  random?: () => number
}

/**
 * Spread a delay uniformly across the back half of its window: `[d/2, d]`.
 *
 * Use this directly when the schedule is already computed elsewhere (e.g. a
 * poller that keeps its own running delay) and only the desynchronisation is
 * missing.
 */
export function applyJitter(delayMs: number, random: () => number = Math.random): number {
  const half = delayMs / 2
  return Math.round(half + random() * half)
}

/**
 * Delay in ms before retry number `attempt` (0-based).
 *
 * Returns a value in `[d/2, d]` where `d = min(maxMs, baseMs * factor ** attempt)`.
 */
export function backoffWithJitter(
  attempt: number,
  { baseMs, maxMs, factor = 2, random = Math.random }: BackoffOptions
): number {
  const exponential = Math.min(maxMs, baseMs * factor ** Math.max(0, attempt))
  return applyJitter(exponential, random)
}
