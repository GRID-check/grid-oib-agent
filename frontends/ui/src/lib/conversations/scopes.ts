/**
 * Which level of the knowledge hierarchy a conversation belongs to — the
 * vocabulary, with no database attached (ADR-0054).
 *
 * The tuple is declared here rather than in `db/schema/conversations.ts` for
 * the reason `documents/document-authors.ts` gives at length: a route handler
 * needs it to validate a request body, and importing it from the schema drags
 * drizzle — and with it the database — into the transport layer, which
 * `server-component-db-access.spec.ts` fails on and is right to. So the
 * dependency points the other way: this module is pure data, the schema imports
 * it, and `@/lib/db/schema` re-exports it so every existing caller is unchanged.
 *
 *   - `project`   — the chat inside one project. The default, and every row
 *                   that predates migration 0081 with a `project_id`.
 *   - `workspace` — the Büro-Chat: it belongs to the ORGANISATION, has no
 *                   project, and reads the base corpus, the Archiv and
 *                   organisation memory (spec WS-7, KH-3).
 *
 * Unlike `DOCUMENT_SCOPES`, this vocabulary IS closed by a CHECK constraint
 * (migration 0081), so adding a member is a migration rather than an edit here.
 * That is deliberate: document shelves are open-ended by design, while these
 * two are the levels of a hierarchy, each with a surface behind it.
 */
export const CONVERSATION_SCOPES = ['project', 'workspace'] as const
export type ConversationScope = (typeof CONVERSATION_SCOPES)[number]
