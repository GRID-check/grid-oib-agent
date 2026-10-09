/**
 * A folded turn, drawn into its conversation (docs/design/chat-wire-v2.md §e.3).
 *
 * `foldTurnEvent` is the only reader of the wire; this is the only writer of
 * what it read into `ChatMessage`s. Three messages carry a turn: the question
 * (its id is the turn id) holds the Herleitung, the answer (the id
 * `RUN_STARTED` named) holds the prose, sources, masthead, cards and, once the
 * terminal lands, everything the result says, and a prompt message holds an
 * open `interaction_request`. A turn that commissions a run (ADR-0062) swaps
 * its answer for the run's message, provisional until the stored row is
 * adopted. Pure: the store decides what to persist.
 *
 * Identity is the render budget. A message whose projection is unchanged is
 * the same object, and the fields a flush did not touch keep theirs: the cards
 * go through `replaceEqualDeep`, and citations and masthead are rebuilt only
 * when the view's own field is a new object.
 */

import { replaceEqualDeep } from '@tanstack/react-query'
import { v4 as uuidv4 } from 'uuid'
import type { StageId, TurnView } from './turn-fold'
import type { ChatMessage } from '../types'
import { citationsFromWireList } from './wire-citation'
import { reconcileCardInteractions } from '@/features/grid-cards/card-decision'
import { validateGridCards, type GridCard } from '@/shared/cards/schemas'
import { sanitizeAnswerMeta } from '@/lib/conversations/message-answer-meta'
import { isChatEffort } from '@/lib/reasoning-settings/catalog'
import { sanitizeRetrievalLedger } from '@/lib/conversations/message-retrieval-ledger'
import { sanitizeQuoteStamps } from '@/lib/conversations/message-quote-stamps'
import { emptyRunLedger, sanitizeRunTitle } from '@/lib/runs/run-ledger'
import {
  sanitizeFollowUpsStage,
  sanitizeMemoryReflectionStage,
  type MessageStages,
} from '@/lib/conversations/message-stages'

/** Which `MessageStages` key each stage lands under, with the contract its payload must meet. */
const STAGES: { [K in StageId]: { key: keyof MessageStages; sanitize: (payload: unknown) => MessageStages[keyof MessageStages] | null } } = {
  follow_ups: { key: 'followUps', sanitize: sanitizeFollowUpsStage },
  memory_reflection: { key: 'memoryReflection', sanitize: sanitizeMemoryReflectionStage },
}

/** Every stage a turn can deliver after its terminal; the turn stays attachable until all have landed. */
export const STAGE_COUNT = Object.keys(STAGES).length

/**
 * Stages appended BELOW the answer, which may only land where they push
 * nothing the reader has read (`post-answer-stages.md` §8). A memory
 * reflection's chip sits in the answer's reserved footer row and always lands:
 * a suggestion may be withheld, a record of a write may not.
 */
const GROWS_THE_THREAD: ReadonlySet<StageId> = new Set(['follow_ups'])

export interface TurnProjection {
  messages: ChatMessage[]
  /** The answer, when this fold delivered the terminal's result. */
  settled?: ChatMessage
  /** A prompt message this fold opened. */
  prompt?: ChatMessage
  /** Stage output to mirror to the answer's row, whether or not it was drawn. */
  stageWrites: MessageStages[]
}

export interface ProjectionContext {
  /** How long the turn took, for the answer the terminal settles. */
  answerDurationMs?: number
  /** The reader's unsent draft in this conversation: a growing stage waits for an empty one. */
  draft: string
}

const nonEmpty = <T>(list: T[] | null | undefined): T[] | undefined => (list && list.length > 0 ? list : undefined)

const hasSomethingToDraw = (view: TurnView): boolean =>
  Boolean(view.text.trim() || view.answerMeta || view.sources.length > 0) || view.cards.some(Boolean)

/** The cards by index, a refused or missing one a hole, a card the schema refuses a hole too. */
const cardsOf = (view: TurnView): (GridCard | undefined)[] | undefined =>
  view.cards.length === 0
    ? undefined
    : Array.from(view.cards, (keyed) => (keyed ? validateGridCards([keyed.card])[0] : undefined))

