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
