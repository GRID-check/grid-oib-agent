/**
 * Büro-Chat deployment knobs (ADR-0054).
 *
 * One reader per knob, from the first line. The mount cap is the number that
 * bounds a workspace turn's retrieval cost — base + Archiv + at most this many
 * project collections — and ADR-0054 makes it enforceable in exactly one place
 * (`POST /api/conversations/:id/mounts`). A second `process.env` read anywhere
 * else is how "enforced in one place" quietly becomes two places that disagree,
 * so the cap is a function here rather than a constant a caller may re-derive.
 */

import 'server-only'

/** The cap when `GRID_WORKSPACE_MAX_MOUNTED_PROJECTS` is unset or unusable. */
export const DEFAULT_MAX_MOUNTED_PROJECTS = 5

/**
 * The band the cap is clamped into.
 *
 * Both ends are measurements, not taste. Below 1 the feature has no mount at
 * all, which is a broken deployment rather than a strict one — the refusal
 * would fire on the first mount and the agent would have nothing to offer but
 * deep research. Above 20 nothing in the retrieval path has been measured:
 * ADR-0054's latency gate (p95 time-to-first-token at the cap ≤ 1.5× one mount)
 * has only ever been run at five, and rank fusion was tuned for four shelves.
 * A deployment that sets 200 gets 20 and a working product, not 200 and a
 * timeout.
 */
export const MIN_MAX_MOUNTED_PROJECTS = 1
export const MAX_MAX_MOUNTED_PROJECTS = 20

/**
 * How many projects one workspace conversation may mount at once.
 *
 * Read per call rather than captured at module load, so a test — and a
 * deployment that changes the variable — sees the new value without a fresh
 * module graph. It is a single integer parse; nothing on the hot path pays for
 * this.
 *
 * Garbage (`''`, `'abc'`, `'5x'`, `NaN`, `Infinity`) falls back to the default
 * instead of clamping to a bound: an unparseable value is a typo, and a typo
 * must not silently become the minimum or the maximum.
 */
export function maxMountedProjects(): number {
  const raw = (process.env.GRID_WORKSPACE_MAX_MOUNTED_PROJECTS ?? '').trim()
  const parsed = Number(raw)
  if (raw === '' || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return DEFAULT_MAX_MOUNTED_PROJECTS
  }
  return Math.min(Math.max(parsed, MIN_MAX_MOUNTED_PROJECTS), MAX_MAX_MOUNTED_PROJECTS)
}
