/**
 * Which deep-research state the composer is looking at.
 *
 * This lived in `InputArea`'s render function as three near-identical
 * `useChatStore` message scans plus three derived booleans. Two things were
 * wrong with that, and they are the same fault seen from different sides.
 *
 * The first is structural: it is logic, so it belongs in a module with its own
 * fast spec (AGENTS.md, "fix causes, not symptoms" — `layout/lib/` is the
 * established home). Asserting on the lock rule through a mounted React tree
 * costs ~170ms a case; the same assertion here costs ~1ms.
 *
 * The second is a defect that the first one hid. The inline scans asked
 * "did ANY message ever report status X", while the rest of the codebase —
 * `chat/lib/session-activity`, used by the session store, the busy hook, the
 * storage manager and `MainLayout` — asks about the LATEST research job.
 * The two disagree exactly when a session runs research twice, and the
 * disagreement is user-visible: a run that FAILED after an earlier one
 * succeeded left `hasSuccessfulDeepResearch` true, so the composer locked
 * itself with "Research completed. Create a new session." over a session whose
 * report never arrived. UX-12 requires the opposite — a failed or interrupted
 * run has no report to protect, so the user must be able to retry in place.
 *
 * Deriving from the latest job (via the shared scan) fixes that by
 * construction rather than by adding a fourth boolean to out-rank the others.
 */

import type { DeepResearchJobStatus } from '@/features/chat/types'

/** Non-terminal statuses: the server still has work in flight. */
const ACTIVE_STATUSES: readonly DeepResearchJobStatus[] = ['submitted', 'running']

/** Terminal statuses that produced no report. */
const FAILED_STATUSES: readonly DeepResearchJobStatus[] = ['failure', 'interrupted']

export interface ResearchSessionInput {
  /**
   * Status of the conversation's most recent deep research job, from
   * `latestDeepResearchJobStatus`. Persisted, so it survives a reload or a
   * session switch — which is the half of the state the ephemeral fields below
   * lose.
   */
  latestJobStatus: DeepResearchJobStatus | null
  /** Ephemeral status of the run this tab is streaming, if any. */
  ephemeralStatus: DeepResearchJobStatus | null
  /** Whether a deep research stream is live in this tab. */
  isStreaming: boolean
  /** Conversation the live stream belongs to. */
  streamOwnerConversationId: string | null
  /** The conversation the composer is currently attached to. */
  conversationId: string | undefined
}

export interface ResearchSessionState {
  /**
   * A finished run produced a report. The ONLY state that locks the composer:
   * the report defines the session's context, so follow-ups belong in a fresh
   * session.
   */
  isSuccessful: boolean
  /**
   * A terminal failure/interruption not superseded by a success. Drives the
   * contextual placeholder while leaving the composer usable (UX-12).
   */
  isFailed: boolean
  /** A run is still going, either in this tab or per persisted state. */
  isInProgress: boolean
}

export function researchSessionState({
  latestJobStatus,
  ephemeralStatus,
  isStreaming,
  streamOwnerConversationId,
  conversationId,
}: ResearchSessionInput): ResearchSessionState {
  // While a stream is live the run has not finished, so the ephemeral field
  // says nothing about the outcome yet.
  const settled = isStreaming ? null : ephemeralStatus

  const isSuccessful = settled === 'success' || latestJobStatus === 'success'

  // Success out-ranks failure: a session that ends with a report is a completed
  // session whatever happened on the way there.
  const isFailed =
    !isSuccessful &&
    ((settled !== null && FAILED_STATUSES.includes(settled)) ||
      (latestJobStatus !== null && FAILED_STATUSES.includes(latestJobStatus)))

  const isInProgress =
    (isStreaming && streamOwnerConversationId === conversationId) ||
    (latestJobStatus !== null && ACTIVE_STATUSES.includes(latestJobStatus))

  return { isSuccessful, isFailed, isInProgress }
}
