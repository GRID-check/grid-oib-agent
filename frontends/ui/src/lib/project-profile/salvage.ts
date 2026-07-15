/**
 * Lenient, per-part salvage of a stored {@link ProjectProfile}.
 *
 * The intake page used to `ProjectProfileSchema.safeParse` the stored profile and
 * fall back to `null` on ANY failure — a single malformed fact discarded the whole
 * brief, the wizard opened blank in create mode, and the next Save overwrote the
 * stored profile with only the freshly-typed answers (silent data loss).
 *
 * This helper instead validates each part individually and keeps everything that
 * is still well-formed, dropping only the invalid entries. It reports what was
 * dropped so the wizard can show an honest banner ("parts could not be loaded and
 * will be replaced when you save") instead of silently discarding data.
 *
 * Pure and isomorphic — no I/O, safe on the server or the client.
 */
import {
  ProjectAssumptionSchema,
  ProjectFactSchema,
  ProjectPrimitiveValueSchema,
  ProjectProfileSchema,
} from './types'
import type { ProjectAssumption, ProjectFact, ProjectPrimitiveValue, ProjectProfile } from './types'

export interface SalvageResult {
  /**
   * The best-effort recovered profile, or `null` when nothing usable could be
   * recovered (a fully-invalid or absent profile → the wizard opens in create
   * mode). A non-null profile may still have had individual entries dropped —
   * see {@link SalvageResult.dropped}.
   */
  profile: ProjectProfile | null
  /**
   * Identifiers of the parts that failed validation and were discarded (e.g.
   * `facts.hauptnutzung`, `goals.focus_areas`, `unknowns[2]`). Empty when the
   * stored profile was fully valid (or genuinely absent). Non-empty → the wizard
   * shows the replacement-warning banner.
   */
  dropped: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Attempt a lenient, per-part salvage of a raw stored project profile.
 *
 * - A fully valid profile is returned untouched with `dropped: []`.
 * - A genuinely absent profile (`null` / `undefined` / the empty `{}` default) is
 *   reported as `{ profile: null | <empty>, dropped: [] }` — no banner.
 * - A malformed profile keeps every well-formed fact / goal / unknown / assumption
 *   and lists the rest in `dropped`.
 * - A profile with no salvageable content (everything dropped, or a non-object)
 *   returns `{ profile: null, dropped: [...] }` so the wizard opens in create mode
 *   while still warning the user.
 */
export function salvageProjectProfile(raw: unknown): SalvageResult {
  // Fast path: a fully valid profile passes straight through, nothing dropped.
  const full = ProjectProfileSchema.safeParse(raw)
  if (full.success) {
    return { profile: full.data, dropped: [] }
  }

  // A genuinely absent profile is not a corruption — no banner, create mode.
  if (raw === null || raw === undefined) {
    return { profile: null, dropped: [] }
  }

  // A non-object (string / number / boolean / array) is unsalvageable, but it IS
  // corrupt data rather than an absent profile → warn via a non-empty `dropped`.
  if (!isPlainObject(raw)) {
    return { profile: null, dropped: ['profile'] }
  }

  const dropped: string[] = []

  const facts = salvageRecord<ProjectFact>(raw.facts, ProjectFactSchema, 'facts', dropped)
  const assumptions = salvageRecord<ProjectAssumption>(raw.assumptions, ProjectAssumptionSchema, 'assumptions', dropped)
  const goals = salvageGoals(raw.goals, dropped)
  const unknowns = salvageUnknowns(raw.unknowns, dropped)

  const anySalvaged =
    Object.keys(facts).length > 0 ||
    Object.keys(goals).length > 0 ||
    unknowns.length > 0 ||
    Object.keys(assumptions).length > 0

  // Nothing survived — treat as a full failure so the wizard opens in create mode.
  if (!anySalvaged) {
    return { profile: null, dropped: dropped.length > 0 ? dropped : ['profile'] }
  }

  // Re-validate the reassembled profile so defaults/shape are guaranteed. This
  // must succeed (every kept entry already validated), but fall back defensively.
  const rebuilt = ProjectProfileSchema.safeParse({ facts, goals, unknowns, assumptions })
  if (!rebuilt.success) {
    return { profile: null, dropped: dropped.length > 0 ? dropped : ['profile'] }
  }

  return { profile: rebuilt.data, dropped }
}

/** Validate each value of a record against `schema`, dropping the invalid ones. */
function salvageRecord<T>(
  raw: unknown,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } },
  section: string,
  dropped: string[],
): Record<string, T> {
  const out: Record<string, T> = {}
  if (raw === undefined || raw === null) return out
  if (!isPlainObject(raw)) {
    dropped.push(section)
    return out
  }
  for (const [key, value] of Object.entries(raw)) {
    const parsed = schema.safeParse(value)
    if (parsed.success) {
      out[key] = parsed.data
    } else {
      dropped.push(`${section}.${key}`)
    }
  }
  return out
}

/** Goals are bare primitive values — validate each, drop the invalid ones. */
function salvageGoals(raw: unknown, dropped: string[]): Record<string, ProjectPrimitiveValue> {
  const out: Record<string, ProjectPrimitiveValue> = {}
  if (raw === undefined || raw === null) return out
  if (!isPlainObject(raw)) {
    dropped.push('goals')
    return out
  }
  for (const [key, value] of Object.entries(raw)) {
    const parsed = ProjectPrimitiveValueSchema.safeParse(value)
    if (parsed.success) {
      out[key] = parsed.data
    } else {
      dropped.push(`goals.${key}`)
    }
  }
  return out
}

/** Unknowns are a string array — keep the strings, drop anything else. */
function salvageUnknowns(raw: unknown, dropped: string[]): string[] {
  const out: string[] = []
  if (raw === undefined || raw === null) return out
  if (!Array.isArray(raw)) {
    dropped.push('unknowns')
    return out
  }
  raw.forEach((item, index) => {
    if (typeof item === 'string') {
      out.push(item)
    } else {
      dropped.push(`unknowns[${index}]`)
    }
  })
  return out
}
