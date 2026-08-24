/**
 * Fold the agent's outbound frames into what an OBSERVER of a shared thread needs
 * to see: the answer as it is written, and the reasoning as it is done.
 *
 * ## Why this is not `useWebSocketChat`
 *
 * That hook does not render a turn, it *drives* one — acknowledgements, resend
 * buffers, the inactivity watchdog, auth rotation, HITL prompts, deep-research
 * hand-off, conversation naming. None of it applies to somebody reading along: an
 * observer has no socket to rotate, no message to resend, and no prompt that is
 * theirs to answer. What is left once you remove all of that is this file: a pure
 * fold from frames to display state, with no I/O and no store writes, which is
 * also what makes it directly testable.
 *
 * ## The two rules worth stating
 *
 *  1. **Answer frames are routed by `status`, not by any flag** — the same
 *     contract the asker's client obeys. `in_progress` frames are deltas that
 *     accumulate; the terminal `complete` frame carries the authoritative full
 *     answer and REPLACES what accumulated. A backend that answers in one shot
 *     collapses to "one delta then an empty complete" and lands on the same text.
 *  2. **A new `parent_id` starts a new turn.** Frames are relayed from a
 *     per-conversation channel, so the tail of one turn and the head of the next
 *     arrive on the same subscription; without this the second question's answer
 *     would append to the first one's.
 *
 * Nothing here is authoritative. The persisted answer arrives over the ordinary
 * message path and replaces all of it — this exists purely so the ninety seconds
 * before that are not a blank wait.
 */

import { NATIncomingMessageSchema, NATMessageType } from '@/adapters/api/schemas'
import type { ThinkingStep } from '@/features/chat/types'
import {
  formatPayload,
  getDisplayName,
  getWorkflowDisplayName,
  isFunctionStepName,
  mapFunctionToCategory,
  parseFunctionName,
} from '@/features/chat/lib/intermediate-step-parser'

/** What an observer is shown for the turn currently in flight. */
export interface SpectatedTurnState {
  /**
   * The turn these frames belong to (the NAT `parent_id`). Null until the first
   * frame that carries one; used only to notice that a NEW turn started.
   */
  parentId: string | null
  /** The answer so far. Empty while the agent is still working out what to say. */
  answer: string
  /** The reasoning chain so far, in the shape `ChatThinking` already renders. */
  steps: ThinkingStep[]
  /**
   * Set when the agent asked the ASKER something and is waiting. An observer sees
   * that the turn has paused on a person; the prompt itself is not theirs to
   * answer, so only its text is kept.
   */
  waitingOn: string | null
  /** The terminal frame landed. The persisted answer is about to replace all this. */
  done: boolean
  /** The turn ended in an error frame. Distinct from `done`: nothing will land. */
  failed: boolean
}

export const EMPTY_SPECTATED_TURN: SpectatedTurnState = {
  parentId: null,
  answer: '',
  steps: [],
  waitingOn: null,
  done: false,
  failed: false,
}

/**
 * The `userMessageId` every step of one spectated turn is filed under.
 *
 * `ThinkingStep` carries it because the asker's store keys steps by the message
 * that triggered them. An observer has exactly one turn on screen at a time, so a
 * constant is honest here — and it must NOT be a real message id, or a step
 * belonging to a live spectated turn could be mistaken for one belonging to a
 * persisted message.
 */
const SPECTATED_USER_MESSAGE_ID = '__spectated__'

let stepCounter = 0

/** Stable-enough ids for React keys. Not persisted, never leaves this module. */
function nextStepId(): string {
  stepCounter += 1
  return `spectated_${stepCounter}`
}

/**
 * Extract answer text from a response frame's three historical content shapes.
 * `output` must be tried before `text`: `SystemResponseContent` has only optional
 * fields, so it matches `{output: …}` too and would silently parse it to `{}`.
 */
function responseText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!content || typeof content !== 'object') return ''
  const shape = content as { output?: unknown; text?: unknown }
  if (typeof shape.output === 'string') return shape.output
  if (typeof shape.text === 'string') return shape.text
  return ''
}

/**
 * Apply one raw frame to the state, returning the next state.
 *
 * Pure and total: an unparseable, unknown or irrelevant frame returns the state
 * unchanged (referentially, so React can skip the render). A malformed frame from
 * a service we do not control must never be able to blank an observer's screen.
 */
