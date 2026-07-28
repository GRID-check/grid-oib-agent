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

import type { SourceSignal, SourceTint } from '@/features/layout/lib/source-presets'

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


// Fine lane family → coarse kind (mirror of backend `source_kinds.kind_for_lane`).
// The Herleitung fan-out and the chips MUST share this so they never disagree
// (e.g. external norms are `baurecht`, not `web`).
const LANE_KIND_PREFIXES: ReadonlyArray<readonly [string, SourceKind]> = [
  ['baurecht', 'baurecht'],
  ['behoerde', 'baurecht'],
  ['norm_extern', 'baurecht'],
  ['buero', 'buero'],
  ['projekt', 'projekt'],
  ['web', 'web'],
]

/** Map a fine lane stratum-key to its coarse SourceKind (fail-open to web). */
export const kindForLane = (lane: string | null | undefined): SourceKind => {
  const key = (lane ?? '').trim().toLowerCase()
  for (const [prefix, kind] of LANE_KIND_PREFIXES) {
    if (key === prefix || key.startsWith(`${prefix}_`)) return kind
  }
  return 'web'
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

/**
 * The `--source-*` family a source paints with.
 *
 * A refinement of `SourceSignal`, not a replacement: `law` covers the whole
 * Baurecht stratum, but OIB and RIS are the two tiers architects compare most
 * often and a fan-out that painted both the same blue was unreadable — the
 * authority badge alone had to carry the entire distinction. `oib` is that
 * stratum's accent; every other source keeps its signal untouched.
 *
 * Use this (never the bare signal) wherever a LANE is known, so the Herleitung
 * cards and the "Belegt durch" chips can never drift apart.
 */
export const accentForLane = (
  lane: string | null | undefined,
  signal: SourceTint
): SourceTint => ((lane ?? '').toLowerCase().startsWith('baurecht_oib') ? 'oib' : signal)
