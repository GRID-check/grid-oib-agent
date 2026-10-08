/**
 * User text inside a SQL `LIKE` / `ILIKE` pattern.
 *
 * `%` and `_` are wildcards to Postgres and ordinary characters to the person
 * who typed them. Unescaped, a search for `100%` matches everything starting
 * with `100`, and `WC_1` also matches `WC-1`, `WC 1` and `WCx1`; IFC names and
 * norm citations are full of underscores, so this is the common case rather than
 * the adversarial one. Postgres's default escape character is the backslash, so
 * no `ESCAPE` clause is needed. The backslash is escaped first, or it would
 * escape the escapes.
 */

/** `value` with every LIKE metacharacter (`\`, `%`, `_`) made literal. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/** A literal substring match: `%<escaped value>%`. */
export function likeContains(value: string): string {
  return `%${escapeLikePattern(value)}%`
}
