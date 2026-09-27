/**
 * Stored Herleitung rows for reader specs, built the way the app builds them:
 * wire events folded by `foldTurnEvents`, so a reader spec reads exactly what
 * the fold writes. Node-only (the recorded turns are read with `node:fs`).
 */
import {
  foldTurnEvents,
  type StoredThinkingStep,
  type TurnView,
} from '@/features/chat/lib/turn-fold'
import { eventOf, frameOf, wireEvents } from './wire-v2-fixtures'

const rowsOf = (view: TurnView | undefined): StoredThinkingStep[] =>
  view ? view.stepOrder.map((id) => view.steps[id]) : []

/** A running tool is a `STEP_STARTED`; every other step a `STEP_FINISHED`, as producers send them. */
const stepEvent = (seq: number, step: Record<string, unknown>) =>
  eventOf(
    frameOf(seq, {
      type:
        step.kind === 'tool' && (step.status ?? 'running') === 'running'
          ? 'STEP_STARTED'
          : 'STEP_FINISHED',
      step,
    })
  )

/** The rows a list of wire steps folds to: the same id replaces, first position kept. */
export const storedSteps = (steps: Record<string, unknown>[]): StoredThinkingStep[] =>
  rowsOf(
    foldTurnEvents(
      undefined,
      steps.map((step, i) => stepEvent(i + 1, step))
    )
  )

/** One stored row from a wire step as a producer writes it. */
export const storedStep = (step: Record<string, unknown>): StoredThinkingStep =>
  storedSteps([step])[0]

/** The stored rows of one recorded turn (`turn-answered.jsonl`, …). */
export const fixtureSteps = (file: string): StoredThinkingStep[] =>
  rowsOf(foldTurnEvents(undefined, wireEvents(file)))
