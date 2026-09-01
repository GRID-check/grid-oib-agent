/**
 * Turn events — the steps where the agent SAYS what it is doing.
 *
 * Everything else in the thinking stream is observability: NAT turns LangChain
 * spans into frames and the UI guesses an activity by regex-matching internal
 * function names. These steps are the other direction — the backend names one
 * moment per step (`aiq_agent/common/turn_status.py`,
 * `aiq_agent/skills/events.py`) and ships it as an ordinary intermediate step.
 *
 * It names it with a stable KEY plus interpolation VALUES, never with a
 * sentence: the words are this side's job, in whichever locale is reading. A
 * previous cut shipped finished German and rendered it verbatim, which is how
 * an English-locale reader ended up reading German.
 *
 * Four things about them break naive handling, and this module exists so each
 * is dealt with in one place:
 *
 * 1. **They are statuses, not work.** `status:retrieval:0` is a sentence about
 *    a retrieval, not a tool that ran, and `isFunctionStepName` reports them as
 *    top-level — so without an explicit rule they would land in the
 *    "Ausgeführt:" chip row under raw machine names, and `status:retrieval:0`
 *    would even match the corpus rule and duplicate the real tool's chip.
 * 2. **They are instantaneous.** Each is pushed as a balanced START/END pair
 *    with one UUID, so a status step is COMPLETE the moment it exists. The live
 *    line's "a finished step must never drive the phrase" rule is about a tool
 *    whose work is over; a status is a marker for what happens next, so it is
 *    exempt.
 * 3. **`channel` is a hard rule.** `technical` events belong to the opt-in
 *    panel and never to the live line. The backend enforces it structurally by
 *    omitting `key` on them; `stepEventLiveText` checks both.
 * 4. **An unknown key says nothing.** Keys are resolved against a closed set
 *    (`TURN_EVENT_KEYS` in the wire module). A key we cannot phrase renders
 *    NOTHING and the live line falls back to the previous meaningful phrase —
 *    never the raw key, never a title-cased identifier.
 *
 * A fifth trap is quieter: NAT runs `html.escape(…, quote=False)` over the
 * payload, and `&`, `<`, `>` are not JSON-structural — so `JSON.parse` succeeds
 * on the escaped form and hands back `Brand &amp; Rauch` as if it were the
 * sentence. It never throws, which is why `stepEventPayload` decides where the
 * decoding happened rather than leaving it to a parse failure.
 */

import {
  parseStepEventPayloads,
  stepEventLiveText,
  unescapeStepPayload,
  type StepEventPayload,
  type StepEventTranslator,
} from '@/adapters/api/step-event-schemas'
import {
  isSkillSelectionStepName,
  isSkillStepName,
  skillLiveText,
} from '@/features/skills/lib/skill-activity'

/** Step-name prefix of the status one-liners: `status:<slot>`. */
export const STATUS_STEP_PREFIX = 'status:'

const normalise = (functionName: string): string =>
  (functionName || '').trim().replace(/^tool:\s*/i, '').toLowerCase()

/** Whether a step's function name is one of the `status:<slot>` one-liners. */
export const isStatusStepName = (functionName: string): boolean =>
  normalise(functionName).startsWith(STATUS_STEP_PREFIX)

/**
 * Whether this step is a turn event at all — a status one-liner or one of the
 * skill events. These are the only steps allowed to speak on the live line
 * once the backend emits them.
 */
export const isTurnEventStepName = (functionName: string): boolean =>
  isStatusStepName(functionName) ||
  isSkillStepName(functionName) ||
  isSkillSelectionStepName(functionName)

/** The subset of a thinking step a turn event is read from. */
export interface TurnEventStep {
  functionName: string
  content?: string
  rawPayload?: string
  /**
   * The compact trail a pruned step carries in place of the payload it was
   * derived from. Present only after storage pruning; see `deriveSearchTrail`.
   */
  searchTrail?: Array<{ key: string; values?: Record<string, string> }>
}

/**
 * The step's payload text, decoded exactly once.
 *
 * `content` has already been through `formatPayload`, which strips the
 * adaptor's markdown wrapper AND decodes the HTML entities in one pass. Running
 * that again would double-unescape — `&amp;amp;`, a literal `&amp;` the sender
 * meant, would collapse to `&` — which is the very fault `formatPayload`'s
 * single-pass comment warns about. `rawPayload` is the untouched wire string,
 * so IT is the one that needs decoding, and only when we fall back to it.
 */
export const stepEventPayload = (step: TurnEventStep): string | undefined => {
  if (step.content && step.content.trim()) return step.content
  return step.rawPayload ? unescapeStepPayload(step.rawPayload) : undefined
}

