/**
 * Pure planning helpers for `provision-workos-environment.ts`.
 *
 * Kept free of I/O so the desired-vs-current decisions can be unit-tested
 * without a WorkOS connection — the same split the suite uses elsewhere
 * (logic in a plain module, the shell stays untested).
 */

/** Parse a comma-separated env value into a clean, ordered, de-duplicated list. */
export function splitList(raw: string | undefined): string[] {
  const seen = new Set<string>()
  for (const part of raw?.split(',') ?? []) {
    const value = part.trim()
    if (value) seen.add(value)
  }
  return [...seen]
}

/** What would have to be added or removed to turn `current` into `desired`. Both sorted, de-duplicated. */
export function diffSets(
  desired: readonly string[],
  current: readonly string[]
): { missing: string[]; extra: string[] } {
  const wanted = new Set(desired)
  const present = new Set(current)
  const missing = [...new Set(desired)].filter((value) => !present.has(value)).sort()
  const extra = [...new Set(current)].filter((value) => !wanted.has(value)).sort()
  return { missing, extra }
}

export interface FlagTargetEntry {
  slug: string
  orgIds: string[]
}

export type FlagTargetsParse =
  | { ok: true; entries: FlagTargetEntry[] }
  | { ok: false; error: string }

/**
 * Parse WORKOS_FLAG_TARGETS_JSON — a JSON object mapping flag slug to the
 * array of organization ids that should be targeted. Returns a structured
 * error instead of throwing so the caller can fail loudly with context.
 */
export function parseFlagTargets(raw: string | undefined): FlagTargetsParse {
  if (!raw || !raw.trim()) return { ok: true, entries: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, error: `not valid JSON: ${String(error)}` }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'expected a JSON object mapping flag slugs to arrays of org ids' }
  }

  const entries: FlagTargetEntry[] = []
  for (const [rawSlug, rawOrgIds] of Object.entries(parsed)) {
    const slug = rawSlug.trim()
    if (!slug) return { ok: false, error: 'found an empty flag slug key' }
    if (!Array.isArray(rawOrgIds)) {
      return { ok: false, error: `value for "${slug}" must be an array of org ids` }
    }
    const orgIds = splitList(rawOrgIds.map(String).join(','))
    if (orgIds.length === 0) {
      return { ok: false, error: `value for "${slug}" must contain at least one org id` }
    }
    entries.push({ slug, orgIds })
  }
  return { ok: true, entries }
}
