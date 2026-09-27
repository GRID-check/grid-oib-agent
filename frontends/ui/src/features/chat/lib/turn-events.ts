/**
 * Turn events — the steps where the agent SAYS what it is doing.
 *
 * Every Herleitung row is a typed `StoredThinkingStep` (`turn-fold.ts`,
 * docs/design/chat-wire-v2.md §e.4). These readers switch on its `kind`: the
 * live line, and the technical records about where the turn stopped and what
 * the answer is worth.
 *
 * The wire carries KEYS, not sentences; the words come from this side's
 * dictionary (`turn-event-keys.ts`). `channel: technical` records belong to the
 * opt-in panel and never to the live line: the fold keeps a `turnEvent` only
 * for a live step that carries a key, so a technical record has nothing to
 * render.
 */

import type { StoredThinkingStep } from './turn-fold'
import { stepEventLiveText, type StepEventTranslator } from './turn-event-keys'

/**
 * The live line: the newest step whose turn event this UI can phrase, or
 * `null` (the caller then shows its generic working copy). A key this build
 * cannot phrase is skipped, never printed; a finished status still speaks,
 * because it marks what happens NEXT.
 *
 * @param t a `chat`-namespace translator
 */
export const liveLine = (
  steps: readonly Pick<StoredThinkingStep, 'turnEvent'>[],
  t: StepEventTranslator
): string | null => {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const text = stepEventLiveText(steps[i], t)
    if (text) return text
  }
  return null
}

type StatusRow = Pick<StoredThinkingStep, 'kind' | 'slot' | 'detail'>
type Detail = NonNullable<StoredThinkingStep['detail']>

/**
 * The detail of the NEWEST status record in one of `slots`, or `null`.
 *
 * Newest-first because a turn can record twice, and the last word on a fact is
 * the one that describes the answer the reader is looking at.
 */
const lastStatusDetail = (steps: readonly StatusRow[], slots: readonly string[]): Detail | null => {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]
    if (step.kind === 'status' && step.slot && slots.includes(step.slot) && step.detail) {
      return step.detail
    }
  }
  return null
}

/** A string list from a detail field, blanks dropped. */
const stringsOf = (value: Detail[string] | undefined): string[] =>
  Array.isArray(value) ? value.map((item) => item.trim()).filter(Boolean) : []

/** A finite, non-negative number from a detail field, or `undefined`. */
const countOf = (value: Detail[string] | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/**
 * Where a truncated turn's chain stopped, or `null` if it was never truncated.
 *
 * The answer's `research_truncated` tells the reader THAT the search stopped;
 * this is WHERE. `lastTool` is the last tool that RAN, never one it was about
 * to run: the ceiling is checked before the model proposes anything.
 */
export interface ResearchTruncation {
  lastTool?: string
}

/** `budget` is the round ceiling, `budget:input` the input-token ceiling. */
const BUDGET_SLOTS: readonly string[] = ['budget', 'budget:input']

export const researchTruncation = (steps: readonly StatusRow[]): ResearchTruncation | null => {
  const detail = lastStatusDetail(steps, BUDGET_SLOTS)
  if (detail?.truncated !== true) return null
  const tools = stringsOf(detail.tools)
  return tools.length > 0 ? { lastTool: tools[tools.length - 1] } : {}
}

// ── When the answer is weaker than a clean run ───────────────────────────────
//
// Two technical records the backend keeps about a DEEP run: a run that ran out
// of clock, and an answer that shipped with nothing provably grounded behind
// it. They stay off the live line (it narrates what happens NEXT); the
// Herleitung is where a verdict on what already happened belongs.
//
// PRESENCE IS THE FACT. The backend emits these records only when they are
// true, so there is no "false" state to render.

/** Why a deep run stopped early. A token this build does not know becomes `null`. */
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

/** The deep run's cutoff record (`budget:deep`), or `null` when the run was never cut off. */
export const deepResearchCutoff = (steps: readonly StatusRow[]): DeepResearchCutoff | null => {
  const detail = lastStatusDetail(steps, ['budget:deep'])
  if (detail?.truncated !== true) return null
  const reason = typeof detail.reason === 'string' ? detail.reason.trim() : ''
  return {
    reason: DEEP_CUTOFF_REASONS.includes(reason) ? (reason as DeepCutoffReason) : null,
    // Strictly `true`: an absent field is not a salvage.
    salvaged: detail.salvaged === true,
    sourceCount: countOf(detail.source_count),
    elapsedSeconds: countOf(detail.elapsed_seconds),
  }
}

/**
 * Ways a finished answer is known to be weaker than a clean one.
 *
 * `no_report_file` — the writer never persisted a report. `no_valid_citations`
 * — nothing in the answer is provably grounded. `cards_generation_failed` —
 * the report is whole, but its proposals could not be produced.
 * `grundlage_unread` — a document the reader named as Grundlage was never read.
 */
export const ANSWER_DEGRADATIONS = [
  'no_report_file',
  'no_valid_citations',
  'cards_generation_failed',
  'grundlage_unread',
] as const
export type AnswerDegradation = (typeof ANSWER_DEGRADATIONS)[number]

/**
 * Every degradation the turn recorded, in the backend's order, deduped. A
 * token outside the closed set is DROPPED rather than surfaced.
 */
export const answerDegradations = (steps: readonly StatusRow[]): AnswerDegradation[] => {
  const detail = lastStatusDetail(steps, ['degraded'])
  if (detail?.degraded !== true) return []
  const out: AnswerDegradation[] = []
  for (const token of stringsOf(detail.reasons)) {
    const reason = token as AnswerDegradation
    if (ANSWER_DEGRADATIONS.includes(reason) && !out.includes(reason)) out.push(reason)
  }
  return out
}
