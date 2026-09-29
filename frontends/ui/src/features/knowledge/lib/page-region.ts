/**
 * Where on a page a cited passage sits, when the passage was read off a PICTURE
 * of the page rather than out of its text (issue #433).
 *
 * A running-text citation carries its words, and the viewer finds them in the
 * page's text layer. A plan does not: what retrieval read was the vision
 * model's description of a depiction on the sheet — a Grundriss, a Schnitt —
 * and none of those words are on the page. What the backend can say instead is
 * where that depiction sits, as the box the analysis drew around it. That box
 * is the model's approximation of one depiction, not a measurement and not the
 * single object a question named.
 *
 * `box` is `[x0, y0, x1, y1]`, normalised 0-1 over the page as the viewer shows
 * it, top-left origin: a whole rendered PDF page or a whole uploaded image. The
 * backend only states a box for those two frames, so the viewer draws it as
 * percentages of the page box and needs no geometry of its own; zoom, device
 * pixel ratio and page rotation are all already in the page box.
 */
export interface PageRegion {
  box: [number, number, number, number]
  /** The depiction's title as read off the sheet ("Grundriss 1. OG"), when it had one. */
  label?: string
}

/** Boxes one source may carry, mirroring the backend's `_MAX_REGIONS_PER_SOURCE`. */
export const MAX_PAGE_REGIONS = 6

const isUnit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** One untrusted value as a region, or `undefined` when it is not a drawable box. */
const asPageRegion = (value: unknown): PageRegion | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const { box, label } = value as { box?: unknown; label?: unknown }
  if (!Array.isArray(box) || box.length !== 4 || !box.every(isUnit)) return undefined
  const [x0, y0, x1, y1] = box as [number, number, number, number]
  if (x1 <= x0 || y1 <= y0) return undefined
  const text = typeof label === 'string' ? label.trim() : ''
  return { box: [x0, y0, x1, y1], ...(text ? { label: text } : {}) }
}

/**
 * The drawable regions in an untrusted value: the live wire, a stored message,
 * a legacy localStorage row. A malformed entry is dropped rather than repaired,
 * because a box in the wrong place points the reader at the wrong drawing with
 * the same confidence as a right one. `undefined` when none survive, so a
 * source without regions stays indistinguishable from one sent before they
 * existed.
 */
export const parsePageRegions = (value: unknown): PageRegion[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const regions = value.flatMap((item) => {
    const region = asPageRegion(item)
    return region ? [region] : []
  })
  return regions.length ? regions.slice(0, MAX_PAGE_REGIONS) : undefined
}

/** Two region lists as one, repeats dropped and the cap held — how one page's chunks fold together. */
export const mergePageRegions = (
  current: PageRegion[] | undefined,
  incoming: PageRegion[] | undefined,
): PageRegion[] | undefined => {
  if (!incoming?.length) return current
  const merged = [...(current ?? [])]
  for (const region of incoming) {
    if (merged.length >= MAX_PAGE_REGIONS) break
    if (!merged.some((known) => known.box.every((value, index) => value === region.box[index]))) {
      merged.push(region)
    }
  }
  return merged.length ? merged : undefined
}
