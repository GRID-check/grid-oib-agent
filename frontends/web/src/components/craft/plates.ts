/**
 * The riso plates of the Tafeln series by number, as art ids.
 *
 * Files, sizes, alt text and captions live in `src/data/art.json`, which
 * `art/riso/export.mjs` generates (see `src/lib/art.ts`). Pages name a plate
 * here or by its id, never by file path.
 */
import type { ArtId, OnPageArtId } from '../../lib/art'

export const PLATES = {
  /** Drei Stützen / Three columns: kept for the banner and share cards; Team now wears Tragwerk II. */
  I: 'tafeln/stuetzen/plate',
  /** Schichten / Layers: the sources section, on the page, and the post on how Piloti works. */
  II: 'tafeln/schichten/plate',
  /** Schleife / Loop: the post on learning from corrections. */
  III: 'tafeln/schleife/plate',
  /** Bauplatz / Building plot: the changelog's share card (the 404 wears Tragwerk IV). */
  IV: 'tafeln/bauplatz/plate',
  /** Prüfstand / Test bench: for the blog. */
  V: 'tafeln/pruefstand/plate',
  /** Zeichentisch / Drafting table: how Piloti is used. */
  VI: 'tafeln/zeichentisch/plate',
  /** Waage / Balance: the value calculator. */
  VII: 'tafeln/waage/plate',
  /** Offene Tür / Open door: contact, become a pilot office. */
  VIII: 'tafeln/tuer/plate',
} as const satisfies Record<string, OnPageArtId>

/**
 * The Tragwerk series (art/riso/tragwerk): the Piloti column, a brand staple,
 * by number. II is the Team's taped print (three columns, three founders, one
 * slab), IV the 404's; I wears the landing share card, III the Journal's.
 */
export const TRAGWERK = {
  /** Säule / Column: the landing page's share card (its og). */
  I: 'tragwerk/saeule/plate',
  /** Drei Säulen / Three columns: the Team section, taped beside the founder photos. */
  II: 'tragwerk/drei/plate',
  /** Säulenordnung / The orders. */
  III: 'tragwerk/ordnung/plate',
  /** Ziegelpfeiler / Brick pier: the 404 page. */
  IV: 'tragwerk/ziegel/plate',
} as const satisfies Record<string, OnPageArtId>

export type PlateName = (typeof PLATES)[keyof typeof PLATES] | (typeof TRAGWERK)[keyof typeof TRAGWERK]

type CoverArtId = Extract<OnPageArtId, `${string}/cover`>
type OgArtId = Extract<ArtId, `${string}/og`>

/**
 * The plates a blog post can wear, by the value of its `plate` frontmatter
 * field: the cover on the post, its card and its log entry, and the share
 * card in the same drawing. Only plates exported in both formats are listed,
 * so a post cannot pick one that would leave its share card on the default.
 *
 * The content schema (`content.config.ts`), the Keystatic select and
 * `scripts/lint-content.mjs` all read `COVER_PLATE_IDS`; `satisfies` makes
 * `astro check` refuse an id the manifest does not have.
 */
export const COVER_PLATES = {
  schichten: {
    label: 'II · Schichten',
    cover: 'tafeln/schichten/cover',
    og: 'tafeln/schichten/og',
  },
  schleife: {
    label: 'III · Schleife',
    cover: 'tafeln/schleife/cover',
    og: 'tafeln/schleife/og',
  },
  tuer: {
    label: 'VIII · Offene Tür',
    cover: 'tafeln/tuer/cover',
    og: 'tafeln/tuer/og',
  },
} as const satisfies Record<string, { label: string; cover: CoverArtId; og: OgArtId }>

export type CoverPlate = keyof typeof COVER_PLATES
export const COVER_PLATE_IDS = Object.keys(COVER_PLATES) as [CoverPlate, ...CoverPlate[]]
