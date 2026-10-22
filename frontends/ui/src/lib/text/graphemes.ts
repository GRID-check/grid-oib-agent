/**
 * Cutting and cleaning text that somebody else wrote and a person will read:
 * a mail's subject, a sender's display name, an attachment's filename.
 *
 * Three rules, each about what a reader sees rather than what the string holds:
 *
 * - **Invisible format characters go.** Unicode category Cf holds the bidi
 *   overrides and isolates (U+202A–U+202E, U+2066–U+2069), the zero-width
 *   spaces and joiners, the soft hyphen and the byte-order mark.
 *   `Rechnung\u202Efdp.exe` renders as `Rechnungexe.pdf`; nobody who sends a
 *   real file needs one. The price is that a zero-width joiner inside an emoji
 *   sequence goes too, and a family emoji shows as its members.
 * - **A line is one line.** Control characters (Cc: CR, LF, NUL, the C1 range)
 *   become spaces and runs of whitespace one space, so a CRLF smuggled into a
 *   filename or a subject cannot start a new line in a list, a log or a
 *   Markdown heading.
 * - **Cuts fall between graphemes.** `slice` counts UTF-16 units, so a cut can
 *   split a surrogate pair (a lone surrogate is not valid UTF-8 and breaks
 *   storage keys) or a family emoji into its parts.
 *
 * Pure; `Intl.Segmenter` is the only dependency, and it ships with Node and
 * every browser we support.
 */

const FORMAT_CONTROLS = /\p{Cf}/gu

const CONTROLS = /\p{Cc}/gu

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The text without Unicode format (Cf) characters. */
export function stripFormatControls(value: string): string {
  return value.replace(FORMAT_CONTROLS, '')
}

/**
 * One line of foreign text, fit to show: format characters removed, control
 * characters and every run of whitespace (line and paragraph separators
 * included) collapsed to one space, trimmed.
 */
export function singleLine(value: string): string {
  return stripFormatControls(value).replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * The longest prefix of whole graphemes whose UTF-16 length, with `ellipsis`
 * appended when anything was cut, is at most `maxLength`. UTF-16 length is the
 * measure because it is what `String.length` validators and zod's `.max()`
 * check. Text that fits comes back unchanged and unsegmented.
 */
export function truncateGraphemes(value: string, maxLength: number, ellipsis = ''): string {
  if (value.length <= maxLength) return value
  const budget = maxLength - ellipsis.length
  if (budget <= 0) return ''
  let kept = ''
  for (const { segment } of segmenter.segment(value)) {
    if (kept.length + segment.length > budget) break
    kept += segment
  }
  return kept + ellipsis
}