/** What the terminal says about the answer, in the stored field names; absent fields stay absent. */
const resultFields = (view: TurnView): Partial<ChatMessage> => {
  const result = view.result
  if (!result) return {}
  const fields: Partial<ChatMessage> = {
    answerConfidence: result.answer_confidence ?? undefined,
    answerConfidenceCappedReason: result.answer_confidence_capped_reason ?? undefined,
    answerConfidenceReason: result.answer_confidence_reason ?? undefined,
    routingDecision: result.routing_decision ?? undefined,
    escalationReason: result.escalation_reason ?? undefined,
    citationsRemoved: result.citations_removed ?? undefined,
    readSources: nonEmpty(citationsFromWireList(result.read_sources)),
    researchTruncated: result.research_truncated ? true : undefined,
    skillsActivated: nonEmpty(result.skills_activated),
    skillsHidden: nonEmpty(result.skills_hidden),
    retrievalLedger: sanitizeRetrievalLedger(result.retrieval_ledger) ?? undefined,
    quoteStamps: sanitizeQuoteStamps(result.quote_stamps) ?? undefined,
  }
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined))
}

/** The answer message for `view`, or `existing` itself when nothing it shows changed. */
const answerOf = (
  existing: ChatMessage | undefined,
  view: TurnView,
  previous: TurnView | undefined,
  context: ProjectionContext
): ChatMessage => {
  const base: ChatMessage = existing ?? {
    id: view.messageId!,
    role: 'assistant',
    content: '',
    timestamp: new Date(),
    messageType: 'agent_response',
  }
  const patch: Partial<ChatMessage> = {}
  const put = <K extends keyof ChatMessage>(key: K, value: ChatMessage[K]): void => {
    if (base[key] !== value) patch[key] = value
  }
  const fresh = !existing || !previous
  put('content', view.text)
  put('isStreaming', view.phase === 'running' ? true : undefined)
  put('stopped', view.outcome === 'cancelled' ? true : undefined)
  // `RUN_ERROR` under a written answer: the words stay, marked as cut off, in
  // the same frame the stream ends, so they never settle as a finished answer.
  put('failed', view.phase === 'failed' ? true : undefined)
  // The level the turn RAN at: the terminal's report wins, because it is resolved
  // server-side and reaches an observer too; the asker's own record covers the
  // turn until then. A reported `none` is no chat level, so the record stands.
  const reported = view.result?.reasoning_effort
  const ranAt = isChatEffort(reported) ? reported : view.effort
  if (ranAt) put('reasoningEffort', ranAt)
  if (fresh || previous.cards !== view.cards) {
    const cards = replaceEqualDeep(base.cards, cardsOf(view))
    if (cards !== base.cards) {
      patch.cards = cards
      patch.cardInteractions = reconcileCardInteractions(base.cardInteractions, base.cards, cards)
    }
  }
  if (fresh || previous.sources !== view.sources) put('citations', nonEmpty(citationsFromWireList(view.sources)))
  if (fresh || previous.answerMeta !== view.answerMeta) put('answerMeta', sanitizeAnswerMeta(view.answerMeta) ?? undefined)
  if (view.result && view.result !== previous?.result) {
    Object.assign(patch, resultFields(view))
    if (context.answerDurationMs !== undefined) patch.answerDurationMs = context.answerDurationMs
  }
  return Object.keys(patch).length === 0 ? base : { ...base, ...patch }
}

const PROVISIONAL_UPDATED_AT = new Date(0).toISOString()

/**
 * The run's message as the open thread can draw it before the stored one
 * arrives: the id the server wrote it under, and the ledger of a run that has
 * done nothing yet. An `agent_response`, like the stored row (the mapper's
 * default), so the turn counts as answered. Never persisted: the server's row
 * is the record, and the block follows the run's own stream from its id.
 */
export const provisionalRunMessage = (runId: string, messageId: string, question?: string): ChatMessage => {
  // The question is the run's title (`turn/commission.py`), so the header the
  // stored row brings is, in the common case, the one already on screen.
  const runTitle = sanitizeRunTitle(question)
  return {
    id: messageId,
    role: 'assistant',
    content: '',
    timestamp: new Date(),
    messageType: 'agent_response',
    // Stamped older than anything the server writes, so the first real ledger
    // (adopted, fetched or streamed) wins `useRunLedger`'s newer-only test even
    // when this browser's clock runs ahead of the server's.
    runLedger: { ...emptyRunLedger(runId), updatedAt: PROVISIONAL_UPDATED_AT },
    ...(runTitle ? { runTitle } : {}),
  }
}

const promptOf = (view: TurnView): ChatMessage | undefined => {
  const request = view.interaction
  if (!request) return undefined
  return {
    id: uuidv4(),
    role: 'assistant',
    content: request.text,
    timestamp: new Date(),
    messageType: 'prompt',
    promptId: request.interaction_id,
    promptParentId: view.turnId,
    promptInputType: request.input,
    promptOptions: nonEmpty(request.options),
    promptPlaceholder: request.placeholder ?? undefined,
    isPromptResponded: false,
  }
}

