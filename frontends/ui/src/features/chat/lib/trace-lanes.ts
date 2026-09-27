/**
 * Trace lanes: what the evidence tools returned, as the Herleitung stores it.
 *
 * The backend builds every lane from its grounding records and ships it as
 * typed data on a `sources` step (docs/design/chat-wire-v2.md §a). Nothing here
 * parses text or classifies a URL. The fold (`turn-fold.ts`) stores the wire
 * lanes as `TraceLaneCard[]` once; `deriveTraceLanes` aggregates the stored
 * lanes of a turn's `sources` steps for the citation model (`lib/citations`),
 * which builds the documents every surface renders.
 */

import type { SourceSignal } from '@/features/layout/lib/source-presets'
import type { ThinkingTraceLane } from '../types'
import type { StoredThinkingStep } from './turn-fold'

/** One lane of a search's fan-out, as stored on a `sources` step. */
export type TraceLaneCard = ThinkingTraceLane
/** One document hit inside a lane. */
export type TraceSourceHit = ThinkingTraceLane['sources'][number]

/** Law first, then project, model, office, auto; within a signal by label. */
const SIGNAL_ORDER: Record<SourceSignal, number> = {
  law: 0,
  project: 1,
  model: 2,
  office: 3,
  auto: 4,
}

/**
 * Every lane the turn's `sources` steps returned, merged by lane key.
 *
 * Different steps are different tool calls, so a document two tools retrieved
 * counts twice: the hit tallies add up.
 */
export const deriveTraceLanes = (
  steps: readonly Pick<StoredThinkingStep, 'kind' | 'traceLanes'>[]
): TraceLaneCard[] => {
  const buckets = new Map<string, TraceLaneCard>()
  for (const step of steps) {
    if (step.kind !== 'sources') continue
    for (const card of step.traceLanes ?? []) {
      const existing = buckets.get(card.key)
      if (!existing) {
        buckets.set(card.key, { ...card, sources: [...card.sources] })
        continue
      }
      existing.hitCount += card.hitCount
      existing.sources.push(...card.sources)
    }
  }
  return Array.from(buckets.values()).sort(
    (a, b) =>
      SIGNAL_ORDER[a.signal] - SIGNAL_ORDER[b.signal] || a.label.localeCompare(b.label, 'de')
  )
}
