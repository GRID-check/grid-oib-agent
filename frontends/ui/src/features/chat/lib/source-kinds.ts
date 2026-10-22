/**
 * Canonical source-kind taxonomy — frontend mirror of the backend
 * `src/aiq_agent/common/source_kinds.py` (ADR-0026).
 *
 * The coarse KIND drives the chip **color** (the provenance/trust family:
 * Baurecht / Büroablage / Projektwissen / Web — one of the `--source-*` tint
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

/**
 * The five coarse source kinds every source renders through.
 *
 * `measurement` is the odd one out: the other four are RETRIEVED PASSAGES, a
 * measurement is a value read off the project's BIM model. It carries no page,
 * no document and nothing to preview — and instead carries the GlobalIds it was
 * derived from, the operator expression, a tolerance and a provenance, which is
 * a stronger audit trail than a quotation. It is a kind here so every surface
 * that already renders off `kind` picks it up; it is deliberately NOT a
 * citation on the backend (`aiq_agent/tools/bim/measurement_sources.py`).
 */
export type SourceKind = 'building_law' | 'office' | 'project' | 'web' | 'measurement'

const SOURCE_KINDS: ReadonlySet<SourceKind> = new Set([
  'building_law',
  'office',
  'project',
  'web',
  'measurement',
])

/**
 * The German kinds a stored citation, a trace lane or an older pod's wire still
 * carries. Read-only: nothing writes these, `modernizeSourceKind` maps them on
 * the way in.
 */
export const LEGACY_SOURCE_KIND: Readonly<Record<string, SourceKind>> = {
  baurecht: 'building_law',
  buero: 'office',
  projekt: 'project',
  messung: 'measurement',
}

/** A kind (or lane-kind) value spelled the English way, whichever spelling it came in. */
export const modernizeSourceKind = (value: string | null | undefined): string | null | undefined =>
  value && Object.hasOwn(LEGACY_SOURCE_KIND, value) ? LEGACY_SOURCE_KIND[value] : value

/**
 * The German fine-lane keys, as exact keys. A lane is `<family>[_<tier>]`, so the
 * mapping is on whole keys: the OIB tiers are named, the family prefix alone
 * is the fallback for a tier this table has not met.
 */
export const LEGACY_LANE: Readonly<Record<string, string>> = {
  baurecht: 'building_law',
  baurecht_oib: 'building_law_oib',
  baurecht_oib_leitfaden: 'building_law_oib_guide',
  baurecht_oib_erlaeuterung: 'building_law_oib_explanatory_note',
  baurecht_oib_begriffe: 'building_law_oib_definitions',
  baurecht_oib_referenz: 'building_law_oib_reference',
  baurecht_oib_diff: 'building_law_oib_amendment',
  baurecht_ris: 'building_law_ris',
  baurecht_basis: 'building_law_base',
  baurecht_bund: 'building_law_federal',
  baurecht_land: 'building_law_state',
  baurecht_verordnung: 'building_law_ordinance',
  behoerde: 'authority',
  norm_extern: 'external_standard',
  buero: 'office',
  buero_piloti: 'office_piloti',
  projekt: 'project',
  messung: 'measurement',
}

/** A lane key spelled the English way, whichever spelling it came in. */
export const modernizeLane = (value: string | null | undefined): string | null | undefined => {
  if (!value) return value
  const key = value.trim().toLowerCase()
  return Object.hasOwn(LEGACY_LANE, key) ? LEGACY_LANE[key] : value
}

/** Narrow an untrusted wire value to a SourceKind, else undefined. */
export const asSourceKind = (value: string | null | undefined): SourceKind | undefined =>
  value && SOURCE_KINDS.has(value as SourceKind) ? (value as SourceKind) : undefined

/**
 * Coarse kind → the `--source-*` tint family (`SourceSignal`). This is the one
 * mapping that fixes the old `kb → project` mislabel: the OIB corpus is
 * `building_law`, so it now renders in the law family, identically to RIS.
 */
export const KIND_TO_SIGNAL: Record<SourceKind, SourceSignal> = {
  building_law: 'law',
  office: 'office',
  project: 'project',
  web: 'auto',
  // Its own family, not `project`. A measurement is about the BUILDING, not
  // about a document filed under the project, and painting it in the project
  // green would put a reproducible number in the same colour as the PDF it
  // contradicts.
  measurement: 'model',
}

