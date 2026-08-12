/**
 * The per-tab trail of in-app locations, so a page that lives OUTSIDE the
 * project shell can send the reader back to where they actually came from — and
 * say its name.
 *
 * The org Archiv (ADR-0024) is the case this exists for. It sits above projects
 * and drops the project rail, so its only way out is a back link — and that link
 * could only ever guess: it resolved the user's *active project* server-side and
 * sent everyone there, which is not where most readers came from (the Archiv is
 * reached from the ⌘K palette, the user menu and the rail, from any page). A
 * reader who opened it from another project's Dateien landed somewhere else
 * entirely and read that as "back did not work".
 *
 * The trail is a STACK of locations, not a log:
 *   - consecutive duplicates collapse (a `replace` to the same path is not a step),
 *   - revisiting a path already on the stack TRUNCATES back to it, so a browser
 *     Back leaves the stack in the same shape a fresh forward walk would.
 *
 * That last rule is what makes `history.back()` safe for the consumer: the entry
 * below the top of the stack is always the entry one step back in browser
 * history, whether the reader arrived by link or by Back/Forward.
 *
 * An entry can also carry a LABEL — the name of that location as the reader saw
 * it, e.g. the project name. It is written by the page that knows it
 * ({@link import('@/components/shell/navigation-trail').NavigationTrailLabel}),
 * because only that page does: the path holds a project id, and an id is not a
 * name. Without it the consumer can still name a page by its route, but never
 * "Zurück zu Stadthaus Wien".
 *
 * Storage is `sessionStorage`, which is per TAB — exactly the scope of a browser
 * history stack. A second tab opened on the Archiv starts empty and falls back
 * to the server-resolved link rather than inheriting the first tab's trail.
 */

/** Key under which the trail is persisted for the tab. */
const STORAGE_KEY = 'grid.return-trail'

/**
 * How many entries to keep. The consumer only ever reads the entry below the
 * top; the rest is headroom for truncation-on-revisit to find a match after a
 * few steps. Small on purpose — this is navigation state, not history.
 */
const MAX_ENTRIES = 12

/** One visited location: its path, plus the name the reader knows it by. */
export interface TrailEntry {
  path: string
  /** What the page called itself, when it said so. Never derived from the path. */
  label?: string
}

export type ReturnTrail = readonly TrailEntry[]

/**
 * Append `path` to the trail, applying the stack rules above.
 *
 * Pure: takes and returns a trail, so the rules are testable without a DOM.
 * Returns the trail unchanged (same reference) when the visit is a no-op, so
 * callers can skip the write.
 */
export function recordVisit(trail: ReturnTrail, path: string): ReturnTrail {
  if (path === '') return trail
  if (trail[trail.length - 1]?.path === path) return trail

  const seenAt = lastIndexOfPath(trail, path)
  // Revisit (typically a browser Back): unwind to that entry instead of
  // stacking a second copy, so the entry below it is still the true previous.
  // The label it was given the first time is still true, so it is kept.
  if (seenAt !== -1) return trail.slice(0, seenAt + 1)

  return [...trail, { path }].slice(-MAX_ENTRIES)
}

/**
 * Name the location at `path` — the page telling the trail what it is called.
 *
 * Applies to the most recent entry with that path, and only to a path already on
 * the trail: a label for a page nobody recorded has nothing to attach to.
 */
export function labelVisit(trail: ReturnTrail, path: string, label: string): ReturnTrail {
  if (label === '') return trail
  const at = lastIndexOfPath(trail, path)
  if (at === -1 || trail[at].label === label) return trail
  const next = [...trail]
  next[at] = { path, label }
  return next
}

/**
 * The location one step back from `currentPath` — i.e. the entry below it on the
 * stack — or `null` when the tab has no record of how the reader got here
 * (direct link, restored tab, first page of the session).
 *
 * Only answers for the top of the stack: if the trail has moved on, the caller's
 * page is stale and guessing a "back" for it would be worse than falling back to
 * the server-resolved link.
 */
export function previousVisit(trail: ReturnTrail, currentPath: string): TrailEntry | null {
  if (trail[trail.length - 1]?.path !== currentPath) return null
  return trail[trail.length - 2] ?? null
}

/** Read the tab's trail. Returns an empty trail in SSR or on any storage error. */
export function readTrail(): ReturnTrail {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry): TrailEntry[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const { path, label } = entry as { path?: unknown; label?: unknown }
      if (typeof path !== 'string' || path === '') return []
      return [typeof label === 'string' && label !== '' ? { path, label } : { path }]
    })
  } catch {
    // Private-mode / quota-disabled storage: navigate without a trail rather
    // than breaking the page that reads it.
    return []
  }
}

/** Persist the tab's trail, ignoring storage failures (see {@link readTrail}). */
export function writeTrail(trail: ReturnTrail): void {
  if (typeof window === 'undefined') return
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trail))
  } catch {
    // Nothing to do: the trail is an enhancement over the server-resolved link.
  }
}

function lastIndexOfPath(trail: ReturnTrail, path: string): number {
  for (let i = trail.length - 1; i >= 0; i--) {
    if (trail[i].path === path) return i
  }
  return -1
}
