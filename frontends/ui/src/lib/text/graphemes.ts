/**
 * Cutting and cleaning text that somebody else wrote and a person will read:
 * a mail subject, a sender's display name, an attachment's filename.
 *
 * Two rules, both about what a reader sees rather than what the string holds:
 *
 *   - **Invisible format characters go.** Unicode category Cf holds the bidi
 *     overrides and isolates (U+202A–U+202E, U+2066–U+2069), zero-width
 *     spaces and joiners, and the byte-order mark. `Rechnung‮fdp.exe`
 *     renders as `Rechnungexe.pdf`; nobody who sends a real file needs one.
 *   - **Cuts fall between graphemes.** `slice` counts UTF-16 units, so a cut
 *     can split a surrogate pair (a lone surrogate is not valid UTF-8 and
 *     breaks storage keys) or a family emoji into its parts.
 */

const FORMAT_CONTROLS = /\p{Cf}/gu

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The text without Unicode format (Cf) characters. */
export function stripFormatControls(value: string): string {
  return value.replace(FORMAT_CONTROLS, '')
}

/**
 * The longest prefix of whole graphemes whose UTF-16 length, with `ellipsis`
 * appended when anything was cut, is at most `maxLength`. UTF-16 length is the
 * measure because it is what `String.length` validators check.
 */
export function truncateGraphemes(value: string, maxLength: number, ellipsis = ''): string {
  if (value.length <= maxLength) return value
  const budget = maxLength - ellipsis.length
  let kept = ''
  for (const { segment } of segmenter.segment(value)) {
    if (kept.length + segment.length > budget) break
    kept += segment
  }
  return kept + ellipsis
}