/**
 * The fine lane of a PUBLISHED, human-approved, agent-authored document —
 * mirror of the backend `source_kinds.AGENT_AUTHORED_LANE`.
 *
 * Its coarse kind is `office`: it IS office knowledge, painted in the office
 * colour, and the lane is the sub-label inside that kind. The distinction the
 * lane carries is "Piloti wrote this and the office released it" versus "a
 * person in the office wrote it" — and the backend decides it from the stated
 * PROVENANCE (`authored_by: agent`) before the shelf is consulted, so a
 * document filed on the project shelf keeps its author instead of arriving as
 * Projektwissen.
 *
 * The label is the SUB-LABEL only. Who approved it, and when, travel as data
 * (`provenance` on the Trace-Lanes source), so a renderer appends the approver
 * in the reader's own locale rather than parsing him out of a German sentence.
 */
export const AGENT_AUTHORED_LANE = 'office_piloti'
export const AGENT_AUTHORED_LANE_LABEL = 'Piloti-Dokument'

/**
 * The fine lanes of a filed E-Mail-Verlauf — mirror of the backend
 * `source_kinds.MAIL_LANE` / `OFFICE_MAIL_LANE` / `MAIL_LANE_LABEL`, decided in
 * `norm_registry.lane_for_hit` from the chunk's `source_format: 'mail'`
 * (ADR-0134). The kind stays the shelf's: `project_mail` is Projektwissen and
 * `office_mail` Büroablage, so a mail from a Behörde's domain never paints in
 * the building-law colour and never earns an authority badge. The label is the
 * sub-label inside that kind, like {@link AGENT_AUTHORED_LANE_LABEL}.
 */
export const MAIL_LANE = 'project_mail'
export const OFFICE_MAIL_LANE = 'office_mail'
export const MAIL_LANE_LABEL = 'E-Mail'

// Fine lane family → coarse kind (mirror of backend `source_kinds.kind_for_lane`).
// The Herleitung fan-out and the chips MUST share this so they never disagree
// (e.g. external norms are `building_law`, not `web`).
const LANE_KIND_PREFIXES: ReadonlyArray<readonly [string, SourceKind]> = [
  ['building_law', 'building_law'],
  ['authority', 'building_law'],
  ['external_standard', 'building_law'],
  ['office', 'office'],
  ['project', 'project'],
  ['web', 'web'],
  // Stamped by the measurement channel itself; no retrieval lane produces it.
  ['measurement', 'measurement'],
]

