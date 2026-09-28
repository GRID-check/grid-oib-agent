/**
 * The one interpretation of the chat wire (`docs/design/chat-wire-v2.md` §e.1).
 *
 * `foldTurnEvent(view, event)` turns one v2 event into the next {@link TurnView}.
 * The asker's live socket, the replay after `attach` and the spectator stream
 * all fold through it, so there is no second reader to drift. It is pure: no
 * store, no React, no clock. Every rule is the event table in §a:
 *
 * - `seq` orders a turn. A duplicate returns the same object, so nothing
 *   re-renders. A jump past `lastSeq + 1` is NOT applied: `gap` is set and the
 *   driver sends `attach{after_seq: lastSeq}`, whose replay fills it. The first
 *   event a view sees is taken at any `seq` (a spectator joins mid-turn).
 *   `seq: 0` (`rejected`) is out of band and never folded.
 * - Steps are keyed by id, newest wins, and stored in the persisted shape
 *   (§e.4). A `sources` step's lanes are stored as they came, renamed to the
 *   stored field names; nothing is parsed out of text.
 * - Cards sit at their index; an equal `key` keeps the object, so the node is
 *   kept. `STATE_SNAPSHOT` replaces text, sources and masthead;
 *   `answer_retracted` clears them and the cards; `RUN_FINISHED`'s result is
 *   authoritative for all four.
 */

import type { TurnResult, WireEvent } from '@/adapters/api/wire-v2'
import type { StoredThinkingStep, TraceLaneCard } from '@/lib/conversations/message-provenance'
import { KIND_TO_SIGNAL, asShelf } from './source-kinds'

type Named<N extends string> = Extract<WireEvent, { type: 'CUSTOM'; name: N }>
type StepOf<K extends string> = Extract<Extract<WireEvent, { type: 'STEP_FINISHED' }>['step'], { kind: K }>

export type KeyedCard = NonNullable<TurnResult['cards']>[number]
export type WireSource = NonNullable<TurnResult['sources']>[number]
export type InteractionRequestValue = Named<'interaction_request'>['value']
export type StageValue = Named<'stage'>['value']
export type StageId = StageValue['stage']
export type TurnOutcome = Extract<WireEvent, { type: 'RUN_FINISHED' }>['outcome']

export interface TurnView {
  turnId: string
  conversationId: string
  messageId?: string
  lastSeq: number
  gap: boolean
  phase: 'running' | 'finished' | 'failed'
  outcome?: TurnOutcome
  /** Between TEXT_MESSAGE_START and its END, a retraction or the terminal. */
  streaming: boolean
  text: string
  sources: WireSource[]
  answerMeta?: Record<string, unknown>
  /** By index: `null` refused, `undefined` not arrived. */
  cards: (KeyedCard | null | undefined)[]
  steps: Record<string, StoredThinkingStep>
  stepOrder: string[]
  interaction?: InteractionRequestValue
  stages: Partial<Record<StageId, StageValue>>
  lastBeatAt?: number
  beatEveryMs?: number
  result?: TurnResult
  error?: { code: string; message: string }
}

export const initialTurnView = (turnId: string, conversationId: string): TurnView => ({
  turnId,
  conversationId,
  lastSeq: 0,
  gap: false,
  phase: 'running',
  streaming: false,
  text: '',
  sources: [],
  cards: [],
  steps: {},
  stepOrder: [],
  stages: {},
})

/** `{ [name]: value }` when the value says something, else nothing: a stored row omits what is empty. */
const some = <K extends string, V>(name: K, value: V | null | undefined): Partial<Record<K, V>> => {
  const empty =
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' && Object.keys(value).length === 0)
  return empty ? {} : ({ [name]: value } as Record<K, V>)
}

const lanesOf = (step: StepOf<'sources'>): TraceLaneCard[] =>
  step.lanes.map((lane) => ({
    key: lane.key,
    label: lane.label,
    hitCount: lane.hit_count,
    kind: lane.kind,
    signal: KIND_TO_SIGNAL[lane.kind],
    sources: lane.sources.map((hit) => ({
      name: hit.name,
      ...some('title', hit.title),
      ...some('detail', hit.detail),
      ...some('shelf', asShelf(hit.shelf)),
      ...some('round', hit.round),
    })),
  }))

/** The fields one step kind contributes to its stored row. */
const storedFields = (step: StepOf<string>, previous?: StoredThinkingStep): Partial<StoredThinkingStep> => {
  switch (step.kind) {
    case 'status':
      return {
        slot: step.slot,
        // Only a live key speaks; a technical record carries none by contract, and is refused here too.
        ...(step.channel === 'live' && step.key ? { turnEvent: { key: step.key, ...some('values', step.values) } } : {}),
        ...some('detail', step.detail),
      }
    case 'retrieval':
      return {
        round: step.round,
        turnEvent: { key: step.key, ...some('values', step.values), ...some('reason', step.reason), ...some('tools', step.tools) },
      }
    case 'sources':
      return { tool: step.tool, traceLanes: lanesOf(step), ...some('round', step.round) }
    case 'tool':
      return { tool: step.tool, ...(step.status === 'error' ? { detail: { status: 'error' } } : {}) }
    case 'skill': {
      // The one live skill sentence: an activation with an authored title, not hidden (`skills/events.py`).
      const live = step.phase === 'activated' && step.channel === 'live' && !step.hidden && step.title
      return {
        ...some('skill', step.skill),
        ...(live ? { turnEvent: { key: 'skill.activated', values: { skill: live } } } : {}),
        // A later phase of the same skill replaces the row; its authored title
        // must survive that, so it is carried from the row it replaces.
        detail: {
          phase: step.phase,
          hidden: step.hidden,
          ...some('count', step.count),
          ...some('title', step.title ?? previous?.detail?.title),
        },
      }
    }
    case 'clarification':
      return { detail: { max_turns: step.max_turns } }
    default:
      return {}
  }
}

