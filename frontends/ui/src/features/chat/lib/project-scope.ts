import { CONVERSATION_SCOPES, type ConversationScope } from '@/lib/conversations/scopes'

/**
 * Project-scoping rule for chat sessions (UX-8: cross-project bleed).
 *
 * A session stamped with a `projectId` belongs to exactly that project and
 * must only surface in that project's chat context — listing, selecting, or
 * bulk-deleting it from another project's chat would retrieve against the
 * wrong corpus and break the "retrieval scoped to the selected workspace"
 * promise.
 *
 * Sessions WITHOUT a `projectId` (legacy local sessions and server rows
 * created before project stamping) deliberately fail OPEN: they remain
 * visible in every project context so users never lose sight of their
 * history. The same rule drives the sessions panel, selection/URL-restore
 * guards, and the project-scoped "delete all" — delete-all removes exactly
 * what the panel shows in the current context, and never a session stamped
 * with a different project.
 */
export function conversationMatchesProject(
  conversation: { projectId?: string | null },
  activeProjectId: string | null | undefined,
): boolean {
  // No active project context: nothing to scope by, show everything.
  if (!activeProjectId) return true
  // Unscoped legacy session: visible everywhere (fail-open).
  if (!conversation.projectId) return true
  return conversation.projectId === activeProjectId
}

/**
 * Which of the two chat surfaces a conversation belongs to (ADR-0054): a
 * project chat, or the organization-level Büro at `/app/chat`.
 *
 * Re-exported from the BFF's own vocabulary rather than declared again here.
 * That module is pure data for exactly this reason — the column, the route's
 * request schema and this store all have to mean the same two words, and a
 * second copy would look locally correct while drifting.
 */
export type { ConversationScope }

/**
 * Read a scope off a server row, which types it as a plain string (and, before
 * the column existed, does not carry it at all).
 *
 * The boundary parse: everything downstream trusts {@link ConversationScope}.
 * An unrecognised value returns null — the caller decides what an unknown scope
 * means, and in the Büro that decision is "do not show it" (WS-9).
 */
export function normalizeConversationScope(value: unknown): ConversationScope | null {
  return CONVERSATION_SCOPES.find((scope) => scope === value) ?? null
}

/**
 * The scope declared by a server row, or null when it declares none.
 *
 * Takes the row rather than the field so the call site needs no cast: the BFF
 * types the column as a plain string, and a row from a deployment that predates
 * the column has no such property at all — both satisfy `{ scope?: unknown }`.
 */
export function conversationScopeFromRow(row: { scope?: unknown }): ConversationScope | null {
  return normalizeConversationScope(row.scope)
}

/**
 * The scope a conversation belongs to, inferred when the row does not say.
 *
 * A row that predates `conversations.scope` (migration 0081) says nothing, and
 * the only honest reading of it is the one the backfill made: a row with a
 * project is a project chat, a row without one is a workspace chat.
 */
export function conversationScope(conversation: {
  projectId?: string | null
  scope?: ConversationScope | null
}): ConversationScope {
  return conversation.scope ?? (conversation.projectId ? 'project' : 'workspace')
}

/**
 * The scoping rule for BOTH surfaces — what the sessions panel lists, what
 * `selectConversation` will activate, and what "delete all" removes.
 *
 * In the Büro it is strict and it does NOT fail open (WS-9). The fail-open rule
 * above exists so a legacy session without a project stays visible in every
 * project; applied to the Büro it would put every project's unscoped history
 * into the office, and — worse, in the other direction — put every workspace
 * conversation into every project's panel, which is the bleed UX-8 was about.
 *
 * In a project the fail-open stays for rows that say nothing — tightening it
 * there would hide history that has been visible for a year — but a row that
 * DECLARES itself a workspace chat is hidden. Without that second half the
 * bleed runs the other way: the store persists across navigations, so one visit
 * to the Büro would leave its threads in every project's panel afterwards, and
 * WS-9 forbids a project-less conversation matching a project at all.
 */
export function conversationMatchesScope(
  conversation: { projectId?: string | null; scope?: ConversationScope | null },
  active: { projectId: string | null | undefined; scope: ConversationScope },
): boolean {
  if (active.scope === 'workspace') return conversationScope(conversation) === 'workspace'
  if (conversation.scope === 'workspace') return false
  return conversationMatchesProject(conversation, active.projectId)
}

/**
 * A conversation a JOB produced (`conversations.job_id`, migration 0044) rather
 * than one a person started by typing.
 *
 * These are kept out of the personal sessions list, and the reason is arithmetic:
 * the list is filtered to `c.userId === currentUserId`, so a job conversation —
 * owned by the job's owner, because `created_by` must be a real person for the
 * roster, the last-owner invariant and audit to work — would appear in exactly
 * ONE person's history, that owner's, and nowhere else. A weekly job puts 52
 * threads a year there, on top of the chats they actually had, and none of them
 * is a chat they will recognise having started.
 *
 * Hiding, not withholding. Job conversations stay in the store and stay fully
 * reachable: `?session=<id>` selects one, the job's run history links straight
 * to it, and everyone with `project:view` can open it because it is created
 * `visibility: 'project'`. The only thing this rule denies them is a slot in a
 * list of "chats I started", which they are not.
 */
export function isJobConversation(conversation: { jobId?: string | null }): boolean {
  return Boolean(conversation.jobId)
}
