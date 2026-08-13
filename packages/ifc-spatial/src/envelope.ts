/**
 * The answer contract.
 *
 * Every operator in this library returns an {@link Answer}, and an `Answer`
 * always says three things beyond the value itself: **how it was obtained**,
 * **which elements it came from**, and **whether it could be obtained at all**.
 *
 * ## Why this shape, and not `number`
 *
 * The consumer of this library is a language model writing a sentence that a
 * human being will sign. Three claims that a bare number cannot tell apart:
 *
 *   - *the model says the wall is 290 mm thick* — the file declares it, and the
 *     claim is wrong only if the export is wrong;
 *   - *I measured the roof projecting 1.32 m past the facade* — geometry, true
 *     within a tolerance that must travel with it;
 *   - *this room is probably an Aufenthaltsraum* — a heuristic with a reason.
 *
 * Collapsing those into one number is how a guess gets stamped. So provenance
 * is not optional metadata; it is the first field a caller reads, and the
 * renderer is expected to put a different German verb in front of each one
 * (`deklariert` / `gemessen` / `vermutlich`).
 *
 * ## Undecidable is a result, not an error
 *
 * `decidable: false` means the question was well-formed and this file cannot
 * answer it. It carries {@link Answer.missing} — what would settle it — because
 * "the model does not publish a fire rating" is a finding about the EXPORT that
 * the architect can act on, while a thrown error is a finding about us.
 *
 * An exception is reserved for the third case: we could not look at all. A
 * caller must be able to distinguish "looked, and the file cannot say" from
 * "never looked".
 */

/** How a value came to be known. The caller must render these differently. */
export type Provenance =
  /** The file states it. Wrong only if the export is wrong. */
  | 'declared'
  /** Derived from the file's own structure or geometry, within `tolerance`. */
  | 'computed'
  /** A heuristic. Always carries `confidence` and `because`. */
  | 'inferred'

/** What would make an undecidable question decidable. */
export interface MissingFact {
  /**
   * What is absent, in the file's own vocabulary — a property path
   * (`Pset_WindowCommon.SillHeight`), an entity (`IfcSpace`), or a relation
   * (`IfcRelFillsElement`).
   */
  what: string
  /** Where it would have to appear, in words an architect can act on. */
  remedy: string
  /** Elements the gap applies to, when it is not model-wide. */
  elements?: string[]
}

/**
 * One answer, with everything needed to audit it.
 *
 * @typeParam T - the value's shape; `null` whenever `decidable` is false.
 */
export interface Answer<T> {
  value: T | null
  /** SI or the file's declared unit, spelled the way it should be printed. */
  unit: string | null
  /**
   * Absolute tolerance in `unit`, for computed values. `null` for declared
   * values (a declared number has no measurement error, only authoring error)
   * and for non-numeric answers.
   */
  tolerance: number | null
  provenance: Provenance
  /** GlobalIds the value was derived from, in the order they were used. */
  from: string[]
  /** The operator expression, as text a reviewer can read back. */
  method: string
  decidable: boolean
  /** Present exactly when `decidable` is false. */
  missing?: MissingFact
  /** Present for `inferred` answers: 0..1, and the reasons behind it. */
  confidence?: number
  because?: string[]
  /**
   * A qualification the answer is not valid without — the analogue of the
   * truncation caveats the query layer already carries. A caller that drops
   * this is reporting a subset as a total.
   */
  caveat?: string
}

/** The file states it. */
export function declared<T>(value: T, opts: { unit?: string | null; from: string[]; method: string; caveat?: string }): Answer<T> {
  return {
    value,
    unit: opts.unit ?? null,
    tolerance: null,
    provenance: 'declared',
    from: opts.from,
    method: opts.method,
    decidable: true,
    ...(opts.caveat ? { caveat: opts.caveat } : {}),
  }
}

