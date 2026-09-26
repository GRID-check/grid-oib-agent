/**
 * A GFM delimiter row: every cell only dashes, optionally between colons
 * (`| :--- | ---: |`). Cell by cell rather than by a prefix: `| -3 |`, a data
 * row holding a negative number, started like one and let a header-only table
 * through half-parsed.
 *
 * Split on the pipe, then one anchored pattern per cell with no two
 * quantifiers over the same characters: this runs on every token, over lines a
 * model copies out of retrieved documents, and an earlier `\s*` either side of
 * an optional pipe backtracked quadratically on a line of whitespace (32k tabs,
 * 1,034 ms).
 */
export function isDelimiterRow(line: string): boolean {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  if (!inner.includes('-')) return false
  return inner.split('|').every((cell) => /^\s*:?-+:?\s*$/.test(cell))
}

