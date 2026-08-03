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

/**
 * A retry ladder: the delay schedule **plus the state and the timer**.
 *
 * The two functions above are pure, which is why every caller that needed a
 * ladder re-invented the state around them — an `attempt` counter, a timer ref,
 * a cancel, and a rule for when the count goes back to zero. There were four
 * such copies in the collaboration surface alone (the shared event hub, the
 * per-turn spectator stream, the sharing read and the access read), and **each
 * of them got the reset wrong at least once**: a tab that had ridden out one
 * outage resuming its next failure at the ceiling, a budget spent by four
 * failures spread over an hour of healthy connection, a timer that outlived the
 * effect that made it.
 *
 * `websocket-client.ts` deliberately keeps its own: its `reconnectCount` is also
 * read as "are we mid-reconnect?" to suppress the intermediate status callbacks
 * that would otherwise flicker the connection indicator, so collapsing it into
 * an opaque ladder would cost a signal the ladder has no business owning.
 * `use-connection-recovery.ts` is a poller with a running delay, not a ladder.
 *
 * The reset rule is the whole point, and it is one sentence: **evidence that it
 * works starts the ladder over.** As a primitive that is an invariant; as four
 * hand-written copies it was four chances to forget.
 *
 * Deliberately not a hook — two of the four call sites are module singletons,
 * not components.
 */
export interface RetryLadder {
  /**
   * Run `attempt` after the next rung's delay, and step down. Returns false when
   * the budget is spent, having scheduled nothing — so a caller can say "now it
   * is a real failure" in the same `if`.
   *
   * Replaces any retry already pending: two failures in flight are one retry.
   */
  schedule(attempt: () => void): boolean
  /** Evidence it works. Back to the first rung, and any pending retry dropped. */
  reset(): void
  /**
   * Drop the pending retry but KEEP the position. For teardown — the ladder is
   * being abandoned, not vindicated.
   */
  cancel(): void
  /** True once the budget is spent, i.e. `schedule` will refuse. */
  readonly spent: boolean
}

export type RetryLadderOptions =
  /** An explicit schedule. The ladder is spent after the last entry. */
  | { delaysMs: readonly number[] }
  /** Exponential with jitter, optionally bounded. Unbounded without `budget`. */
  | (BackoffOptions & { budget?: number })

export function createRetryLadder(options: RetryLadderOptions): RetryLadder {
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  /** Whether rung `index` exists at all. Kept separate from the delay so `spent`
      can ask the question without drawing from `random` — reading a getter must
      not move a seeded sequence on under a test. */
  const hasRung = (index: number): boolean =>
    'delaysMs' in options
      ? options.delaysMs[index] !== undefined
      : options.budget === undefined || index < options.budget

  const delayFor = (index: number): number | null => {
    if (!hasRung(index)) return null
    if ('delaysMs' in options) return options.delaysMs[index]
    return backoffWithJitter(index, options)
  }

  const cancel = (): void => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  return {
    schedule(attempt) {
      const delay = delayFor(attempts)
      if (delay === null) return false
      attempts += 1
      cancel()
      timer = setTimeout(() => {
        timer = null
        attempt()
      }, delay)
      return true
    },
    reset() {
      attempts = 0
      cancel()
    },
    cancel,
    get spent() {
      return !hasRung(attempts)
    },
  }
}