/**
 * The sentence this step may show on the live line, or `null` for silence.
 *
 * A status slot hands over the key and the values; the dictionary supplies the
 * wording. The event still carries what the frontend cannot know — WHICH corpus
 * is being read and WHAT was asked — so `status:retrieval:0` still resolves to
 * *Sucht im OIB-Wissen: „Fluchtweglänge GK4“* (or *Searching the OIB knowledge
 * base: “Fluchtweglänge GK4”*) where the old regex could only manage *Quellen
 * werden durchsucht …*.
 *
 * Skills go through `skillLiveText`, which additionally refuses a titleless
 * activation.
 *
 * @param t a `chat`-namespace translator
 */
export const turnEventLiveText = (
  step: TurnEventStep,
  t: StepEventTranslator
): string | null => {
  const name = step.functionName || ''
  if (isSkillStepName(name)) return skillLiveText(stepEventPayload(step), t)
  // The catalogue event is availability by definition and is emitted on the
  // technical channel; the guard below would already refuse it, but saying so
  // here keeps the rule visible where the reader of this file looks for it.
  if (isSkillSelectionStepName(name)) return null
  if (!isStatusStepName(name)) return null

  const payloads = parseStepEventPayloads(stepEventPayload(step))
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    const text = stepEventLiveText(payloads[i], t)
    if (text) return text
  }
  return null
}

/** A retrieval the turn performed: what was asked, of which corpus. */
export interface SearchTrailEntry {
  key: string
  values?: Record<string, string>
}

/** Turn-event keys that name a retrieval — the ones worth keeping after the turn. */
const RETRIEVAL_KEY_RE = /(^|\.)retrieval(\.|$)/

/**
 * What the turn actually searched for, in the order it did.
 *
 * THE QUERY WAS ALREADY ON THE WIRE AND WAS BEING THROWN AWAY. The backend
 * states each retrieval as a key plus values — corpus and query — and the live
 * line renders it beautifully („Sucht OIB-Wissen: ‚Fluchtweglänge GK4'"). Then
 * the answer lands, the header says "Fertig", and every one of those sentences
 * is gone, leaving a row of bare tool nouns as the whole record of the search.
 *
 * Kept as key + values rather than as the sentence, so the phrasing is still
 * the reader's dictionary's job on every render — including after a reload in
 * a different language.
 *
 * Deduplicated on the rendered fact: the same query announced twice (a retry,
 * a re-emitted status) is one search to a reader.
 */
export const deriveSearchTrail = (
  steps: readonly TurnEventStep[]
): SearchTrailEntry[] => {
  const trail: SearchTrailEntry[] = []
  const seen = new Set<string>()

  const push = (entry: SearchTrailEntry) => {
    if (!RETRIEVAL_KEY_RE.test(entry.key)) return
    const identity = `${entry.key}|${JSON.stringify(entry.values ?? {})}`
    if (seen.has(identity)) return
    seen.add(identity)
    trail.push(entry)
  }

  for (const step of steps) {
    // A pruned step carries the trail already; an unpruned one carries the
    // payload it was derived from. Preferring the derived form keeps a reopened
    // conversation identical to the live one.
    if (step.searchTrail && step.searchTrail.length > 0) {
      for (const entry of step.searchTrail) push(entry)
      continue
    }
    if (!isStatusStepName(step.functionName || '')) continue
    for (const payload of parseStepEventPayloads(stepEventPayload(step))) {
      if (payload.channel === 'technical') continue
      const key = payload.key?.trim()
      if (key) push({ key, values: payload.values })
    }
  }

  return trail
}

/**
 * Where a truncated turn's chain stopped, or `null` if it was never truncated.
 *
 * The reader is told THAT the search stopped by the answer frame's
 * `research_truncated`. This is the other half — WHERE it stopped — and it
 * deliberately does not ride the answer frame with it: where the chain broke
 * off is a fact about the turn's process, the process is what the step stream
 * carries, and the Herleitung is built from that stream. The same fact on two
 * wires is two things to keep in agreement.
 *
 * `lastTool` is the last tool that RAN. Not "the tool it was about to run":
 * the ceiling is checked before the model is asked for anything, so nothing was
 * ever proposed and there is no next step to name. Claiming one would be
 * inventing the most interesting part of the record.
 */
export interface ResearchTruncation {
  lastTool?: string
}

/** Step slot the backend emits the budget record under (`status:budget`). */
const BUDGET_SLOT = 'budget'

/**
 * The NEWEST status payload a predicate accepts, or `null`.
 *
 * Newest-first because a turn can escalate and record twice, and the last word
 * on a fact is the one that describes the answer the reader is looking at. Only
 * `status:` steps are mined: an ordinary tool step that happens to serialise a
 * `slot` field is not a record the agent made about itself.
 */
const lastStatusPayload = (
  steps: TurnEventStep[],
  accept: (payload: StepEventPayload) => boolean
): StepEventPayload | null => {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (!step || !isStatusStepName(step.functionName || '')) continue
    for (const payload of parseStepEventPayloads(stepEventPayload(step))) {
      if (accept(payload)) return payload
    }
  }
  return null
}