export function reduceSpectatedFrame(
  state: SpectatedTurnState,
  raw: unknown,
): SpectatedTurnState {
  const parsed = NATIncomingMessageSchema.safeParse(raw)
  if (!parsed.success) return state
  const message = parsed.data

  // A frame from a different turn than the one on screen starts a fresh one.
  // Intermediate steps carry an INTERNAL step id in `parent_id` rather than the
  // user message id, so only answer frames — which do carry it — are trusted to
  // declare the boundary.
  let next = state
  if (
    message.type === NATMessageType.SYSTEM_RESPONSE &&
    message.parent_id &&
    state.parentId !== null &&
    message.parent_id !== state.parentId
  ) {
    next = { ...EMPTY_SPECTATED_TURN }
  }

  switch (message.type) {
    case NATMessageType.SYSTEM_RESPONSE: {
      const text = responseText(message.content)
      const parentId = message.parent_id ?? next.parentId
      if (message.status === 'complete') {
        return {
          ...next,
          parentId,
          // The terminal frame is authoritative — but a backend that sends an
          // EMPTY complete after streaming deltas must not blank the answer.
          answer: text.trim() ? text : next.answer,
          steps: next.steps.map((step) => (step.isComplete ? step : { ...step, isComplete: true })),
          waitingOn: null,
          done: true,
        }
      }
      if (!text) return next === state ? state : next
      return { ...next, parentId, answer: next.answer + text, waitingOn: null }
    }

    case NATMessageType.SYSTEM_INTERMEDIATE: {
      const content = message.content
      // Legacy string payload: one generic step, appended to.
      if (typeof content === 'string') {
        if (!content.trim()) return next === state ? state : next
        return { ...next, steps: appendGenericStep(next.steps, content) }
      }
      if (!content.name) return next === state ? state : next
      // Clearing `waitingOn` here as well as on a response frame: the answer to a
      // prompt travels the agent's own input channel, which an observer does not
      // subscribe to, so the only evidence they ever get that the pause is over
      // is the agent doing something again. Without this, an agent that answers
      // and then runs tools for a while left the observer reading "Piloti asked
      // a question and is waiting" long after it had been answered.
      return {
        ...next,
        waitingOn: null,
        steps: applyNamedStep(next.steps, content.name, content.payload ?? ''),
      }
    }

    case NATMessageType.SYSTEM_INTERACTION: {
      // The agent is asking the ASKER something. Read-only for an observer: they
      // see the thread has paused on a person, not a control they could press.
      return { ...next, waitingOn: message.content.text }
    }

    case NATMessageType.ERROR: {
      return { ...next, failed: true, done: true, waitingOn: null }
    }

    default:
      return next === state ? state : next
  }
}

function appendGenericStep(steps: ThinkingStep[], content: string): ThinkingStep[] {
  const last = steps[steps.length - 1]
  if (last && last.functionName === 'unknown' && !last.isComplete) {
    return [...steps.slice(0, -1), { ...last, content: last.content + content + '\n' }]
  }
  return [
    ...steps,
    {
      id: nextStepId(),
      userMessageId: SPECTATED_USER_MESSAGE_ID,
      category: 'agents',
      functionName: 'unknown',
      displayName: 'Processing',
      content: content + '\n',
      timestamp: new Date(),
      isComplete: false,
    },
  ]
}

/**
 * Merge a `Function Start:` / `Function Complete:` pair onto one step, matching
 * the asker's client: a completion replaces the step's content and closes it,
 * anything else opens a new one.
 */
function applyNamedStep(steps: ThinkingStep[], name: string, payload: string): ThinkingStep[] {
  const { functionName, isComplete } = parseFunctionName(name)
  const formatted = formatPayload(payload)
  const existing = steps.findIndex((step) => step.functionName === functionName)

  if (existing >= 0) {
    const step = steps[existing]
    const merged: ThinkingStep = isComplete
      ? { ...step, content: formatted, rawPayload: payload, isComplete: true }
      : { ...step, content: `${step.content}\n${formatted}` }
    return [...steps.slice(0, existing), merged, ...steps.slice(existing + 1)]
  }

  return [
    ...steps,
    {
      id: nextStepId(),
      userMessageId: SPECTATED_USER_MESSAGE_ID,
      category: mapFunctionToCategory(functionName),
      functionName,
      displayName: getWorkflowDisplayName(functionName) || getDisplayName(functionName),
      content: formatted,
      rawPayload: payload,
      timestamp: new Date(),
      isComplete,
      isTopLevel: isFunctionStepName(name),
    },
  ]
}

/** Test seam: step ids are a module counter, so a suite can assert on them. */
export function __resetSpectatorStepIdsForTests(): void {
  stepCounter = 0
}
