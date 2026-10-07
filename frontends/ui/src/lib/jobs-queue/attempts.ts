/**
 * How many claims a job gets, as the BFF in a `bff-jobs` pod knows it.
 *
 * The runner decides when a job is dead (`GRID_BFF_JOBS_MAX_ATTEMPTS`, default
 * 3, read in `workers/jobs/index.js`). The BFF in the same pod sees the same
 * environment, so a handler can tell that the attempt it is running is the
 * last one and leave the truth behind before the queue gives up on it: a
 * document that will never be extracted should say so, not read "processing"
 * until somebody notices. Two readers of one name, with the runner's default
 * written in both; `attempts.spec.ts` holds the two defaults together.
 */

const DEFAULT_MAX_ATTEMPTS = 3

export function maxAttempts(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env.GRID_BFF_JOBS_MAX_ATTEMPTS ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_ATTEMPTS
}

/** True when `attempts` (spent so far, this one included) is the last claim the job gets. */
export function isLastAttempt(attempts: number, env: Record<string, string | undefined> = process.env): boolean {
  return attempts >= maxAttempts(env)
}
