const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Grace must stay ≤ 23 days so grace + purge retries fit inside the GDPR
 * Art. 12(3) one-month response window for erasure requests.
 */
const MAX_GRACE_DAYS = 23
const DEFAULT_GRACE_DAYS = 7
/** How long a deleted folder stays in the Papierkorb, restorable (ADR-0085). */
const DEFAULT_FOLDER_GRACE_DAYS = 14

/** A grace period from the environment: a number of days, at least 0 and at most {@link MAX_GRACE_DAYS}. */
function graceDays(raw: string | undefined, fallback: number): number {
  const days = Number(raw)
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(days) || days < 0) return fallback
  return Math.min(days, MAX_GRACE_DAYS)
}

export function projectGraceDays(): number {
  return graceDays(process.env.PROJECT_PURGE_GRACE_DAYS, DEFAULT_GRACE_DAYS)
}

/** `FOLDER_PURGE_GRACE_DAYS`: how long a folder waits in the Papierkorb before its purge. Default 14, at most 23. */
export function folderGraceDays(): number {
  return graceDays(process.env.FOLDER_PURGE_GRACE_DAYS, DEFAULT_FOLDER_GRACE_DAYS)
}

export function computePurgeAfter(requestedAt: Date, graceDays: number): Date {
  return new Date(requestedAt.getTime() + graceDays * DAY_MS)
}
