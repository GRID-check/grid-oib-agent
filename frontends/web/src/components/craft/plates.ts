/**
 * The riso plates of the Tafeln series by number, as art ids.
 *
 * Files, sizes, alt text and captions live in `src/data/art.json`, which
 * `art/riso/export.mjs` generates (see `src/lib/art.ts`). Pages name a plate
 * here or by its id, never by file path.
 */
import type { ArtId } from '../../lib/art'

export const PLATES = {
  /** Drei Stützen / Three columns: the Team section. */
  I: 'tafeln/stuetzen/plate',
  /** Schichten / Layers: the post on how Piloti works. */
  II: 'tafeln/schichten/plate',
  /** Schleife / Loop: the post on learning from corrections. */
  III: 'tafeln/schleife/plate',
  /** Bauplatz / Building plot: the 404 page. */
  IV: 'tafeln/bauplatz/plate',
  /** Prüfstand / Test bench: data and transparency. */
  V: 'tafeln/pruefstand/plate',
  /** Zeichentisch / Drafting table: how Piloti is used. */
  VI: 'tafeln/zeichentisch/plate',
  /** Waage / Balance: the value calculator. */
  VII: 'tafeln/waage/plate',
  /** Offene Tür / Open door: contact, become a pilot office. */
  VIII: 'tafeln/tuer/plate',
} as const satisfies Record<string, ArtId>

export type PlateName = (typeof PLATES)[keyof typeof PLATES]

/** Blog posts (by slug, both locales) that wear a plate as their cover. */
export const POST_PLATES: Record<string, PlateName | undefined> = {
  'wie-piloti-funktioniert': PLATES.II,
  'how-piloti-works': PLATES.II,
}
