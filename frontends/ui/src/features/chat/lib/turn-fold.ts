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
 *   authoritative for all four, except after a Stop pressed on this page,
 *   which keeps what was on screen (`stoppedHere`).
 */

import type { ShownAnswer, TurnResult, WireEvent } from '@/adapters/api/wire-v2'
import type { StoredThinkingStep, TraceLaneCard } from '@/lib/conversations/message-provenance'
import type { ChatEffort } from '@/lib/reasoning-settings/catalog'
import { KIND_TO_SIGNAL, asShelf } from './source-kinds'
import { sharedPrefixChars, stoppedAnswer } from './stopped-answer'

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
  /**
   * The last snapshot's text, while `text` is still that snapshot or grows
   * from it: its `[N]` resolve to `sources`. What a Stop keeps of a streamed
   * text differs from a settled one (`stopped-answer.ts`).
   */
  settled?: string
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
  /**
   * The Aufwand the asker sent this turn with. The one field not folded from
   * the wire: it is what this browser said in `user_message`, set when it
   * opens the turn (`beginTurn`), so only the asker's view carries it. The
   * projection prefers `result.reasoning_effort`, the level the turn resolved
   * to server-side, once the terminal reports one.
   */
  effort?: ChatEffort
  /**
   * The text on screen when the reader pressed Stop on this page
   * (`stopTurnView`). Kept whole, before the cut, because a terminal that
   * crossed the Stop is cut again against it.
   */
  shownAtStop?: string
  /**
   * The Stop crossed the server's finished answer: the server stored all of
   * it, and the store asks the BFF to cut that row to what was on screen
   * (`cutStoppedAnswer`).
   */
  stoppedLate?: boolean
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

/**
 * The reader pressed Stop on this page (`stopStreaming` marks the view
 * cancelled before the server has said anything) and the terminal has not
 * landed yet. What was on screen at the press is the answer: the deltas still
 * in flight and the cancelled terminal's text, sources, masthead and cards
 * (everything the model had written) are not taken. Only the asker's own
 * view is ever in this state; a replay or a spectator folds the terminal as
 * the server sent it.
 */
const stoppedHere = (view: TurnView): boolean => view.outcome === 'cancelled' && !view.result

/** What an event adds to the answer itself, as opposed to the turn around it. */
const CONTENT_EVENTS: ReadonlySet<string> = new Set([
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  'STATE_SNAPSHOT',
  'masthead',
  'card',
  'card_refused',
  'answer_retracted',
])

/** `next` when it holds the same cards as `cards`, so a cut that kept them all keeps the array. */
const sameCards = <T>(cards: T[], next: T[]): T[] =>
  cards.length === next.length && cards.every((card, index) => card === next[index]) ? cards : next

/**
 * The view a Stop pressed on this page leaves, and the position the cancel
 * names. `shown` is the text the reveal had on screen; a reveal that is not a
 * prefix of the view's text (a snapshot replaced the stretch it was showing)
 * counts as the whole text, as the server reads the same position.
 *
 * The answer is cut by the rule the server applies (`stopped-answer.ts`): the
 * row this browser writes and the one the server writes are the same bytes,
 * whichever lands first.
 */
export const stopTurnView = (view: TurnView, shown: string | undefined): { view: TurnView; shown: ShownAnswer } => {
  const onScreen = shown !== undefined && view.text.startsWith(shown) ? shown : view.text
  const chars = Array.from(onScreen).length
  const kept = stoppedAnswer({ text: view.text, settled: view.settled, sources: view.sources, cards: view.cards }, chars)
  const stopped: TurnView = {
    ...view,
    text: kept.text,
    sources: kept.sources,
    cards: sameCards(view.cards, kept.cards),
    phase: 'finished',
    outcome: 'cancelled',
    streaming: false,
    interaction: undefined,
    shownAtStop: onScreen,
  }
  return { view: stopped, shown: { seq: view.lastSeq, chars } }
}

/**
 * A terminal other than the cancelled one reached a view stopped here: the
 * server had finished before the Stop reached it (it answers the cancel with
 * `turn_not_found`) and stored the whole answer. The answer becomes that
 * result cut where the text on screen and the result part, by the same rule
 * the BFF applies to the stored row, so the two agree byte for byte.
 */
const stoppedLate = (view: TurnView, result: TurnResult): TurnView => {
  const chars = sharedPrefixChars(view.shownAtStop ?? view.text, result.text)
  const kept = stoppedAnswer(
    { text: result.text, settled: result.text, sources: result.sources ?? [], cards: result.cards ?? [] },
    chars
  )
  return {
    ...view,
    text: kept.text,
    sources: kept.sources,
    answerMeta: result.answer_meta ?? undefined,
    cards: settleCards(view.cards, kept.cards),
    stoppedLate: true,
  }
}

const afterLocalStop = (view: TurnView, event: WireEvent): TurnView | undefined => {
  if (event.type === 'RUN_FINISHED') {
    const closed = { ...view, result: event.result, steps: closeSteps(view.steps) }
    // A turn that answered somewhere else (a commissioned run, a queue
    // refusal) has no answer here to cut.
    const elsewhere = Boolean(event.result.run || event.result.job_admission_rejected)
    return event.outcome === 'cancelled' || elsewhere ? closed : stoppedLate(closed, event.result)
  }
  // The run failing after the reader stopped it (the cancel tearing down a
  // tool call, a stream cut on the way out) is not news to them: the answer
  // they stopped stays stopped, not dimmed under an error card.
  if (event.type === 'RUN_ERROR') return { ...view, steps: closeSteps(view.steps) }
  return CONTENT_EVENTS.has(event.type === 'CUSTOM' ? event.name : event.type) ? view : undefined
}

const apply = (view: TurnView, event: WireEvent): TurnView => {
  const stopped = stoppedHere(view) ? afterLocalStop(view, event) : undefined
  if (stopped) return stopped
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
        settled: event.snapshot.text,
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
    // A type, step kind or CUSTOM name from a server newer than this bundle:
    // passed over, so its seq still counts and the turn stays continuous.
    case 'UNKNOWN':
      return view
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
      return { ...view, streaming: false, text: '', settled: undefined, sources: [], answerMeta: undefined, cards: [] }
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
