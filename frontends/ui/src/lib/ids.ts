/**
 * Identifiers that Postgres stores as `uuid`.
 *
 * A value that is not this shape must not be bound to a uuid column: the
 * driver sends it as text and Postgres throws `invalid input syntax for type
 * uuid`, which the route factory used to turn into a 500. Issue #572 was a
 * filename in `/api/documents/[id]/status`.
 *
 * The check is the eight-four-four-four-twelve hex groups Postgres itself
 * accepts, not RFC-4122's version/variant bits — `gen_random_uuid()` is v4
 * here, but a nil id or a v1 would still be a well-formed column value.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID.test(value)
}
