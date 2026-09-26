/**
 * How much slower a function gets when its input grows: the check behind every
 * "is linear in …" spec.
 *
 * A wall-clock budget fails on a loaded runner and passes a defect on a fast
 * one; a ratio of two sizes on the same runner does neither. Linear, eight
 * times the input takes about eight times as long; quadratic, about
 * sixty-four. Callers assert the ratio stays under {@link LINEAR_BOUND}.
 *
 * Measuring a ratio honestly takes three things the first versions of these
 * specs lacked, and each one flaked without it:
 * - a warm-up of BOTH sizes, so the JIT compiles the large path before it is
 *   timed (a cold large run read 40× against a warm small one);
 * - several samples per size, interleaved, keeping the fastest, so a GC pause
 *   or a scheduler stall in one run decides nothing;
 * - a floor under the small time, so a sub-timer-resolution run does not turn
 *   noise into a huge ratio.
 */

/** Under this, 8× the input is linear; the quadratic signature is ~64. */
export const LINEAR_BOUND = 40

/** Milliseconds `run` takes, once. */
export function elapsedMs(run: () => void): number {
  const started = performance.now()
  run()
  return performance.now() - started
}

export interface GrowthOptions {
  /** The small input size; the large one is `size * factor`. */
  size: number
  factor?: number
  samples?: number
  /** The least the small time counts as, in milliseconds. */
  floorMs?: number
}

/**
 * The fastest time at `size * factor` over the fastest time at `size`.
 * `timeOnce` builds its input outside the clock and returns the milliseconds
 * of one run (use {@link elapsedMs}).
 */
export function growthRatio(
  timeOnce: (size: number) => number,
  { size, factor = 8, samples = 9, floorMs = 0.5 }: GrowthOptions
): number {
  const large = size * factor
  timeOnce(size)
  timeOnce(large)
  let fastSmall = Number.POSITIVE_INFINITY
  let fastLarge = Number.POSITIVE_INFINITY
  for (let i = 0; i < samples; i++) {
    fastSmall = Math.min(fastSmall, timeOnce(size))
    fastLarge = Math.min(fastLarge, timeOnce(large))
  }
  return fastLarge / Math.max(fastSmall, floorMs)
}
