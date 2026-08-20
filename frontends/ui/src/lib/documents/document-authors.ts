/**
 * Who wrote a document's bytes, and what the record points at — the provenance
 * vocabulary, with no database attached.
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

/**
 * What KIND of identifier `documents.authored_by_ref` holds (migration 0066).
 *
 * The column used to be called `authored_by_run_id` and its comment said, in
 * the schema and in the catalog, "the backend async job id of the run". That
 * was true of the only producer there was. It stopped being true when there
 * were three: a diagram's reference is `{chat message id}-{hash of its
 * source}`, built in the browser so that one answer holding two diagrams files
 * two documents. A perfectly good identity — just not a job id, with nothing in
 * the row saying so.
 *
 *   - `agent_run` — a backend async job id, in the `aiq_api` job store.
 *   - `answer_artifact` — ONE artifact inside ONE chat answer.
 *
 * ## Two things this vocabulary is, at once
 *
 * It is the value of a column, and it is the **WorkOS audit target type** that
 * `document.generated` carries beside the document (`lib/audit/service.ts`
 * appends `{type: <this>, id: <the ref>}` for an agent actor). One vocabulary
 * rather than two because it answers one question — *what is this identifier* —
 * and a second list would be free to disagree with the first about a row that
 * has already been written. The cost is stated where it bites: a member added
 * here MUST also be registered among `document.generated`'s targets in
 * `lib/audit/schemas.mjs`, because WorkOS rejects an event carrying an
 * unregistered target type exactly as it rejects an unregistered action, and
 * this action's emit throws — so the rejection does not lose an audit line, it
 * unfiles the document the line was about. `schemas.spec.ts` fails when the two
 * drift, which is what keeps that sentence from being folklore.
 *
 * A tuple for the reason `DOCUMENT_AUTHORS` is one, and the column carries no
 * CHECK on its value: the next kind of reference is an entry here plus a
 * registration, never a migration held after production rows exist.
 *
 * Nothing chooses one of these at a call site. `GENERATED_DOCUMENT_PRODUCERS`
 * maps each producer to the kind it files under, and the one filing path reads
 * it from there — because a producer is a KIND OF DELIVERABLE and the kind of
 * identity a deliverable is filed under is a property of the deliverable, not a
 * decision its caller re-takes each time. That is what stops the column and its
 * meaning from drifting apart the way the column and its comment did.
 */
export const AUTHORED_REF_KINDS = ['agent_run', 'answer_artifact'] as const
export type AuthoredRefKind = (typeof AUTHORED_REF_KINDS)[number]
