/**
 * The request id's wire name and its human form.
 *
 * Isomorphic on purpose: the BFF writes the header (`lib/api/request-id`, which
 * also mints the id and is server-only because it reaches for `node:crypto`),
 * and the chat client reads it back out of a failed response and shows it. Both
 * ends need the same two facts, and a second copy of either is a fork —
 * a header name spelled differently on one side means the id silently stops
 * arriving, and a different truncation means the user reads out characters that
 * are not in the log.
 */

/** The header an id is read from and echoed on. */
export const REQUEST_ID_HEADER = 'x-request-id'

/**
 * How many leading characters a person is asked to read out.
 *
 * Eight hex characters is ~4·10⁹ values — far more than a deployment's logs
 * hold for any window somebody searches — and short enough to say over a phone.
 */
export const SHORT_REQUEST_ID_LENGTH = 8

/**
 * The form a person is shown and quotes.
 *
 * A literal PREFIX of the full id, never a digest of it: grepping what the user
 * read aloud has to find the line the full id is in.
 */
export function shortRequestId(requestId: string): string {
  return requestId.slice(0, SHORT_REQUEST_ID_LENGTH)
}
