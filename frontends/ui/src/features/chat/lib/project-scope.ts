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