/** We worked it out, within a tolerance. */
export function computed<T>(
  value: T,
  opts: { unit?: string | null; tolerance?: number | null; from: string[]; method: string; caveat?: string }
): Answer<T> {
  return {
    value,
    unit: opts.unit ?? null,
    tolerance: opts.tolerance ?? null,
    provenance: 'computed',
    from: opts.from,
    method: opts.method,
    decidable: true,
    ...(opts.caveat ? { caveat: opts.caveat } : {}),
  }
}

/**
 * A heuristic.
 *
 * `because` is required rather than optional: an inference whose reasons are
 * invisible cannot be argued with, and this library's whole stance is that a
 * reviewer must be able to disagree with it in specific terms.
 */
export function inferred<T>(
  value: T,
  opts: { unit?: string | null; from: string[]; method: string; confidence: number; because: string[]; caveat?: string }
): Answer<T> {
  return {
    value,
    unit: opts.unit ?? null,
    tolerance: null,
    provenance: 'inferred',
    from: opts.from,
    method: opts.method,
    decidable: true,
    confidence: opts.confidence,
    because: opts.because,
    ...(opts.caveat ? { caveat: opts.caveat } : {}),
  }
}

/**
 * Well-formed question, and this file cannot answer it.
 *
 * `provenance` stays meaningful here — it records which ROUTE was attempted, so
 * "no declared value" and "geometry absent" are different answers to the reader
 * even though both are undecidable.
 */
export function undecidable<T>(opts: {
  from: string[]
  method: string
  missing: MissingFact
  provenance?: Provenance
}): Answer<T> {
  return {
    value: null,
    unit: null,
    tolerance: null,
    provenance: opts.provenance ?? 'declared',
    from: opts.from,
    method: opts.method,
    decidable: false,
    missing: opts.missing,
  }
}

/**
 * Two independent routes to the same number, and what to say about the pair.
 *
 * Agreement raises confidence in a declared value; disagreement is a finding
 * about the export — the architect's schedule and their geometry are saying
 * different things, which is worth more to them than either number alone.
 *
 * `relativeTolerance` defaults to 2 %, the band inside which two ways of
 * measuring the same room are not usefully different.
 */
export function triangulate(
  a: Answer<number>,
  b: Answer<number>,
  opts: { relativeTolerance?: number; method: string } = { method: 'triangulate' }
): Answer<number> & { agreement: 'agree' | 'disagree' | 'single' } {
  const tol = opts.relativeTolerance ?? 0.02
  const both = a.decidable && b.decidable && typeof a.value === 'number' && typeof b.value === 'number'

  if (!both) {
    const present = a.decidable ? a : b.decidable ? b : null
    if (!present) {
      return {
        ...undecidable<number>({
          from: [...a.from, ...b.from],
          method: opts.method,
          missing: a.missing ?? b.missing ?? { what: 'both routes', remedy: 'no route to this value in this file' },
        }),
        agreement: 'single',
      }
    }
    return { ...present, method: opts.method, agreement: 'single' }
  }

  const av = a.value as number
  const bv = b.value as number
  const scale = Math.max(Math.abs(av), Math.abs(bv), Number.EPSILON)
  const delta = Math.abs(av - bv) / scale

  // The COMPUTED value is reported when the two disagree. A declared quantity
  // that contradicts the geometry it is supposed to describe is the thing under
  // suspicion; the geometry is what the building will be built from.
  const winner = delta <= tol ? a : a.provenance === 'computed' ? a : b

  return {
    ...winner,
    method: opts.method,
    from: [...new Set([...a.from, ...b.from])],
    agreement: delta <= tol ? 'agree' : 'disagree',
    ...(delta > tol
      ? {
          caveat:
            `Zwei Wege zu dieser Zahl widersprechen sich: ${fmt(av)} (${a.provenance}) gegen ` +
            `${fmt(bv)} (${b.provenance}), Abweichung ${(delta * 100).toFixed(1)} %. ` +
            `Das ist ein Befund über den Export, nicht über das Gebäude.`,
        }
      : {}),
  }
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}
