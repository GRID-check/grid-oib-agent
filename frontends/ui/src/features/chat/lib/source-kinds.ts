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
 *
 * A THIRD, separate axis lives at the bottom of this file: the {@link Shelf} a
 * document sits on (ADR-0047) — "whose document is this?". It is neither
 * derived from nor merged into the display taxonomy above.
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
// Shelf — WHERE a document sits (ADR-0047)
// ---------------------------------------------------------------------------
//
// The shelf TRAVELS AS DATA. It is carried explicitly by the scope header, the
// chunk metadata and the citation payload; nothing here derives it from a
// collection-id prefix (`archiv_` / `proj_` / `s_`) and nothing parses it back
// out of a German label. The prefix table that used to live at this spot
// (`COLLECTION_SCOPE_PREFIXES`) is deleted — its absence is ADR-0047's
// acceptance test, because while it existed the shelf was still a guess.
//
// SHELF ≠ SOURCE KIND. They are two axes and conflating them is what produced
// the defects the ADR names:
//
//   Shelf      — whose document is this / which collection retrieval searched.
//                `archiv | project | session | base`.
//   SourceKind — the ADR-0026 DISPLAY taxonomy driving chip colour and badge:
//                `baurecht | buero | projekt | web`.
//
// A `projekt`-kind document can sit on the `session` shelf (a file the user
// dropped into the chat); a `baurecht`-kind document sits on `base`. Neither
// enum is derivable from the other, so neither is defined in terms of the other.

/** The four shelves a retrieved chunk can come from. */
export type Shelf = 'archiv' | 'project' | 'session' | 'base'

/** Every shelf, for iteration. Kept in step with {@link Shelf} by `satisfies`. */
export const SHELVES = ['archiv', 'project', 'session', 'base'] as const satisfies readonly Shelf[]

const SHELF_SET: ReadonlySet<string> = new Set<string>(SHELVES)

/**
 * Narrow an untrusted wire value to a Shelf, else undefined.
 *
 * Unknown reads as UNKNOWN and renders unattributed. It is never defaulted to
 * `base` (nor to the old `baurecht`): the predecessor of this function failed
 * OPEN, so an unrecognised collection claimed to be authoritative base law —
 * the strongest provenance claim this UI can make.
 */
export const asShelf = (value: string | null | undefined): Shelf | undefined => {
  const key = (value ?? '').trim().toLowerCase()
  return SHELF_SET.has(key) ? (key as Shelf) : undefined
}

/**
 * Exhaustiveness guard. A shelf added to {@link Shelf} without a case in every
 * switch below is a COMPILE error here, not a silent fallthrough at runtime.
 */
const unhandledShelf = (shelf: never): never => {
  throw new Error(`Unhandled shelf: ${String(shelf)}`)
}

/**
 * Shelf → German label. **Rendering only** (ADR-0047 §5: German is rendering,
 * never transport). Nothing persists these strings any more, so renaming one is
 * a copy change and no longer invalidates citation keys already written.
 *
 * `session` gets its OWN label: a file the user attached privately to a chat
 * used to be cited as "Projektwissen", because `('s_', 'projekt')` was the only
 * guess the prefix table could offer. It is the same wording the upload target
 * uses ("Private Sitzung", `de/research.ts`), so the citation now agrees with
 * what the user was told when the file went up.
 */
export const shelfLabel = (shelf: Shelf): string => {
  switch (shelf) {
    case 'archiv':
      return 'Büroarchiv'
    case 'project':
      return 'Projektwissen'
    case 'session':
      return 'Private Sitzung'
    case 'base':
      return 'Basiswissen'
    default:
      return unhandledShelf(shelf)
  }
}

/**
 * LEGACY citation-key qualifiers — a versioned READER, not a writer.
 *
 * Before ADR-0047 the shelf reached the frontend only as a German qualifier
 * inside a citation key (`Plan.pdf (Projektwissen), p.3`), which made display
 * copy a wire format. New payloads carry the shelf as data; these three strings
 * are FROZEN wire values kept solely so keys persisted in old messages still
 * resolve. They are deliberately independent of {@link shelfLabel}: renaming a
 * label must not change what a stored key parses to.
 *
 * There is no `session` entry and there never will be — the legacy writer could
 * not express that shelf, which is precisely the bug ADR-0047 fixes.
 */
export const LEGACY_SCOPE_QUALIFIERS: ReadonlyArray<readonly [qualifier: string, shelf: Shelf]> = [
  ['Büroarchiv', 'archiv'],
  ['Projektwissen', 'project'],
  ['Basiswissen', 'base'],
]

/**
 * Parse a LEGACY citation key's qualifier back to a shelf.
 *
 * Only ever a fallback for keys already written: a payload that carries the
 * shelf explicitly must be read from that field, never from this. Unknown
 * qualifiers yield undefined — unattributed, never a default shelf.
 */
export const scopeForQualifier = (qualifier: string | null | undefined): Shelf | undefined => {
  const key = (qualifier ?? '').trim().toLowerCase()
  if (!key) return undefined
  return LEGACY_SCOPE_QUALIFIERS.find(([label]) => label.toLowerCase() === key)?.[1]
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
