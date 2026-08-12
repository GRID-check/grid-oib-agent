/**
 * Which building a model file belongs to.
 *
 * An office does not upload "a model". It uploads `Haus-A.ifc`, then
 * `Haus-A_V2.ifc` three weeks later, then `Haus-A_rev3_2026-02-11.ifc` after
 * the Behörde comes back. Those are one building at four moments, and reading
 * the file name is what lets the product say so — see `features/bim/lib/
 * revisions.ts` for the timeline built on top of it, and for why the lineage
 * is a name rather than a column nobody would fill in.
 *
 * It lives HERE, in the shared layer, because two very different things depend
 * on agreeing about it: the client's revision timeline, and the server's
 * scoping of a signed human confirmation to the building it was made about. A
 * second copy of these regular expressions would eventually disagree with the
 * first, and the way it would show up is a confirmation attached to the wrong
 * building.
 *
 * Pure — a function of a file name and nothing else.
 */

/**
 * Revision markers, stripped from the end of a file's base name.
 *
 * Deliberately anchored and deliberately narrow. A bare trailing number is only
 * stripped when it is parenthesised (`Haus-A (2)`, the shape every OS gives a
 * duplicate) — `Bauteil 2.ifc` and `Halle 3.ifc` are two buildings, not two
 * revisions of one, and merging them would put one building's storeys in the
 * other's delta.
 */
const REVISION_MARKERS: RegExp[] = [
  // `_v2`, `-V2`, ` v1.3`, `_rev3`, `-revision 2`, ` stand 4`
  /[ _-]?(v|ver|rev|revision|version|stand|st)[ _.-]?\d+(\.\d+)*$/i,
  // `(2)`, ` (12)` — the duplicate-file suffix
  /[ _-]?\(\d+\)$/,
  // `_2026-02-11`, `-20260211`, ` 2026_02_11`
  /[ _-]\d{4}[-_]?\d{2}[-_]?\d{2}$/,
  // `_20260211T0930`, an export timestamp
  /[ _-]\d{8}t?\d{4,6}$/i,
]

/** Trailing separators left behind once a marker is removed. */
const TRAILING_SEPARATORS = /[ _.-]+$/

/**
 * The building a file name refers to, with its revision marker removed.
 *
 * Applied repeatedly, because `Haus-A_rev3_2026-02-11.ifc` carries two.
 */
export function revisionSeriesKey(filename: string): string {
  let base = filename.replace(/\.(ifc|ifczip)$/i, '')
  for (let pass = 0; pass < 4; pass += 1) {
    const before = base
    for (const marker of REVISION_MARKERS) {
      base = base.replace(marker, '')
    }
    base = base.replace(TRAILING_SEPARATORS, '')
    if (base === before) break
  }
  // A name that is nothing but a revision marker keeps its original form rather
  // than collapsing every such file into one empty-named series.
  const trimmed = base.trim()
  return (trimmed.length > 0 ? trimmed : filename).toLowerCase()
}
