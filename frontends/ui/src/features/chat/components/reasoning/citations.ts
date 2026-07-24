/**
 * Citation helpers for the Herleitung assessment node.
 *
 * `citationChips` collapses the flat streamed citation list into unique
 * per-lane provenance chips (mock has none real), and `ChoicePrompt` is the
 * live HITL multiple-choice payload rendered by the branches node. Both are
 * consumed by `ReasoningFlow`; extracted here so the graph no longer depends on
 * the retired plain-DOM node components.
 */

import type { SourceSignal } from '@/features/layout/lib/source-presets'
import { KIND_TO_SIGNAL, kindForLane, authorityTag, asSourceKind } from '../../lib/source-kinds'
import type { CitationSource } from '../../types'

export interface CitationChip {
  key: string
  label: string
  signal: SourceSignal
  authority: string | null
  url?: string
}

/** Collapse the flat citation list into unique lane chips (mock has none real). */
export const citationChips = (citations: CitationSource[]): CitationChip[] => {
  const byLane = new Map<string, CitationChip>()
  for (const c of citations) {
    const kind = asSourceKind(c.kind) ?? kindForLane(c.lane)
    const signal = KIND_TO_SIGNAL[kind]
    const label = c.laneLabel?.trim() || c.lane?.trim() || c.title?.trim() || kind
    const key = (c.lane || c.laneLabel || label).toLowerCase()
    if (!byLane.has(key)) {
      byLane.set(key, { key, label, signal, authority: authorityTag(c.lane), url: c.url })
    }
  }
  return Array.from(byLane.values())
}

/** A live HITL multiple-choice clarifier for the branches node. */
export interface ChoicePrompt {
  promptId: string
  text: string
  options: string[]
  isResponded: boolean
  selected?: string
}