/** Map a fine lane stratum-key to its coarse SourceKind (fail-open to web). */
export const kindForLane = (lane: string | null | undefined): SourceKind => {
  const key = ((modernizeLane(lane) ?? '') as string).trim().toLowerCase()
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
// collection-id prefix (`archiv_` / `office_shelf_` / `proj_` / `s_`) and nothing parses it back
// out of a German label. The prefix table that used to live at this spot
// (`COLLECTION_SCOPE_PREFIXES`) is deleted — its absence is ADR-0047's
// acceptance test, because while it existed the shelf was still a guess.
//
// SHELF ≠ SOURCE KIND. They are two axes and conflating them is what produced
// the defects the ADR names:
//
//   Shelf      — whose document is this / which collection retrieval searched.
//                `office_shelf | project | session | base`.
//   SourceKind — the ADR-0026 DISPLAY taxonomy driving chip colour and badge:
//                `building_law | office | project | web`.
//
// A `project`-kind document can sit on the `session` shelf (a file the user
// dropped into the chat); a `building_law`-kind document sits on `base`. Neither
// enum is derivable from the other, so neither is defined in terms of the other.

/** The four shelves a retrieved chunk can come from. */
export type Shelf = 'office_shelf' | 'project' | 'session' | 'base'

/** Every shelf, for iteration. Kept in step with {@link Shelf} by `satisfies`. */
export const SHELVES = ['office_shelf', 'project', 'session', 'base'] as const satisfies readonly Shelf[]

const SHELF_SET: ReadonlySet<string> = new Set<string>(SHELVES)

/**
 * The shelf's wire value before it had an English name. A message, citation or
 * peer from before the rename still says `archiv`; it reads as the office
 * shelf and nothing writes it. Python twin: `LEGACY_SHELF_VALUES` in
 * `src/aiq_agent/common/source_kinds.py` (parity: `source-kinds.spec.ts`).
 * Remove after one release.
 */
export const LEGACY_SHELF_VALUES: Readonly<Record<string, Shelf>> = { archiv: 'office_shelf' }

/**
 * Narrow an untrusted wire value to a Shelf, else undefined.
 *
 * Unknown reads as UNKNOWN and renders unattributed. It is never defaulted to
 * `base` (nor to the old `baurecht`): the predecessor of this function failed
 * OPEN, so an unrecognised collection claimed to be authoritative base law —
 * the strongest provenance claim this UI can make.
 */
export const asShelf = (value: string | null | undefined): Shelf | undefined => {
  const raw = (value ?? '').trim().toLowerCase()
  const key = LEGACY_SHELF_VALUES[raw] ?? raw
  return SHELF_SET.has(key) ? (key as Shelf) : undefined
}

/*
 * The shelf's label is a dictionary key (`chat.sourceTabs.shelves.<shelf>`),
 * resolved where it is rendered (`citations/views.ts`, `documentShelfLabel`).
 * **Rendering only** (ADR-0047 §5: German is rendering, never transport):
 * nothing persists these strings, so rewording one is a copy change and never
 * invalidates a citation key already written. `session` has its own label on
 * purpose — a file attached privately to a chat used to be cited as
 * "Projektwissen" — and it is the wording the upload target uses.
 */

/**
 * Citation-key qualifiers — the READER's side of a key's disambiguating suffix.
 *
 * Two different things used to be the same string. The SHELF now travels as data
 * on the payload; nothing here is how a consumer learns it. What survives is the
 * citation KEY, which is a human-readable identity (`Plan.pdf (Büroablage),
 * p.3`) and still carries a qualifier when one filename was retrieved from more
 * than one shelf in the same turn — otherwise two different `Plan.pdf`s would
 * share a key. This table is what a reader must strip to recover the filename,
 * and the shelf each qualifier names is a FALLBACK for payloads that carry no
 * shelf field (every message persisted before ADR-0047).
 *
 * FROZEN wire values, pinned byte-for-byte against the backend's writer, and
 * deliberately independent of the shelf's display label: display copy may be reworded
 * freely, these may not — renaming a label must not change what a stored key
 * parses to, nor what today's keys strip to.
 *
 * A renamed shelf keeps its old qualifier here as a reader-only row: the archiv
 * shelf became „Büroablage" (6 Oct 2026), so the backend writes `(Büroablage)`
 * and keys persisted before that still say `(Büroarchiv)`. The backend lists the
 * retired name in `RETIRED_SHELF_QUALIFIERS`.
 */
export const CITATION_KEY_QUALIFIERS: ReadonlyArray<readonly [qualifier: string, shelf: Shelf]> = [
  ['Büroablage', 'office_shelf'],
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
  // So: German is rendering for DISPLAY (see `documentShelfLabel`), but a citation key
  // is a human-readable identity and still carries a qualifier to stay unique.
  // Both runtimes must agree on this set; the display label may be reworded freely,
  // this may not.
  ['Private Sitzung', 'session'],
  // Retired: the archiv shelf's name until 6 Oct 2026. No writer emits it; keys
  // persisted before the rename still carry it and must keep stripping.
  ['Büroarchiv', 'office_shelf'],
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
  const key = ((modernizeLane(lane) ?? '') as string).toLowerCase()
  if (key.startsWith('building_law_oib')) return 'OIB'
  if (key === 'external_standard') return 'ÖNORM'
  if (key === 'authority') return 'Behörde'
  // `building_law_base` is the lane of the DEFAULT doc_class ("sonstiges") — a
  // document nobody has classified yet. It must not inherit the `building_law`
  // prefix's RIS badge: every unclassified upload would then claim to be an
  // Austrian legal source, which is the strongest provenance claim this UI can
  // make and the one an architect is most entitled to trust.
  if (key === 'building_law_base') return null
  if (key.startsWith('building_law')) return 'RIS' // building_law_ris / _federal / _state / _ordinance
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
export const accentForLane = (lane: string | null | undefined, signal: SourceTint): SourceTint =>
  ((modernizeLane(lane) ?? '') as string).toLowerCase().startsWith('building_law_oib') ? 'oib' : signal
