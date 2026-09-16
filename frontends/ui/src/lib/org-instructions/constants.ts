/**
 * The organization instruction block's shared constants.
 *
 * Deliberately free of `server-only`, of drizzle and of every other server
 * import, because this module is reached from THREE sides: the SQL-backed
 * schema declaration, the service's zod boundary, and the client-side editor
 * that counts characters as somebody types. A counter reading a second copy of
 * the number is a counter that will one day be wrong by exactly the amount that
 * matters, so the number is written once, here, at the bottom of the import
 * graph where everything can reach it.
 */

/**
 * The bound on one organization's instruction block, in characters.
 *
 * The same number the backend caps at (contract) and the same number the
 * `organization_instructions_length` CHECK enforces (0087). Characters, not
 * bytes: the editor counts down from this, and an umlaut must not cost two.
 */
export const ORG_INSTRUCTIONS_MAX_CHARS = 1500

/** The header the BFF sends on every turn: base64url(utf-8 text). */
export const ORG_INSTRUCTIONS_HEADER = 'X-Grid-Org-Instructions'
