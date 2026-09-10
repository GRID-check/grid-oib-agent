/**
 * Retrieval ROUNDS for the Herleitung spine.
 *
 * The live line replaces: `status:retrieval:0` is overwritten by
 * `status:retrieval:1` the moment the model searches again. The graph needs
 * the opposite — every round kept, in order — so a second search is a new
 * layer, not a mutated caption.
 *
 * Round identity is the slot in the step name (`status:retrieval:N`). The
 * persisted `turnEvent` (key + values) is the sentence the node can speak
 * after storage prune has dropped the payload. Requery is a different slot
 * (`status:retrieval:requery`) and is not a round.
 */

import { turnEventOf, type TurnEventStep } from './turn-events'

export interface RetrievalRound {
  index: number
  key: string
  values?: Record<string, string>
}

const RETRIEVAL_SLOT = /^status:retrieval:(\d+)$/i

const slotName = (functionName: string): string =>
  (functionName || '').trim().replace(/^tool:\s*/i, '')

/** Ordered retrieval rounds that actually spoke (live key + values). */
export const retrievalRounds = (steps: TurnEventStep[]): RetrievalRound[] => {
  const byIndex = new Map<number, RetrievalRound>()
  for (const step of steps) {
    const match = RETRIEVAL_SLOT.exec(slotName(step.functionName || ''))
    if (!match) continue
    const index = Number(match[1])
    const event = turnEventOf(step)
    const key = event?.key?.trim()
    if (!key) continue
    byIndex.set(index, event.values ? { index, key, values: event.values } : { index, key })
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index)
}
