/**
 * Canonical source-kind taxonomy — frontend mirror of the backend
 * `src/aiq_agent/common/source_kinds.py` (ADR-0026).
 *
 * The coarse KIND drives the chip **color** (the provenance/trust family:
 * Baurecht / Büroarchiv / Projektwissen / Web — one of the `--source-*` tint
 * families). The fine LANE drives an **authority badge** (OIB / RIS / ÖNORM)
 * shown on the chip and in the popover: the OIB-vs-RIS distinction an architect
 * needs (binding law vs. an adopted technical guideline vs. an external
 * standard). Color = "how much can I trust this?"; badge = "which rung of the
 * authority ladder?".
 */

import type { SourceSignal } from '@/features/layout/lib/source-presets'

/** The four coarse source kinds every source renders through. */
export type SourceKind = 'baurecht' | 'buero' | 'projekt' | 'web'

const SOURCE_KINDS: ReadonlySet<SourceKind> = new Set(['baurecht', 'buero', 'projekt', 'web'])

/** Narrow an untrusted wire value to a SourceKind, else undefined. */
export const asSourceKind = (value: string | null | undefined): SourceKind | undefined =>
  value && SOURCE_KINDS.has(value as SourceKind) ? (value as SourceKind) : undefined

/**
 * Coarse kind → the `--source-*` tint family (`SourceSignal`). This is the one
 * mapping that fixes the old `kb → project` mislabel: the OIB corpus is
 * `baurecht`, so it now renders in the law family, identically to RIS.
 */
export const KIND_TO_SIGNAL: Record<SourceKind, SourceSignal> = {
  baurecht: 'law',
  buero: 'office',
  projekt: 'project',
  web: 'auto',
}

/**
 * Compact authority tag within the Baurecht family, derived from the fine lane
 * (`norm_registry.lane_for_hit`). Returns null when no meaningful tier applies
 * (office/project/web sources carry no authority tag — their kind is the whole
 * story). The fuller tier ("OIB-Richtlinie", "Bundesrecht") travels as
 * `laneLabel` for the popover.
 */
export const authorityTag = (lane: string | null | undefined): string | null => {
  const key = (lane ?? '').toLowerCase()
  if (key.startsWith('baurecht_oib')) return 'OIB'
  if (key === 'norm_extern') return 'ÖNORM'
  if (key === 'behoerde') return 'Behörde'
  if (key.startsWith('baurecht')) return 'RIS' // baurecht_ris / _bund / _land / _verordnung
  return null
}
