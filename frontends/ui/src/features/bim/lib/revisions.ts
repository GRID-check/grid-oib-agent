/**
 * Model revisions as a series, not a folder of files.
 *
 * An office does not upload "a model". It uploads `Haus-A.ifc`, then
 * `Haus-A_V2.ifc` three weeks later, then `Haus-A_rev3_2026-02-11.ifc` after the
 * Behörde comes back. Those are one building at four moments, and the product is
 * only useful if it says so: the question "what changed since the version the
 * authority already has" needs a *previous*, and nothing else in the system
 * knows which file that is.
 *
 * So the file names are read for the revision markers offices actually use, the
 * series is ordered by ingestion time, and each step carries the deltas that can
 * be computed from the summaries alone — element count, room count, floor area,
 * model-quality score. Those come free: they are already in `bim_models.summary`,
 * so a timeline of six revisions costs zero queries. The expensive per-element
 * diff stays on demand, one step at a time.
 *
 * ## Why the name and not a lineage column
 *
 * A revision link could be a foreign key the user maintains. It would be exact
 * and it would be empty, because nobody fills those in. The file name is the
 * lineage every office already keeps by hand, so reading it is the difference
 * between a timeline that exists and one that is always a single node. Where the
 * reading is wrong the cost is bounded — two series instead of one, both still
 * comparable through the normal compare panel — so this errs toward NOT merging:
 * only well-marked revision tokens are stripped.
 *
 * Pure: a function of the model headers the page already loaded.
 */

import type { BimModelHeaderView } from '../hooks/use-bim-model'

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

/** What changed between two revisions, read from their summaries. */
export interface BimRevisionDelta {
  /** The revision this is measured against. */
  previousFilename: string
  elements: number | null
  spaces: number | null
  storeys: number | null
  netFloorArea: number | null
  healthScore: number | null
}

export interface BimRevision {
  model: BimModelHeaderView
  /** 1-based position in the series, oldest first. */
  index: number
  isLatest: boolean
  /** `null` for the first revision, and whenever a summary is missing. */
  delta: BimRevisionDelta | null
}

export interface BimRevisionSeries {
  /** Lower-cased grouping key. */
  key: string
  /** The oldest revision's base name, as authored — what a person recognises. */
  label: string
  revisions: BimRevision[]
}

function metric(model: BimModelHeaderView): {
  elements: number | null
  spaces: number | null
  storeys: number | null
  netFloorArea: number | null
  healthScore: number | null
} {
  const summary = model.summary
  return {
    elements: summary?.totals.elements ?? null,
    spaces: summary?.totals.spaces ?? null,
    storeys: summary?.totals.storeys ?? null,
    netFloorArea: summary?.quantityTotals.netFloorAreaM2 ?? null,
    healthScore: summary?.health?.score ?? null,
  }
}

/** Subtract, keeping `null` when either side is unknown — never 0 by default. */
function difference(after: number | null, before: number | null): number | null {
  if (after === null || before === null) return null
  return Math.round((after - before) * 100) / 100
}

function computeDelta(
  current: BimModelHeaderView,
  previous: BimModelHeaderView
): BimRevisionDelta | null {
  // A revision that failed to parse has no numbers, and inventing zeros for it
  // would report "everything was deleted" for a file we simply could not read.
  if (!current.summary || !previous.summary) return null
  const now = metric(current)
  const before = metric(previous)
  return {
    previousFilename: previous.filename,
    elements: difference(now.elements, before.elements),
    spaces: difference(now.spaces, before.spaces),
    storeys: difference(now.storeys, before.storeys),
    netFloorArea: difference(now.netFloorArea, before.netFloorArea),
    healthScore: difference(now.healthScore, before.healthScore),
  }
}

/**
 * Group the project's models into revision series, oldest revision first.
 *
 * Series are returned with the most recently touched one first, because that is
 * the building being worked on.
 */
export function groupModelRevisions(
  models: readonly BimModelHeaderView[]
): BimRevisionSeries[] {
  const buckets = new Map<string, BimModelHeaderView[]>()
  for (const model of models) {
    const key = revisionSeriesKey(model.filename)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(model)
    else buckets.set(key, [model])
  }

  const series: BimRevisionSeries[] = []
  for (const [key, bucket] of buckets) {
    // Oldest first. Ties fall back to the file name so the order is the same on
    // every render — two files ingested in the same batch share a timestamp.
    const ordered = [...bucket].sort(
      (a, b) =>
        Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.filename.localeCompare(b.filename)
    )
    series.push({
      key,
      label: ordered[0].filename.replace(/\.(ifc|ifczip)$/i, ''),
      revisions: ordered.map((model, position) => ({
        model,
        index: position + 1,
        isLatest: position === ordered.length - 1,
        delta: position === 0 ? null : computeDelta(model, ordered[position - 1]),
      })),
    })
  }

  return series.sort((a, b) => {
    const latest = (entry: BimRevisionSeries): number =>
      Date.parse(entry.revisions[entry.revisions.length - 1].model.updatedAt)
    return latest(b) - latest(a) || a.label.localeCompare(b.label)
  })
}

/** The series a given model belongs to, or `null` when it is not in the list. */
export function findRevisionSeries(
  series: readonly BimRevisionSeries[],
  modelId: string | null
): BimRevisionSeries | null {
  if (!modelId) return null
  return (
    series.find((entry) => entry.revisions.some((revision) => revision.model.id === modelId)) ?? null
  )
}
