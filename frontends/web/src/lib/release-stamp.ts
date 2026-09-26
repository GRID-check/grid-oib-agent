import manifest from '../data/art.json'
import { art, artFile, type ArtId } from './art'

/**
 * The riso stamp beside a changelog release: one of a fixed set of prints
 * (`art/riso/releases/`, one building-site step each), picked by the release
 * id. A new release needs no new export, whatever its id looks like (a day, a
 * week, a tag): the id is hashed the way the riso engine seeds its streams,
 * FNV-1a into mulberry32 (`rngFor` in `art/riso/lib/engine.js`), so the pick
 * is stable per id and spread evenly over the set.
 *
 * Adding or removing a step changes the set's size and so reshuffles which
 * release wears which stamp. That is harmless (the stamps carry no meaning
 * tied to one release), but keep the set's size when you only redraw.
 */

const STAMPS = (Object.keys(manifest.art) as ArtId[]).filter((id) => id.startsWith('releases/')).sort()

function fnv1a(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** The first draw of mulberry32 seeded with `seed`, in [0, 1). */
function mulberry32(seed: number): number {
  const a = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export interface ReleaseStamp {
  src: string
  srcset: string
  width: number
  height: number
}

/** The stamp for a release id, or null when no stamps are exported. */
export function releaseStamp(releaseId: string): ReleaseStamp | null {
  if (STAMPS.length === 0) return null
  const a = art(STAMPS[Math.floor(mulberry32(fnv1a(`release:${releaseId}`)) * STAMPS.length)])
  const lo = artFile(a, 1)
  const hi = artFile(a, 2)
  return { src: lo.src, srcset: `${lo.src} 1x, ${hi.src} 2x`, width: a.width, height: a.height }
}
