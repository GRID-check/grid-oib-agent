/**
 * What both screening gates (ADR-0086) share about reading text the way a
 * person does: the characters that print as nothing, and how a long term still
 * matches when one space or hyphen splits it.
 *
 * The content screen (`./content-screen`) reads prose with these; the name gate
 * (`./name-screen`) reads file and folder names with them. One definition, so a
 * zero-width space or a `Gehalts-Abrechnung` gets past neither gate where it is
 * caught by the other. Python's `aiq_agent.common.content_screen` mirrors the
 * content side, held to it by the shared fixture.
 *
 * Pure and client-safe.
 */

/**
 * Characters that print as nothing and sit inside words in extracted text and
 * in names: the soft hyphen, the zero-width space, non-joiner and joiner, the
 * word joiner and the byte-order mark. A reading leaves them out.
 */
export const SCREENING_IGNORABLE = '\u00ad\u200b\u200c\u200d\u2060\ufeff'

const IGNORABLE_RUN = new RegExp(`[${SCREENING_IGNORABLE}]+`, 'g')

/** `text` without `SCREENING_IGNORABLE`. */
export function withoutIgnorables(text: string): string {
  return text.replace(IGNORABLE_RUN, '')
}

/** A single-word term this long (folded) still matches with one joiner inside it… */
export const SPLIT_TERM_MIN = 8
/** …where each part keeps at least this many characters. */
export const TERM_FRAGMENT = 3

/**
 * Where `word` ends when it stands at `start` in `text` with at most one of
 * `joiners` inside it; -1 when it does not. The joiner may split the word only
 * where each part keeps at least `TERM_FRAGMENT` characters, so
 * `Gehalts-abrechnung` is `Gehaltsabrechnung` and `Ge-haltsabrechnung` is not.
 */
export function splitTermEnd(text: string, start: number, word: string, joiners: string): number {
  let cursor = start
  let split = false
  for (let position = 0; position < word.length; position += 1) {
    const char = word[position]
    if (cursor < text.length && text[cursor] === char) {
      cursor += 1
      continue
    }
    const joined =
      cursor + 1 < text.length && joiners.includes(text[cursor]) && text[cursor + 1] === char
    const fits = position >= TERM_FRAGMENT && position <= word.length - TERM_FRAGMENT
    if (split || !joined || !fits) return -1
    split = true
    cursor += 2
  }
  return cursor
}
