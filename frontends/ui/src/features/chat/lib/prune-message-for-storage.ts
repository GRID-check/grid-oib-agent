/**
 * Message Pruning for Storage
 *
 * Utilities for removing heavy, refetchable data from messages before
 * saving to localStorage. Research data can be fetched from backend on demand.
 */

import type { ChatMessage } from '../types'
import { extractTraceLanesFromPayload } from './trace-lanes'
import { turnEventOf } from './turn-events'

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
 * - Shallow steps keep display fields + compact `traceLanes` so the sources
 *   fan-out survives reload. A step that reported a `## Trace-Lanes` block
 *   already carries them: `updateThinkingStepByFunctionName` accumulates the
 *   lanes of every completion frame there, so its `traceLanes` is the union of
 *   all calls while `content` only holds the last payload — taking the step's
 *   own field first is therefore not just cheaper, it is the only version that
 *   still knows what the earlier calls retrieved. Deriving from the payload
 *   remains the path for steps with no structured block (web/RIS URL scan),
 *   and runs here, before that payload is dropped.
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
      // What the turn asked, kept the same way the lanes are: read off the
      // payload here, before it is dropped. This is the record of "what was
      // searched" that a reload, a colleague or a second device gets — the
      // server mirror (ADR-0037) inherits whatever this keeps.
      const turnEvent = turnEventOf(step)
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
        ...(turnEvent ? { turnEvent } : {}),
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

/** Max characters of citation `content` kept in storage — a chip needs the
 * locator, and `content` is a locator. */
const MAX_CITATION_CONTENT = 300

/**
 * Max characters of the retrieved PASSAGE kept in storage.
 *
 * This bound is the reason the function exists and it nearly went missing: the
 * passage used to arrive inside `content`, so capping `content` capped it. It
 * has its own wire field now, and until this line the cap was silently defeated
 * — a forty-source deep-research turn went from roughly 12 KB of stored
 * citations to 60 KB, per conversation, against one origin's localStorage
 * budget.
 *
 * Larger than `content` because the two are different things: one labels a
 * chip, the other has to be FOUND in a document, and the matchers anchor on
 * both ends of it. Clipped to 300 the tail anchor is gone, and a reload
 * quietly demotes "the sentence is marked" to "the page is open".
 */
const MAX_CITATION_SNIPPET = 1200

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

  // Keep the provenance chips across reload: citations are small metadata, and
  // the two free-text fields are capped so storage stays bounded. Deep-research
  // citations are still refetched from the async API and simply overwrite these.
  if (prunedMessage.citations?.length) {
    prunedMessage.citations = prunedMessage.citations.map((c) => {
      const content =
        c.content.length > MAX_CITATION_CONTENT
          ? capString(c.content, MAX_CITATION_CONTENT)
          : c.content
      const snippet =
        c.snippet && c.snippet.length > MAX_CITATION_SNIPPET
          ? capString(c.snippet, MAX_CITATION_SNIPPET)
          : c.snippet
      return content === c.content && snippet === c.snippet ? c : { ...c, content, snippet }
    })
  }

  if (prunedMessage.thinkingSteps?.length) {
    prunedMessage.thinkingSteps = stripThinkingStepsForStorage(prunedMessage.thinkingSteps)
  }

  if (prunedMessage.planMessages?.length) {
    prunedMessage.planMessages = prunePlanMessages(prunedMessage.planMessages)
  }

  return prunedMessage
}