export const researchTruncation = (steps: TurnEventStep[]): ResearchTruncation | null => {
  const payload = lastStatusPayload(
    steps,
    (p) => p.slot === BUDGET_SLOT && p.truncated === true
  )
  if (!payload) return null
  const tools = payload.tools?.filter((name) => name.trim().length > 0) ?? []
  const lastTool = tools.length > 0 ? tools[tools.length - 1] : undefined
  return lastTool ? { lastTool } : {}
}

// ── When the answer is weaker than a clean run ───────────────────────────────
//
// Two technical-channel records the backend keeps about a DEEP run, and the
// only two facts in this whole module that are about the answer's WORTH rather
// than about the turn's progress. Both were a `logger.warning` beside a
// `return` until recently: a deep run that ran out of clock, and an answer that
// shipped with nothing provably grounded behind it. Both looked exactly like a
// good answer from the outside, which is the observability hole these close.
//
// They stay on the technical channel — the live line narrates what is happening
// NEXT, and "this answer is thinner than it looks" is a verdict on what already
// happened. The Herleitung is where a verdict belongs, under the assessment
// node that already answers "what was this built on?".
//
// PRESENCE IS THE FACT. The backend emits these records only when they are
// true, so there is no "false" state to render: a turn that was not cut off
// carries no cutoff step, and reading `salvaged: false` as "nothing survived"
// is only ever done INSIDE a cutoff that happened.

/** Step slot the deep researcher's own cutoff record rides. */
const DEEP_BUDGET_SLOT = 'budget:deep'
/** Step slot the degradation record rides. */
const DEGRADED_SLOT = 'degraded'

/**
 * Why a deep run stopped early — the backend's stable tokens.
 *
 * A closed set, resolved the same way turn-event keys are: a token this build
 * does not know becomes `null` and the caller says the shorter, still-true
 * thing ("stopped early") rather than printing the token.
 */
export type DeepCutoffReason = 'wall_clock' | 'step_limit'
const DEEP_CUTOFF_REASONS: readonly string[] = ['wall_clock', 'step_limit']

export interface DeepResearchCutoff {
  /** `null` when the record named a reason this build cannot phrase. */
  reason: DeepCutoffReason | null
  /** Whether a report was recovered from the partial run. */
  salvaged: boolean
  /** Sources captured before the cutoff. Absent when the record omits it. */
  sourceCount?: number
  /** Wall-clock the run had spent. Absent when the record omits it. */
  elapsedSeconds?: number
}

/** A finite, non-negative number from an untyped payload field, or `undefined`. */
const countField = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/**
 * The deep run's cutoff record, or `null` when the run was never cut off.
 *
 * Its own slot rather than `status:budget`: a deep run is cut off by a wall
 * clock or a graph step limit, not by the tool-call ceiling that ends a shallow
 * one, and the frontend's name-based dedupe would collapse the two records into
 * one step if they shared a name.
 */
export const deepResearchCutoff = (steps: TurnEventStep[]): DeepResearchCutoff | null => {
  const payload = lastStatusPayload(
    steps,
    (p) => p.slot === DEEP_BUDGET_SLOT && p.truncated === true
  )
  if (!payload) return null
  const reason = payload.reason?.trim() ?? ''
  return {
    reason: DEEP_CUTOFF_REASONS.includes(reason) ? (reason as DeepCutoffReason) : null,
    // Strictly `true`: an absent field is not a salvage, and the difference
    // decides whether the panel says the partial findings reached the answer.
    salvaged: payload.salvaged === true,
    sourceCount: countField(payload.source_count),
    elapsedSeconds: countField(payload.elapsed_seconds),
  }
}

/**
 * Ways a finished answer is known to be weaker than a clean one.
 *
 * `no_report_file` — the writer never persisted a report, so what shipped is a
 * chat message wearing a report's clothes. `no_valid_citations` — citation
 * verification found nothing it could stand behind, so nothing in the answer is
 * provably grounded.
 */
export const ANSWER_DEGRADATIONS = ['no_report_file', 'no_valid_citations'] as const
export type AnswerDegradation = (typeof ANSWER_DEGRADATIONS)[number]

/**
 * Every degradation the turn recorded, in the backend's order, deduped.
 *
 * An empty array is the ordinary case and reads the same as "nothing to say".
 * A token outside the closed set is DROPPED rather than surfaced — the same
 * rule the live line applies to an unknown key, for the same reason: a raw
 * token on a caveat line is worse than a caveat line that is one item shorter.
 */
export const answerDegradations = (steps: TurnEventStep[]): AnswerDegradation[] => {
  const payload = lastStatusPayload(
    steps,
    (p) => p.slot === DEGRADED_SLOT && p.degraded === true
  )
  if (!payload) return []
  const raw = payload.reasons
  if (!Array.isArray(raw)) return []
  const out: AnswerDegradation[] = []
  for (const token of raw) {
    if (typeof token !== 'string') continue
    const reason = token.trim() as AnswerDegradation
    if (ANSWER_DEGRADATIONS.includes(reason) && !out.includes(reason)) out.push(reason)
  }
  return out
}
