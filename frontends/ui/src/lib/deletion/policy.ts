const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Grace must stay ≤ 23 days so grace + purge retries fit inside the GDPR
 * Art. 12(3) one-month response window for erasure requests.
 */
const MAX_GRACE_DAYS = 23
const DEFAULT_GRACE_DAYS = 7

export function projectGraceDays(): number {
  const raw = Number(process.env.PROJECT_PURGE_GRACE_DAYS)
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_GRACE_DAYS
  return Math.min(raw, MAX_GRACE_DAYS)
}

export function computePurgeAfter(requestedAt: Date, graceDays: number): Date {
  return new Date(requestedAt.getTime() + graceDays * DAY_MS)
}
