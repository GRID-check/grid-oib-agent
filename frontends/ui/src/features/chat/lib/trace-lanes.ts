/**
 * Trace lanes: what the evidence tools returned, as the Herleitung stores it.
 *
 * The backend builds every lane from its grounding records and ships it as
 * typed data on a `sources` step (docs/design/chat-wire-v2.md §a). Nothing here
 * parses text or classifies a URL. `laneCardsOf` turns the wire lanes into the
 * stored `TraceLaneCard[]` once, when the step is folded; `deriveTraceLanes`
 * aggregates the stored lanes of a turn's `sources` steps for the citation
 * model (`lib/citations`), which builds the documents every surface renders.
 */

import type { z } from 'zod'
import type { traceLaneSchema } from '@/adapters/api/wire-v2'
import type { SourceSignal } from '@/features/layout/lib/source-presets'
import type { ThinkingTraceLane } from '../types'
import type { StoredThinkingStep } from './turn-events'
import { KIND_TO_SIGNAL, asShelf } from './source-kinds'

/** One lane of a search's fan-out, as stored on a `sources` step. */
export type TraceLaneCard = ThinkingTraceLane
/** One document hit inside a lane. */
export type TraceSourceHit = ThinkingTraceLane['sources'][number]

type WireTraceLane = z.infer<typeof traceLaneSchema>

/** The stored lane cards of one wire `sources` step. Called by the fold, never during a render. */
export const laneCardsOf = (lanes: readonly WireTraceLane[]): TraceLaneCard[] =>
  lanes.map((lane) => ({
    key: lane.key,
    label: lane.label,
    hitCount: lane.hit_count,
    kind: lane.kind,
    signal: KIND_TO_SIGNAL[lane.kind],
    sources: lane.sources.map((source) => {
      const shelf = asShelf(source.shelf)
      return {
        name: source.name,
        ...(source.title ? { title: source.title } : {}),
        ...(source.detail ? { detail: source.detail } : {}),
        ...(shelf ? { shelf } : {}),
        ...(source.round != null ? { round: source.round } : {}),
      }
    }),
  }))

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
