/**
 * Initials for the projects-list row tile.
 *
 * The tile exists to give a long list a scannable left edge — something the eye
 * can index rows by while reading names. It is a display detail with a
 * surprising number of edge cases (umlauts, leading digits, punctuation-only
 * names, a name that is one long word), so it lives here with its own fast spec
 * rather than as an inline `split(' ')` in the row component.
 */

/** Word characters, including the German set the project names are full of. */
const WORD = /[\p{L}\p{N}]+/gu

/**
 * Up to two uppercase characters taken from the start of the first two words.
 * Falls back to the first two characters of a single word, and to `·` when the
 * name carries no letters or digits at all (never an empty tile).
 */
export function projectInitials(name: string): string {
  const words = name.match(WORD)
  if (!words || words.length === 0) return '·'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}
