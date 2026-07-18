/**
 * Message Pruning for Storage
 *
 * Utilities for removing heavy, refetchable data from messages before
 * saving to localStorage. Research data can be fetched from backend on demand.
 */

import type { ChatMessage } from '../types'
import { extractTraceLanesFromPayload } from './trace-lanes'

/**
 * Cap string content to prevent excessively large values.
 */
export const capString = (value: string, max: number): string => {
  return value.length > max ? value.slice(0, max) : value
}

/**
 * Strip thinking steps for storage. ChatThinking renders displayName,
 * timestamp, and the Herleitung lane fan-out — not full payloads.
 *
 * - Deep research steps (isDeepResearch=true) are removed entirely since
 *   they are refetched from the async backend API.
 * - Shallow steps keep display fields + compact `traceLanes` (derived from
 *   content before it is dropped so the sources fan-out survives reload).
 */
export const stripThinkingStepsForStorage = (
  steps: NonNullable<ChatMessage['thinkingSteps']>
): NonNullable<ChatMessage['thinkingSteps']> => {
  return steps
    .filter((step) => !step.isDeepResearch)
    .map((step) => {
      const payload = [step.content, step.rawPayload].filter(Boolean).join('\n')
      const derived =
        step.traceLanes && step.traceLanes.length > 0
          ? step.traceLanes
          : payload.trim()
            ? extractTraceLanesFromPayload(payload)
            : undefined
      return {
        id: step.id,
        userMessageId: step.userMessageId,
        functionName: step.functionName,
        displayName: step.displayName,
        content: '',
        timestamp: step.timestamp,
        isComplete: step.isComplete,
        isDeepResearch: step.isDeepResearch,
        isTopLevel: step.isTopLevel,
        category: step.category,
        ...(derived && derived.length > 0 ? { traceLanes: derived } : {}),
      }
    })
}

/**
 * Prune plan messages to reduce storage size.
 * Keeps plan structure but caps text content.
 * planMessages cannot be refetched (WebSocket only).
 */
export const prunePlanMessages = (
  planMessages: NonNullable<ChatMessage['planMessages']>,
  maxTextLength = 10000
): NonNullable<ChatMessage['planMessages']> => {
  return planMessages.map((pm) => ({
    ...pm,
    text: capString(pm.text, maxTextLength),
    userResponse: pm.userResponse ? capString(pm.userResponse, 2000) : pm.userResponse,
  }))
}

/**
 * Prune a message for localStorage storage by removing heavy fields that
 * can be fetched from the backend on demand, stripping thinking step
 * content, and capping plan message text.
 *
 * KEEPS (Essential for UI):
 * - Core message fields (id, role, content, timestamp, messageType)
 * - citations (compact source metadata for the "Belegt durch" chips — capped
 *   content; a shallow answer's sources are NOT refetchable, so dropping them
 *   made the chips vanish on reload while the Herleitung fan-out survived)
 * - thinkingSteps (stripped: content removed, deep research steps dropped)
 * - planMessages (capped: text 10k, userResponse 2k — cannot be refetched)
 * - enabledDataSources, messageFiles (for "Selected Data Sources")
 * - deepResearchTodos (lightweight last-known task state)
 * - Deep research job metadata (for restoration)
 * - HITL/prompt fields (for interaction state)
 * - Other message type data (status, file, error, banner data)
 *
 * REMOVES (Can fetch from backend via importStreamOnly):
 * - reportContent, deepResearchLLMSteps, deepResearchAgents,
 *   deepResearchToolCalls, deepResearchFiles
 * - intermediateSteps (legacy, unused)
 * - thinkingStep content/rawPayload (never displayed in ChatThinking)
 * - Deep research thinking steps (refetched from async API)
 */

/** Max characters of citation `content` kept in storage — chips need the
 * metadata (kind/lane/locator), not the full captured passage. */
const MAX_CITATION_CONTENT = 300

export const pruneMessageForStorage = (message: ChatMessage): ChatMessage => {
  const {
    reportContent: _reportContent,
    deepResearchLLMSteps: _deepResearchLLMSteps,
    deepResearchAgents: _deepResearchAgents,
    deepResearchToolCalls: _deepResearchToolCalls,
    deepResearchFiles: _deepResearchFiles,
    intermediateSteps: _intermediateSteps,
    ...prunedMessage
  } = message

  // Keep the provenance chips across reload: citations are small metadata, but
  // cap the captured-passage `content` so storage stays bounded. Deep-research
  // citations are still refetched from the async API and simply overwrite these.
  if (prunedMessage.citations?.length) {
    prunedMessage.citations = prunedMessage.citations.map((c) =>
      c.content.length > MAX_CITATION_CONTENT
        ? { ...c, content: capString(c.content, MAX_CITATION_CONTENT) }
        : c
    )
  }

  if (prunedMessage.thinkingSteps?.length) {
    prunedMessage.thinkingSteps = stripThinkingStepsForStorage(prunedMessage.thinkingSteps)
  }

  if (prunedMessage.planMessages?.length) {
    prunedMessage.planMessages = prunePlanMessages(prunedMessage.planMessages)
  }

  return prunedMessage
}
