/**
 * Escape a user-supplied string for use inside a SQL `LIKE` / `ILIKE`
 * pattern, so `%`, `_` and `\` match themselves instead of acting as
 * wildcards. Postgres's default escape character is the backslash, which is
 * what this prepends; the caller adds its own `%` around the result.
 *
 * Without it a search for `100%` matches everything and `a_b` matches `axb`.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1')
}
