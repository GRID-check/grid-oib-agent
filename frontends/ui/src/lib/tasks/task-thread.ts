/**
 * The conversation a standing task owns (ADR-0051, ADR-0062).
 *
 * A definition that keeps running — a weekly Wochencheck, a „Jetzt ausführen"
 * anybody can press again — owns ONE thread, and every fire appends its run
 * message to it. Before this, each fire minted a fresh conversation, so a weekly
 * definition deposited 52 threads a year that nobody read twice.
 *
 * ## Why the id is derived and not stored
 *
 * „One thread per definition" is an invariant, and the honest place for it is a
 * unique index on `conversations(job_id)`. That index **cannot be created on
 * live data**: every fire before this change stamped its own conversation with
 * the same `job_id`, so the deployments that use scheduled work are exactly the
 * ones where it would fail, and clearing the duplicates' `job_id` would delete
 * the provenance that column exists for (migration `0091_run_messages.sql`
 * carries the full record).
 *
 * So the invariant is held UPSTREAM: the thread's id is derived from the
 * definition's id, which makes `conversations`' own primary key the uniqueness
 * constraint and `ON CONFLICT DO NOTHING` the whole of „ensure the thread".
 * Two concurrent fires converge on one row, no backfill is needed, and the old
 * per-fire threads keep their `job_id` and stay openable.
 *
 * ## The namespace
 *
 * uuid5 over `NAMESPACE_URL`, the same construction `runMessageId`
 * (`lib/runs/service.ts`) and `conversation_output._message_id` use for a run's
 * message, with its own prefix so the two id spaces cannot collide. The prefix
 * is part of the contract: changing it orphans every standing thread in every
 * deployment, because nothing points at them but this function.
 *
 * No `server-only` and no drizzle, deliberately: the sessions panel runs this in
 * the browser to tell a standing task's thread from the per-fire conversations
 * it still hides.
 */

import { v5 as uuidv5 } from 'uuid'

/** The conversation id a definition's runs land in. Pure and deterministic. */
export function taskThreadConversationId(definitionId: string): string {
  // The app's conversation id shape: `s_` + a uuid with hyphens as underscores.
  // It doubles as the session's Qdrant collection name, so a definition's thread
  // must be spelled exactly the way an interactive one is.
  return `s_${uuidv5(`grid:task-thread:${definitionId}`, uuidv5.URL).replace(/-/g, '_')}`
}

/**
 * Whether a conversation IS a standing task's own thread, rather than one of
 * the per-fire conversations that predate this design.
 *
 * Both carry a `job_id`; only the standing thread's id is the derived one. That
 * is the whole test, and it needs no query — which is why the sessions panel can
 * apply it to rows it already holds.
 */
export function isTaskThread(conversation: { id?: string | null; jobId?: string | null }): boolean {
  if (!conversation.jobId || !conversation.id) return false
  return conversation.id === taskThreadConversationId(conversation.jobId)
}
