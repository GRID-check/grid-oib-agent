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
 * Citation-key qualifiers — the READER's side of a key's disambiguating suffix.
 *
 * Two different things used to be the same string. The SHELF now travels as data
 * on the payload; nothing here is how a consumer learns it. What survives is the
 * citation KEY, which is a human-readable identity (`Plan.pdf (Büroarchiv),
 * p.3`) and still carries a qualifier when one filename was retrieved from more
 * than one shelf in the same turn — otherwise two different `Plan.pdf`s would
 * share a key. This table is what a reader must strip to recover the filename,
 * and the shelf each qualifier names is a FALLBACK for payloads that carry no
 * shelf field (every message persisted before ADR-0047).
 *
 * FROZEN wire values, pinned byte-for-byte against the backend's writer, and
 * deliberately independent of {@link shelfLabel}: display copy may be reworded
 * freely, these may not — renaming a label must not change what a stored key
 * parses to, nor what today's keys strip to.
 */
export const CITATION_KEY_QUALIFIERS: ReadonlyArray<readonly [qualifier: string, shelf: Shelf]> = [
  ['Büroarchiv', 'archiv'],
  ['Projektwissen', 'project'],
  ['Basiswissen', 'base'],
  // `session` DOES appear in keys written from ADR-0047 onward, even though no
  // legacy key can contain it. The qualifier is not purely a legacy artefact:
  // the backend still appends one to disambiguate a citation key when two
  // retrieved files share a name across shelves (`_ambiguous_file_names`), so
  // this list is the vocabulary a WRITER can emit, and a reader that knows only
  // the legacy three fails to strip `(Private Sitzung)` — the key then misses
  // `FILENAME_RE` and the whole citation resolves to null.
  //
  // So: German is rendering for DISPLAY (see `shelfLabel`), but a citation key
  // is a human-readable identity and still carries a qualifier to stay unique.
  // Both runtimes must agree on this set; `shelfLabel` may be reworded freely,
  // this may not.
  ['Private Sitzung', 'session'],
]

/**
 * Parse a citation key's qualifier back to a shelf — the VERSIONED FALLBACK.
 *
 * Only ever a fallback: a payload that carries the shelf explicitly must be read
 * from that field, never from this, and every consumer here does. It exists for
 * the two cases where no field is available — a message persisted before
 * ADR-0047, and a key whose qualifier is all the wire left behind. Unknown
 * qualifiers yield undefined: unattributed, never a default shelf.
 */
export const scopeForQualifier = (qualifier: string | null | undefined): Shelf | undefined => {
  const key = (qualifier ?? '').trim().toLowerCase()
  if (!key) return undefined
  return CITATION_KEY_QUALIFIERS.find(([label]) => label.toLowerCase() === key)?.[1]
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