/**
 * The stage output this fold brought, sanitized by each stage's own contract,
 * and whether it may be drawn now (§8: nothing below the answer, the answer
 * finished, the reader not typing).
 */
const stagesOf = (
  view: TurnView,
  previous: TurnView | undefined,
  answerIsLast: boolean,
  context: ProjectionContext
): { stored: MessageStages[]; drawn: MessageStages } => {
  const stored: MessageStages[] = []
  const drawn: MessageStages = {}
  for (const [stage, value] of Object.entries(view.stages) as [StageId, NonNullable<TurnView['stages'][StageId]>][]) {
    if (value === previous?.stages[stage] || value.status !== 'ready') continue
    const { key, sanitize } = STAGES[stage]
    const payload = sanitize(value.payload)
    if (!payload) continue
    stored.push({ [key]: payload })
    const growthRefused =
      GROWS_THE_THREAD.has(stage) && (!answerIsLast || view.phase === 'running' || context.draft.trim().length > 0)
    if (!growthRefused) Object.assign(drawn, { [key]: payload })
  }
  return { stored, drawn }
}

/** `messages` with `view` drawn into them; the same array when nothing changed. */
export const projectTurn = (
  messages: ChatMessage[],
  view: TurnView,
  previous: TurnView | undefined,
  context: ProjectionContext
): TurnProjection => {
  let next = messages
  const edit = (): ChatMessage[] => (next === messages ? (next = [...messages]) : next)
  const projection: TurnProjection = { messages, stageWrites: [] }

  // The Herleitung, on the question. An empty view (a replay not yet folded)
  // leaves the stored steps standing rather than blank them for a moment.
  const question = messages.findIndex((message) => message.id === view.turnId)
  const stepsMoved = view.steps !== previous?.steps || view.stepOrder !== previous?.stepOrder
  if (question >= 0 && view.stepOrder.length > 0 && stepsMoved) {
    const steps = view.stepOrder.map((id) => view.steps[id]!)
    const held = messages[question]!.thinkingSteps
    const same = held?.length === steps.length && steps.every((step, index) => held[index] === step)
    if (!same) edit()[question] = { ...messages[question]!, thinkingSteps: steps }
  }

  const answerAt = view.messageId ? next.findIndex((message) => message.id === view.messageId) : -1
  // A turn that commissioned a run, or that the job queue refused, answers
  // somewhere else: in the run's block, or in a banner.
  const answeredElsewhere = Boolean(view.result?.run || view.result?.job_admission_rejected)
  const run = view.result?.run
  if (run) {
    // The block takes the answer's place in the same frame, as a provisional
    // run message under the id the server already wrote it with. Dropping the
    // answer and waiting for the fetch left the turn with no response for a
    // round trip, which the Herleitung read as an interrupted turn (and, when
    // the fetch failed, kept reading so until a reload). `adoptRunMessage`
    // replaces this row in place when the stored message arrives.
    const runAt = next.findIndex((message) => message.id === run.run_message_id)
    if (runAt < 0) {
      const asked = question >= 0 ? next[question]!.content : undefined
      const provisional = provisionalRunMessage(run.run_id, run.run_message_id, asked)
      if (answerAt >= 0) edit()[answerAt] = provisional
      else edit().push(provisional)
    } else if (answerAt >= 0) edit().splice(answerAt, 1)
  } else if (answeredElsewhere && answerAt >= 0) edit().splice(answerAt, 1)
  if (!answeredElsewhere && view.messageId && (answerAt >= 0 || hasSomethingToDraw(view))) {
    const existing = answerAt >= 0 ? next[answerAt] : undefined
    let answer = answerOf(existing, view, previous, context)
    const index = answerAt >= 0 ? answerAt : next.length
    const { stored, drawn } = stagesOf(view, previous, index >= next.length - 1, context)
    projection.stageWrites = stored
    if (Object.keys(drawn).length > 0) answer = { ...answer, stages: { ...answer.stages, ...drawn } }
    if (answer !== existing) edit()[index] = answer
    if (view.result && view.result !== previous?.result) projection.settled = answer
  }

  if (view.interaction && view.interaction !== previous?.interaction) {
    const asked = next.some((message) => message.messageType === 'prompt' && message.promptId === view.interaction?.interaction_id)
    const prompt = asked ? undefined : promptOf(view)
    if (prompt) {
      edit().push(prompt)
      projection.prompt = prompt
    }
  }

  projection.messages = next
  return projection
}
