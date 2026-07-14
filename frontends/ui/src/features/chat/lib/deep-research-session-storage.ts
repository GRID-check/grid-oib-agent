/**
 * Deep Research Session Storage
 *
 * Persists in-progress deep research state to sessionStorage
 * so events don't need to be refetched on page refresh.
 * Supports multiple concurrent jobs with job-specific keys.
 */

import type { DeepResearchJobStatus } from '../types'

const STORAGE_KEY_PREFIX = 'aiq-deep-research-'

const getStorageKey = (jobId: string): string => `${STORAGE_KEY_PREFIX}${jobId}`

/**
 * Lightweight metadata persisted to sessionStorage for reconnection.
 * Heavy event data (citations, todos, llmSteps, agents, toolCalls, files,
 * reportContent) is NOT stored — it's replayed from the SSE stream on reconnect.
 */
export interface DeepResearchSessionState {
  jobId: string
  lastEventId: string | null
  ownerConversationId: string | null
  activeMessageId: string | null
  status: DeepResearchJobStatus | null
  timestamp: number
}

/**
 * Save deep research state to sessionStorage (keyed by jobId)
 */
export const saveDeepResearchToSession = (state: Omit<DeepResearchSessionState, 'timestamp'>): void => {
  try {
    const stateWithTimestamp: DeepResearchSessionState = {
      ...state,
      timestamp: Date.now(),
    }
    sessionStorage.setItem(getStorageKey(state.jobId), JSON.stringify(stateWithTimestamp))
  } catch (error) {
    console.warn('Failed to save deep research state to sessionStorage:', error)
  }
}

/**
 * Clear deep research state from sessionStorage for a specific job
 */
export const clearDeepResearchSession = (jobId: string): void => {
  try {
    sessionStorage.setItem(getStorageKey(jobId), '')
    sessionStorage.removeItem(getStorageKey(jobId))
  } catch (error) {
    console.warn('Failed to clear deep research state from sessionStorage:', error)
  }
}

/**
 * Clear all deep research sessions from sessionStorage
 */
export const clearAllDeepResearchSessions = (): void => {
  try {
    const keysToRemove: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key?.startsWith(STORAGE_KEY_PREFIX)) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach((key) => sessionStorage.removeItem(key))
  } catch (error) {
    console.warn('Failed to clear all deep research sessions:', error)
  }
}
