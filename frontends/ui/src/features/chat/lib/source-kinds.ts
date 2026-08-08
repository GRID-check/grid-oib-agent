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

// ---------------------------------------------------------------------------
// Collection scope — the collection half of a document's identity
// ---------------------------------------------------------------------------
//
// Mirror of the backend `source_kinds.collection_scope` / `SCOPE_QUALIFIERS`.
// A document is `(collection, filename)` — the PRIMARY KEY of `document_metadata`
// and the only pair that is unique, because one knowledge_search fans out across
// the base corpus, the session collection and the project collections at once.
// A citation key cannot carry a raw collection id, so it carries the SCOPE.

/** The shelf a document sits on. A strict subset of SourceKind (never `web`). */
export type CollectionScope = Extract<SourceKind, 'baurecht' | 'buero' | 'projekt'>

const COLLECTION_SCOPE_PREFIXES: ReadonlyArray<readonly [string, CollectionScope]> = [
  ['archiv_', 'buero'],
  ['proj_', 'projekt'],
  ['s_', 'projekt'],
]

/** Scope owning a retrieval collection; undefined when there is no collection. */
export const collectionScope = (
  collection: string | null | undefined
): CollectionScope | undefined => {
  const key = (collection ?? '').trim().toLowerCase()
  if (!key) return undefined
  for (const [prefix, scope] of COLLECTION_SCOPE_PREFIXES) {
    if (key.startsWith(prefix)) return scope
  }
  // A named collection that is neither project/session nor Archiv is the base
  // knowledge corpus (matches `lane_for_hit`'s final `if collection` branch).
  return 'baurecht'
}

/**
 * Scope → the qualifier a citation key uses (`Plan.pdf (Projektwissen), p.3`).
 * These strings are part of persisted citation keys — changing one invalidates
 * keys in messages already written. Kept byte-identical to the backend's
 * `SCOPE_QUALIFIERS`, which a parity test enforces.
 */
export const SCOPE_QUALIFIERS: Record<CollectionScope, string> = {
  buero: 'Büroarchiv',
  projekt: 'Projektwissen',
  baurecht: 'Basiswissen',
}

/** Inverse of SCOPE_QUALIFIERS — parse a citation key's qualifier back to a scope. */
export const scopeForQualifier = (
  qualifier: string | null | undefined
): CollectionScope | undefined => {
  const key = (qualifier ?? '').trim().toLowerCase()
  return (Object.keys(SCOPE_QUALIFIERS) as CollectionScope[]).find(
    (scope) => SCOPE_QUALIFIERS[scope].toLowerCase() === key
  )
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
  // `baurecht_basis` is the lane of the DEFAULT doc_class ("sonstiges") — a
  // document nobody has classified yet. It must not inherit the `baurecht`
  // prefix's RIS badge: every unclassified upload would then claim to be an
  // Austrian legal source, which is the strongest provenance claim this UI can
  // make and the one an architect is most entitled to trust.
  if (key === 'baurecht_basis') return null
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
