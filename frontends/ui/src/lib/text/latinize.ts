/**
 * Turning German (and other accented) text into plain ASCII letters.
 *
 * Every surface that builds an id, an anchor or a filename out of a
 * human-written name needs this, and before this module existed each one had
 * grown its own copy: the Markdown heading anchors, the norms catalog id
 * editor, and the BCF download name. Three tables, and the third was written
 * from scratch while the first two sat in the tree. They also disagreed — the
 * BCF one had no table at all, so `Beispielstraße` downloaded as
 * `Beispielstra-e`.
 *
 * ## The two halves, and why they are separate functions
 *
 * They are not interchangeable, and a caller has to pick deliberately:
 *
 * - {@link transliterateGerman} spells `ä ö ü ß` the way a German speaker
 *   writes them when a form refuses the letter — `ae oe ue ss`. Unicode cannot
 *   do this: `ß` has NO decomposition at all, and NFKD would reduce `ü` to a
 *   bare `u`, which is the wrong word.
 * - {@link foldDiacritics} is the generic pass — NFKD, then drop the combining
 *   marks — so Czech, French and Hungarian names survive without a table each.
 *   It CHANGES existing output for any string containing an accent, which is
 *   why the Markdown anchors take the first and not the second: their ids are
 *   already published in links.
 *
 * {@link latinize} is both, in the only order that works.
 *
 * ## Who deliberately does not use this
 *
 * - `lib/storage/bucket.ts` — slugs an organization id from the identity
 *   provider, not a human name. It has no German in it, and a change in
 *   derivation would rename live buckets.
 * - `features/collaboration/components/MentionPicker.tsx` — its fold has to
 *   map index-for-index back onto the original string to place the highlight,
 *   so it cannot use NFKD, which expands `ﬁ` into two characters.
 * - `features/knowledge/lib/passage-highlight.ts` — a matching folder with its
 *   own documented reasoning about ligatures and hyphens; slugging and
 *   matching want different things from the same input.
 */

/**
 * The letters Unicode normalisation cannot spell for us.
 *
 * Uppercase forms are listed explicitly because the table runs before any
 * case-folding: a caller that preserves case (a filename) needs `Öbb` to
 * become `Oebb` rather than `OEbb` or `bb`.
 */
const GERMAN: ReadonlyArray<readonly [RegExp, string]> = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
  [/Ä/g, 'Ae'],
  [/Ö/g, 'Oe'],
  [/Ü/g, 'Ue'],
  [/ß/g, 'ss'],
  // Capital sharp S (U+1E9E). Rare, valid, and `SS` is its defined uppercase.
  [/ẞ/g, 'SS'],
]

/**
 * Latin letters that are not a base letter plus a mark, so NFKD cannot touch
 * them either.
 *
 * Same class of bug as `ß`, one alphabet over: a stroke through the letter (`Ø`
 * `Ł` `Đ`) and a true ligature (`Æ` `Œ`) are single code points with no
 * decomposition, so they survived to the caller's `[^A-Za-z0-9]` pass and
 * became hyphens. `Øresund Łódź` slugged to `resund-odz` and `Ærø` to a bare
 * `r`. Austrian offices do work in Scandinavia and Poland, and a filename that
 * eats the client's name is not a small thing.
 *
 * Handled here rather than in {@link transliterateGerman}: they are not German,
 * and the Markdown anchors — which take the German pass alone to keep published
 * ids stable — should not silently start renaming headings.
 */
const NON_DECOMPOSING_LATIN: ReadonlyArray<readonly [RegExp, string]> = [
  [/ø/g, 'oe'],
  [/Ø/g, 'Oe'],
  [/æ/g, 'ae'],
  [/Æ/g, 'Ae'],
  [/œ/g, 'oe'],
  [/Œ/g, 'Oe'],
  [/ł/g, 'l'],
  [/Ł/g, 'L'],
  [/đ/g, 'd'],
  [/Đ/g, 'D'],
  [/ð/g, 'd'],
  [/Ð/g, 'D'],
  [/þ/g, 'th'],
  [/Þ/g, 'Th'],
  [/ı/g, 'i'],
]

/**
 * Spell out the German letters, per DIN 5007-2 (the passport transliteration).
 *
 * Composes first: a name that arrived decomposed — `a` + U+0308, which is what
 * macOS filesystems hand over — carries no `ä` for the table to match, and
 * would silently fall through to whatever the caller does next.
 */
export function transliterateGerman(value: string): string {
  return GERMAN.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), value.normalize('NFC'))
}

/**
 * Drop every diacritic, whatever language put it there.
 *
 * NFKD so that compatibility forms (`ﬁ`, `½`, full-width Latin) reduce to
 * their plain letters too — a filename is one of the few places where losing
 * that distinction is the desired outcome.
 */
export function foldDiacritics(value: string): string {
  const spelled = NON_DECOMPOSING_LATIN.reduce(
    (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
    value
  )
  return spelled.normalize('NFKD').replace(/\p{M}/gu, '')
}

/**
 * German first, then everything else — the order matters.
 *
 * Folding first would have already reduced `ü` to `u`, leaving the German
 * table nothing to spell.
 */
export function latinize(value: string): string {
  return foldDiacritics(transliterateGerman(value))
}
