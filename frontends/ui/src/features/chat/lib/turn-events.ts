/**
 * Turn events — the steps where the agent SAYS what it is doing.
 *
 * Everything else in the thinking stream is observability: NAT turns LangChain
 * spans into frames and the UI guesses an activity by regex-matching internal
 * function names. These steps are the other direction — the backend authors one
 * German sentence per moment (`aiq_agent/common/turn_status.py`,
 * `aiq_agent/skills/events.py`) and ships it as an ordinary intermediate step.
 *
 * Three things about them break naive handling, and this module exists so each
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
 *    omitting `text` on them; `stepEventLiveText` checks both.
 *
 * A fourth trap is quieter: NAT runs `html.escape(…, quote=False)` over the
 * payload, and `&`, `<`, `>` are not JSON-structural — so `JSON.parse` succeeds
 * on the escaped form and hands back `Brand &amp; Rauch` as if it were the
 * sentence. It never throws, which is why `stepEventPayload` decides where the
 * decoding happened rather than leaving it to a parse failure.
 */

import {
  parseStepEventPayloads,
  stepEventLiveText,
  unescapeStepPayload,
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
 * Status slots hand over the backend's own German line verbatim: it names the
 * corpus being searched and quotes the query, which is information the frontend
 * simply does not have — `status:retrieval:0` says *Sucht im OIB-Wissen:
 * „Fluchtweglänge GK4“* where the old regex could only manage *Quellen werden
 * durchsucht …*.
 *
 * Skills go through `skillLiveText`, which additionally refuses a titleless
 * activation.
 */
export const turnEventLiveText = (step: TurnEventStep): string | null => {
  const name = step.functionName || ''
  if (isSkillStepName(name)) return skillLiveText(stepEventPayload(step))
  // The catalogue event is availability by definition and is emitted on the
  // technical channel; the guard below would already refuse it, but saying so
  // here keeps the rule visible where the reader of this file looks for it.
  if (isSkillSelectionStepName(name)) return null
  if (!isStatusStepName(name)) return null

  const payloads = parseStepEventPayloads(stepEventPayload(step))
  for (let i = payloads.length - 1; i >= 0; i -= 1) {
    const text = stepEventLiveText(payloads[i])
    if (text) return text
  }
  return null
}
