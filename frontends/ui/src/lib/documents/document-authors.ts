/**
 * Who wrote a document's bytes — the vocabulary, with no database attached.
 *
 * The tuple is declared here rather than in `db/schema/documents.ts` because a
 * route handler needs it to validate a query parameter, and importing it from
 * the schema drags drizzle — and with it the database — into the transport
 * layer. `server-component-db-access.spec.ts` fails on exactly that, and it is
 * right to: a route that can reach the schema module is one refactor away from
 * querying in the handler.
 *
 * So the dependency points the other way. This module is pure data, the schema
 * imports it, and `@/lib/db/schema` re-exports it so every existing caller is
 * unchanged. Same arrangement, and the same reason, as `document-status.ts`.
 *
 * `user` and `agent` are the members that exist today. The column carries no
 * CHECK on its value (migration 0063), so a later `system` or `import` is an
 * addition here — which is anticipation, not a promise: nothing writes either
 * value, and neither should be treated as existing until something does.
 */

export const DOCUMENT_AUTHORS = ['user', 'agent'] as const
export type DocumentAuthor = (typeof DOCUMENT_AUTHORS)[number]
