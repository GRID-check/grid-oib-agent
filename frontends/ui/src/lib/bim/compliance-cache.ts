/**
 * A small in-process memo for the compliance catalogue.
 *
 * ## Why this is cacheable at all
 *
 * A `ready` model is immutable: `completeBimModel` writes the element rows
 * once and nothing edits them afterwards — a new revision is a new row with a
 * new id. So a catalogue run is a pure function of
 * `(modelId, gebaeudeklasse, hauptnutzung)`, and the same three inputs can
 * only ever produce the same verdicts. Recomputing is always *correct*; it is
 * just expensive.
 *
 * ## What it costs not to have one
 *
 * Measured against a seeded 400 000-element model: one `compliance` run is
 * ~1.5 s wall and ~126 MB of resident memory, of which ~900 ms is the driver
 * parsing 50 000 rows of jsonb on the single-threaded event loop. Nothing
 * cached it — the route is a POST, so no HTTP cache applies, and the client
 * hook is a bare `useEffect` with no dedupe. Opening the Prüfbuch tab, then
 * exporting BCF, then having a chat card render the same requirements, was
 * three full passes over the same immutable rows.
 *
 * ## Why an LRU and not a table
 *
 * Persisting `bim_checks` per revision is the right long-term shape and is
 * still open on the roadmap. This is the cheap 90%: no migration, no
 * invalidation logic to get wrong (an entry can never go stale, because its
 * key names an immutable model), and it disappears with the pod. The cap is on
 * ENTRY COUNT rather than bytes because a rule result set is bounded by
 * construction — `VISIBLE_VERDICTS` caps the rows per rule and the catalogue
 * has a fixed number of rules — so entries are kilobytes, not megabytes.
 *
 * A TTL exists anyway as a backstop: a long-lived pod holding verdicts for
 * models nobody has opened in an hour is holding them for no reason.
 */

import type { BimComplianceSummary, BimRuleResult } from './rules'

export interface CachedCompliance {
  compliance: BimRuleResult[]
  complianceSummary: BimComplianceSummary
  complianceShoppingList: Array<{ path: string; elements: number; rules: string[] }>
  /** The element loader capped — carried so the warning survives the cache. */
  truncated: boolean
}

interface Entry {
  value: CachedCompliance
  storedAt: number
}

/** Entries, not bytes — see the note above on why that is safe here. */
const MAX_ENTRIES = 64
const TTL_MS = 60 * 60 * 1000

const cache = new Map<string, Entry>()

/**
 * The cache key.
 *
 * `modelId` alone is not enough: the same revision judged at Gebäudeklasse 4
 * and at 5 produces different fire-resistance verdicts, and serving one for
 * the other is exactly the class of silent wrong answer this subsystem exists
 * to avoid. Both facts are part of the identity of the result.
 */
function key(modelId: string, gebaeudeklasse: number | null, hauptnutzung: string | null): string {
  return `${modelId}|${gebaeudeklasse ?? ''}|${hauptnutzung ?? ''}`
}

export function readComplianceCache(
  modelId: string,
  gebaeudeklasse: number | null,
  hauptnutzung: string | null,
  now: number = Date.now()
): CachedCompliance | null {
  const id = key(modelId, gebaeudeklasse, hauptnutzung)
  const entry = cache.get(id)
  if (!entry) return null
  if (now - entry.storedAt > TTL_MS) {
    cache.delete(id)
    return null
  }
  // Re-insert so the Map's insertion order is a recency order — that is what
  // makes the eviction below least-recently-USED rather than oldest-written.
  cache.delete(id)
  cache.set(id, entry)
  return entry.value
}

export function writeComplianceCache(
  modelId: string,
  gebaeudeklasse: number | null,
  hauptnutzung: string | null,
  value: CachedCompliance,
  now: number = Date.now()
): void {
  const id = key(modelId, gebaeudeklasse, hauptnutzung)
  cache.delete(id)
  cache.set(id, { value, storedAt: now })
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

/** Test seam. Never called in production — entries cannot go stale. */
export function clearComplianceCache(): void {
  cache.clear()
}
