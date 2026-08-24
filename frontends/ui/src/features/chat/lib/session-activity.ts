/**
 * Session Activity Utilities
 *
 * Pure functions to derive session activity state from PERSISTED data.
 * These survive page refresh because they read from localStorage-backed
 * conversation message history rather than ephemeral store fields.
 *
 * Used by:
 * - useIsCurrentSessionBusy hook (current session check)
 * - isSessionBusy store method (per-session check)
 * - hasAnyBusySession store method (global check)
 */

import type { ChatMessage, DeepResearchJobStatus } from '../types'

/** Non-terminal deep research statuses that indicate an active server-side job */
const ACTIVE_JOB_STATUSES: readonly DeepResearchJobStatus[] = ['submitted', 'running']

/**
 * True when the user has never sent a typed chat message in this session.
 * Non-user message types (status, agent_response, etc.) do not count.
 */
export const hasNoUserChatMessages = (messages: ChatMessage[]): boolean =>
  !messages.some((message) => message.messageType === 'user')

/**
 * The conversation's most recent deep research job message, or `null`.
 *
 * Scans in reverse, so it is O(1) in practice — job messages sit at the end.
 * Exported because "the latest research job" is the unit nearly every consumer
 * reasons about; `deep-research-store` kept a byte-identical private copy until
 * the two were merged here.
 */
export const getLatestDeepResearchMessage = (messages: ChatMessage[]): ChatMessage | null => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.messageType === 'agent_response' && message.deepResearchJobId) {
      return message
    }
  }
  return null
}

/**
 * The status of the conversation's MOST RECENT deep research job, or `null` when
 * it has never run one.
 *
 * The latest job is what describes the session: a run that failed after an
 * earlier one succeeded leaves a session with no usable report, and an
 * "any message ever succeeded" scan would report the opposite. Exported so
 * consumers that need more than the active/complete booleans below (the
 * composer's lock, `layout/lib/research-session-state`) share this one scan
 * rather than re-deriving it from the message list.
 */
export const latestDeepResearchJobStatus = (
  messages: ChatMessage[]
): DeepResearchJobStatus | null => getLatestDeepResearchMessage(messages)?.deepResearchJobStatus ?? null

/**
 * Check if a conversation has an in-progress deep research job in its message history.
 *
 * Scans messages in reverse (most recent first) to find the latest agent_response
 * with a deep research job. Returns true if that job is in a non-terminal state.
 *
 * Performance: O(1) in practice since job messages are always near the end.
 *
 * @param messages - The conversation's message array (from persisted state)
 * @returns true if the most recent deep research job is still running
 */
export const hasActiveDeepResearchJob = (messages: ChatMessage[]): boolean => {
  const message = getLatestDeepResearchMessage(messages)
  return Boolean(
    message?.deepResearchJobStatus &&
    (ACTIVE_JOB_STATUSES as readonly string[]).includes(message.deepResearchJobStatus)
  )
}

export const hasCompletedDeepResearchReport = (messages: ChatMessage[]): boolean => {
  const message = getLatestDeepResearchMessage(messages)
  return Boolean(
    message &&
    !message.deepResearchReportExpired &&
    message.deepResearchJobStatus === 'success' &&
    (message.showViewReport || message.reportContent?.trim())
  )
}

export const hasExpiredDeepResearchReport = (messages: ChatMessage[]): boolean => {
  const message = getLatestDeepResearchMessage(messages)
  return Boolean(message?.deepResearchReportExpired)
}

/**
 * Activity flags derived entirely from persisted data.
 * All flags survive page refresh.
 */
export interface SessionActivityFlags {
  /** Server-side deep research job is running (derived from message history) */
  hasActiveDeepResearch: boolean
  /** HITL prompt is waiting for user response (from persisted pendingInteraction) */
  hasPendingHITL: boolean
}

/**
 * Derive all activity flags for the current session from persisted state.
 * This is the single source of truth for "is this session busy" after a page refresh.
 *
 * @param messages - Current conversation's message array
 * @param pendingInteraction - The persisted pending HITL interaction (or null)
 * @returns Activity flags derived from persisted data
 */
export const getPersistedActivityFlags = (
  messages: ChatMessage[],
  pendingInteraction: unknown | null
): SessionActivityFlags => ({
  hasActiveDeepResearch: hasActiveDeepResearchJob(messages),
  hasPendingHITL: pendingInteraction !== null,
})