const foldStep = (view: TurnView, event: Extract<WireEvent, { type: 'STEP_STARTED' | 'STEP_FINISHED' }>): TurnView => {
  const { step } = event
  const previous = view.steps[step.id]
  const stored: StoredThinkingStep = {
    id: step.id,
    userMessageId: view.turnId,
    timestamp: previous?.timestamp ?? new Date(event.ts).toISOString(),
    isComplete: event.type === 'STEP_FINISHED',
    kind: step.kind,
    ...(step.scope === 'deep' ? { scope: 'deep' } : {}),
    ...storedFields(step, previous),
  }
  return {
    ...view,
    steps: { ...view.steps, [step.id]: stored },
    stepOrder: previous ? view.stepOrder : [...view.stepOrder, step.id],
  }
}

/** The card at `index`, keeping the object already there when its key is equal. */
const placeCard = (cards: TurnView['cards'], index: number, card: KeyedCard | null): TurnView['cards'] => {
  const current = cards[index]
  if (card && current && current.key === card.key) return cards
  const next = [...cards]
  next[index] = card
  return next
}

/** The terminal's cards, each reusing the live object with the same key. */
const settleCards = (cards: TurnView['cards'], final: readonly KeyedCard[]): KeyedCard[] => {
  const byKey = new Map(cards.filter((card): card is KeyedCard => Boolean(card)).map((card) => [card.key, card]))
  return final.map((card) => byKey.get(card.key) ?? card)
}

/** Every open row closed: the turn is over, nothing is still running. */
const closeSteps = (steps: TurnView['steps']): TurnView['steps'] =>
  Object.values(steps).every((step) => step.isComplete)
    ? steps
    : Object.fromEntries(Object.entries(steps).map(([id, step]) => [id, step.isComplete ? step : { ...step, isComplete: true }]))

const apply = (view: TurnView, event: WireEvent): TurnView => {
  switch (event.type) {
    case 'RUN_STARTED':
      return { ...view, messageId: event.message_id }
    case 'TEXT_MESSAGE_START':
      return { ...view, streaming: true }
    case 'TEXT_MESSAGE_CONTENT':
      return { ...view, streaming: true, text: view.text + event.delta }
    case 'TEXT_MESSAGE_END':
      return { ...view, streaming: false }
    case 'STATE_SNAPSHOT':
      return {
        ...view,
        text: event.snapshot.text,
        sources: event.snapshot.sources ?? [],
        answerMeta: event.snapshot.answer_meta ?? undefined,
      }
    case 'STEP_STARTED':
    case 'STEP_FINISHED':
      return foldStep(view, event)
    case 'RUN_FINISHED':
      return {
        ...view,
        phase: 'finished',
        outcome: event.outcome,
        result: event.result,
        streaming: false,
        text: event.result.text,
        sources: event.result.sources ?? [],
        answerMeta: event.result.answer_meta ?? undefined,
        cards: settleCards(view.cards, event.result.cards ?? []),
        interaction: undefined,
        steps: closeSteps(view.steps),
      }
    case 'RUN_ERROR':
      return {
        ...view,
        phase: 'failed',
        streaming: false,
        error: { code: event.code, message: event.message },
        interaction: undefined,
        steps: closeSteps(view.steps),
      }
    case 'CUSTOM':
      return applyCustom(view, event)
  }
}

const applyCustom = (view: TurnView, event: Extract<WireEvent, { type: 'CUSTOM' }>): TurnView => {
  switch (event.name) {
    case 'masthead':
      return { ...view, answerMeta: event.value.answer_meta }
    case 'card': {
      const { index, key, card } = event.value
      return { ...view, cards: placeCard(view.cards, index, { key, card }) }
    }
    case 'card_refused':
      return { ...view, cards: placeCard(view.cards, event.value.index, null) }
    case 'answer_retracted':
      return { ...view, streaming: false, text: '', sources: [], answerMeta: undefined, cards: [] }
    case 'heartbeat':
      return { ...view, lastBeatAt: event.ts, beatEveryMs: event.value.every_ms }
    case 'stage':
      return { ...view, stages: { ...view.stages, [event.value.stage]: event.value } }
    case 'interaction_request':
      return { ...view, interaction: event.value }
    case 'interaction_resolved':
      return view.interaction?.interaction_id === event.value.interaction_id ? { ...view, interaction: undefined } : view
    case 'rejected':
      return view
  }
}

/** One event folded into the turn's view. `view` undefined starts the turn from this event. */
export const foldTurnEvent = (view: TurnView | undefined, event: WireEvent): TurnView => {
  const current = view ?? initialTurnView(event.turn_id, event.conversation_id)
  if (event.seq === 0 || event.seq <= current.lastSeq) return current
  if (current.lastSeq > 0 && event.seq > current.lastSeq + 1) return current.gap ? current : { ...current, gap: true }
  return { ...apply(current, event), lastSeq: event.seq, gap: false }
}

export const foldTurnEvents = (view: TurnView | undefined, events: readonly WireEvent[]): TurnView | undefined =>
  events.reduce<TurnView | undefined>(foldTurnEvent, view)
