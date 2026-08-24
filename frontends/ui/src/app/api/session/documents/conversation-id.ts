/**
 * The shape of a conversation id, checked where a caller's string enters.
 *
 * Both session-document routes take `conversationId` from the request and hand
 * it, unexamined, to a database comparison (`documents.conversation_id = $1`,
 * the composite FK against `conversations`), to `createConversation` as a
 * PRIMARY KEY it may insert, and — through `sessionCollectionName` — to a
 * retrieval collection name that is pushed at the Python backend. A string that
 * arrived from outside should not reach three subsystems without anyone having
 * said what it is allowed to look like.
 *
 * ## Why NOT `z.string().uuid()`
 *
 * That was the suggested fix and it is the wrong one: it would reject every id
 * the application mints and break the feature outright. A conversation id is a
 * client-minted `s_<uuid-with-underscores>` string, not a UUID —
 *
 *   - `conversations.id` is `text` (`lib/db/schema/conversations.ts:16`),
 *   - `documents.conversation_id` is `text` (`lib/db/schema/documents.ts:69`),
 *
 * — and both are `text` DELIBERATELY, for exactly this reason; the migration
 * that added the column says so, and `job_runs.conversation_id` is `text` for
 * the same reason. `uuid()` here would not tighten the boundary, it would close
 * it. Recorded so nobody re-applies it.
 *
 * ## What the shape actually is
 *
 * Derived from the three places an id is minted, which all agree:
 *
 *   - `features/chat/stores/sessions-store.ts:231` — `s_${uuidv4().replace(/-/g, '_')}`
 *   - `features/chat/stores/messages-store.ts:369`  — same
 *   - `lib/jobs/service.ts:484`                     — `s_${randomUUID().replace(/-/g, '_')}`
 *
 * So: the literal `s_`, then a v4 UUID's 8-4-4-4-12 lowercase hex groups with
 * underscores where the hyphens were. Lowercase only, because that is what both
 * generators emit and because Postgres compares `text` case-sensitively — two
 * spellings of one id would be two different rows.
 *
 * The `s_` prefix is REQUIRED rather than tolerated. `sessionCollectionName`
 * accepts a bare id and prefixes it, which makes it a normaliser for callers
 * that already exist; at this boundary the id has to be one the app could have
 * minted, so the normaliser is the identity here and the collection name a
 * request can reach is pinned to the conversation it names.
 */

import { z } from 'zod'
import { BadRequestError } from '@/lib/api/errors'

/** `s_` + a v4 UUID with underscores for hyphens. See the module comment. */
export const CONVERSATION_ID_PATTERN =
  /^s_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$/

const CONVERSATION_ID_MESSAGE =
  'conversationId must be a conversation id (`s_` followed by a UUID with underscores)'

/**
 * For the query-string boundary, where `parseQuery` already turns a zod failure
 * into the repository's `BadRequestError` envelope.
 */
export const conversationIdSchema = z.string().regex(CONVERSATION_ID_PATTERN, CONVERSATION_ID_MESSAGE)

/**
 * For the multipart boundary, where there is no schema to parse against: a form
 * field is `string | File | null`, so the type check and the shape check are the
 * same rejection and are made in one place.
 */
export function parseConversationId(value: unknown): string {
  const parsed = conversationIdSchema.safeParse(value)
  if (!parsed.success) {
    throw new BadRequestError(CONVERSATION_ID_MESSAGE)
  }
  return parsed.data
}
