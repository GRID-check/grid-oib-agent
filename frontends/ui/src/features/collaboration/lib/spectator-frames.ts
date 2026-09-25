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
 * ## The rules worth stating
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
 *  3. **Live-frame semantics mirror `messages-store.ts`.** A delta appends;
 *     `stream_replace` replaces the text and the citations, and drops a
 *     masthead the snapshot omits; an EMPTY one (no text, no sources) retracts
 *     a tool round and takes its live cards back with it; masthead and cards
 *     frames set without touching the text; a `complete` with text (blank is
 *     not text) is authoritative, absence included, for a masthead or cards
 *     a live frame brought and for the citations, which go with the text; a legacy frame's cards, which rode with text,
 *     are final and stay; a whitespace-only delta is text once the answer
 *     has begun and nothing before it. Change one fold and you change the other, with a
 *     spec case in both.
 *  4. **An observer is never handed a card that acts.** Interactive and
 *     system cards (a memory proposal, a file operation, a brief patch, a
 *     draft to file) propose a write in the ASKER's name. They are dropped
 *     here, leaving their position as a hole so every `[[card:N]]` marker
 *     after them stays bound, and `SpectatedTurn` draws the rest read-only on
 *     top of that (ADR-0039 §5).
 *
 * Nothing here is authoritative. The persisted answer arrives over the ordinary
 * message path and replaces all of it — this exists purely so the ninety seconds
 * before that are not a blank wait.
 */

import { NATIncomingMessageSchema, NATMessageType } from '@/adapters/api/schemas'
import type { CitationSource, ThinkingStep } from '@/features/chat/types'
import { citationsFromWireList } from '@/features/chat/lib/wire-citation'
import { sanitizeAnswerMeta, type AnswerMeta } from '@/lib/conversations/message-answer-meta'
import { validateGridCards, type GridCard } from '@/shared/cards/schemas'
import { INTERACTIVE_CARD_TYPES } from '@/features/grid-cards/card-decision'
import { SYSTEM_CARD_TYPES } from '@/features/skills/lib/card-catalog'
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
  /**
   * What stands around the prose, as the live frames deliver it to the asker
   * too (ADR-0066): the masthead before the first word, the sources once the
   * text is verified, the cards as each is written. All three are gated by the
   * backend before they are sent, so the observer's copy is the asker's.
   */
  answerMeta?: AnswerMeta
  citations?: CitationSource[]
  cards?: (GridCard | undefined)[]
  /**
   * Whether the masthead or cards on screen came from a LIVE frame (one with
   * no text of its own, or a snapshot's masthead) rather than a legacy
   * in_progress frame that carried text. Only live ones are provisional, so
   * only they are taken back by a terminal that omits them: the store's
   * `liveMetaShown`.
   */
  liveExtras?: boolean
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
      const around = aroundTheProse(message)
      if (message.status === 'complete') {
        // A terminal with text is authoritative for what the live frames showed
        // ahead of it, absence included (a suppressed card, a gated masthead).
        // Blank is not text: the store's finalize uses the same test.
        const authoritative = text.trim().length > 0
        const retractLive = authoritative && next.liveExtras === true
        return {
          ...next,
          ...(authoritative ? { citations: undefined } : {}),
          ...(retractLive ? { answerMeta: undefined, cards: undefined } : {}),
          ...around,
          liveExtras: false,
          parentId,
          // The terminal frame is authoritative — but a backend that sends an
          // EMPTY complete after streaming deltas must not blank the answer.
          answer: authoritative ? text : next.answer,
          steps: next.steps.map((step) => (step.isComplete ? step : { ...step, isComplete: true })),
          waitingOn: null,
          done: true,
        }
      }
      // A settled snapshot (ADR-0066) REPLACES the text streamed so far; a
      // spectator that appended it would read the answer twice.
      // Its masthead is re-gated against that prose, and its sources are all
      // the text cites, so a snapshot without them takes the live ones back,
      // as the asker's store does. An EMPTY snapshot is the retraction of a
      // streamed round that turned out to call tools: checked before the
      // "nothing to fold" return below, which would otherwise swallow it.
      if (message.stream_replace === true) {
        // An empty snapshot with no sources retracts the whole round, the
        // cards it streamed included: a dead round's cards are not the answer.
        const retraction = !text && !(message.sources && message.sources.length > 0)
        return {
          ...next,
          answerMeta: undefined,
          citations: undefined,
          ...(retraction ? { cards: undefined } : {}),
          ...around,
          // A snapshot is a live frame whatever text it carries.
          liveExtras: next.liveExtras === true || Boolean(around.answerMeta),
          parentId,
          answer: text,
          waitingOn: null,
        }
      }
      // Whitespace is text once the answer has begun (a batched "\n\n" keeps
      // two paragraphs apart) but not as its first frame, where it opens
      // nothing on the asker's screen either (the store's `nothingToDraw`).
      const answerOpen = next.answer !== '' || next.answerMeta !== undefined || next.cards !== undefined
      const nothingToDraw = answerOpen ? !text : !text.trim()
      if (nothingToDraw && Object.keys(around).length === 0) return next === state ? state : next
      // A frame with no text of its own carries only what stands around the
      // prose: the live shape (the store's `isLiveExtrasFrame`).
      const liveExtras = next.liveExtras === true || !text
      return { ...next, ...around, liveExtras, parentId, answer: next.answer + text, waitingOn: null }
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

/** The masthead, sources and cards a response frame carries, only those present. */
function aroundTheProse(message: {
  answer_meta?: unknown
  sources?: unknown[] | null
  cards?: unknown[]
}): Pick<SpectatedTurnState, 'answerMeta' | 'citations' | 'cards'> {
  const answerMeta = sanitizeAnswerMeta(message.answer_meta) ?? undefined
  const citations = citationsFromWireList(message.sources)
  const cards = message.cards && message.cards.length > 0 ? forObservers(validateGridCards(message.cards)) : undefined
  return {
    ...(answerMeta ? { answerMeta } : {}),
    ...(citations ? { citations } : {}),
    ...(cards ? { cards } : {}),
  }
}

/**
 * Card types an observer never sees: each proposes a write (or is pushed by a
 * tool acting for the asker), and a colleague reading along has no standing
 * to make it. Rule 4 in the header.
 */
const NOT_FOR_OBSERVERS: ReadonlySet<string> = new Set<string>([...INTERACTIVE_CARD_TYPES, ...SYSTEM_CARD_TYPES])

/** The cards with every one an observer may not see replaced by a hole, positions kept. */
function forObservers(cards: (GridCard | undefined)[]): (GridCard | undefined)[] {
  return cards.map((card) => (card && NOT_FOR_OBSERVERS.has(card.type) ? undefined : card))
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
