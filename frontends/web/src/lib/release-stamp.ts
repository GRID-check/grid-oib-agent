import manifest from '../data/art.json'
import { art, artFile, type OnPageArtId } from './art'

import { getReleases } from './changelog'

/**
 * The riso stamp beside a changelog release: one of a fixed set of prints
 * (`art/riso/releases/`), each one construction step of the same house. The
 * stamps are handed out in publishing order, oldest release first, so reading
 * the changelog backwards in time the building comes apart, and forwards it
 * goes up: the page shows Piloti being built release by release. After the
 * last step the next release starts a new plot. A new release needs no new
 * export; it takes the next step.
 *
 * Adding a step shifts every release after the insertion point, so redraw in
 * place and append new steps at the end of the set.
 *
 * The files are the on-page variant (no paper, inks as alpha): a stamp sits
 * bare on the page, so show it with `mix-blend-multiply` and its inks print
 * into the page and its grid instead of standing on a beige square.
 */

const STAMPS = (Object.keys(manifest.art) as OnPageArtId[]).filter((id) => id.startsWith('releases/')).sort()

/** Release id → its position in publishing order, oldest = 0. */
const ORDER = new Map(
  getReleases()
    .slice()
    .reverse()
    .map((r, i) => [r.id, i])
)

export interface ReleaseStamp {
  src: string
  srcset: string
  width: number
  height: number
}

/** The stamp for a release id, or null when no stamps are exported or the id is unknown. */
export function releaseStamp(releaseId: string): ReleaseStamp | null {
  const position = ORDER.get(releaseId)
  if (STAMPS.length === 0 || position === undefined) return null
  const a = art(STAMPS[position % STAMPS.length], { onPage: true })
  const lo = artFile(a, 1)
  const hi = artFile(a, 2)
  return { src: lo.src, srcset: `${lo.src} 1x, ${hi.src} 2x`, width: a.width, height: a.height }
}
