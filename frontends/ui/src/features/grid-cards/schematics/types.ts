/**
 * Structural types for the schematic-card sub-objects.
 *
 * The generated Zod schemas (`@/shared/cards/generated`) type nested card
 * structures as `z.any()`, so the renderers declare the shapes they consume
 * here, mirroring the canonical Pydantic models in
 * `src/aiq_agent/cards/models.py`. Keep these in sync with the backend.
 */

export type DimStatus = 'pass' | 'fail' | 'warning' | 'needs_input'

/**
 * Where a number on a card came from. Mirrors `Provenance` in
 * `src/aiq_agent/cards/models.py`, which is `ifc_spatial.envelope.Answer`'s own
 * vocabulary — so the card and the sentence beside it cannot disagree about who
 * is making the claim.
 */
export type Provenance = 'declared' | 'computed' | 'inferred'

/** A verifiable pointer into a regulation — the atom of grounding. */
export interface NormReferenceData {
  document: string
  section?: string | null
  edition?: string | null
  excerpt?: string | null
}

/**
 * One measured dimension drawn on a schematic and checked against a limit.
 *
 * `provenance`, `tolerance` and `missing` are what keep the card as honest as
 * the sentence beside it. Without them this card drew „2.47 m ✓" for a figure
 * the engine had reported as „gemessen (±5 mm), aus der Geometrie berechnet,
 * nicht deklariert" — and a card is the part a reviewer screenshots into a
 * submission, so it was the surface most likely to be forwarded stripped of the
 * qualifier that made it true.
 *
 * All three are optional: a card built from the Bestimmung alone has nothing to
 * put in them, and absent means „not stated", never „declared".
 */
export interface DimensionCheckData {
  label: string
  value?: number | null
  required?: number | null
  unit?: string
  comparator?: '<=' | '>=' | null
  status: DimStatus
  provenance?: Provenance | null
  /** The ± band on `value`, in the same unit. Only meaningful when computed. */
  tolerance?: number | null
  /** With `needs_input`: what the export lacks and what to change in the CAD. */
  missing?: string | null
}

/** One storey in a building cross-section, drawn as a band to scale. */
export interface SectionStoreyData {
  label: string
  height_m: number
  below_grade?: boolean
}

/** A horizontal reference line at a given height in the section. */
export interface SectionMarkerData {
  label: string
  height_m: number
  kind?: 'fluchtniveau' | 'threshold' | 'reference'
}

/** A required distance from the building footprint to one parcel edge. */
export interface SetbackSideData {
  side: 'front' | 'back' | 'left' | 'right'
  required_m: number
  actual_m?: number | null
  status: DimStatus
}

/** One straight run of an escape path, drawn end-to-end with the next. */
export interface EgressSegmentData {
  label: string
  length_m: number
  turn?: 'straight' | 'left' | 'right'
}

/** An object blocking daylight (opposing building, own projection). */
export interface ObstructionData {
  distance_m: number
  height_m: number
  label: string
}

/** The fire-brigade Aufstellfläche geometry. */
export interface AufstellflaechePlanData {
  width: DimensionCheckData
  length: DimensionCheckData
  distance_to_facade?: DimensionCheckData | null
}

/** Airborne / impact / resulting sound-insulation metric. */
export type AcousticMetric = 'DnTw' | 'LnTw' | 'Rw_res'

/** One sound-insulation check between two building parts. */
export interface AcousticCheckItemData {
  path_label: string
  metric: AcousticMetric
  check: DimensionCheckData
  reference: NormReferenceData
}

/** One Brandabschnitt (fire compartment), drawn as a band and area-checked. */
export interface FireCompartmentData {
  label: string
  area: DimensionCheckData
  use?: string | null
}

/** One thermal-envelope component with its U-value checked against a limit. */
export interface EnvelopeComponentData {
  label: string
  kind: 'wall' | 'roof' | 'floor' | 'window' | 'door'
  u_value: DimensionCheckData
}

/** One requirement in a checklist, with its verdict and grounding. */
export interface ChecklistItemData {
  label: string
  status: DimStatus
  detail?: string | null
  reference?: NormReferenceData | null
}

/** One criterion compared across options (one value per option). */
export interface ComparisonRowData {
  label: string
  values: string[]
  highlight_index?: number | null
}

/** One branch of a condition tree: a case and the answer that holds under it. */
export interface ConditionBranchData {
  condition: string
  outcome: string
  active?: boolean | null
  reference?: NormReferenceData | null
}

/** How a typed-table column's cells are rendered. */
export type TypedColumnKind = 'mass' | 'norm' | 'verdict' | 'date' | 'text'

/** One column of a typed table, declaring how its cells render. */
export interface TypedColumnData {
  label: string
  /** Named `type` on the wire (mirrors the Pydantic field). */
  type: TypedColumnKind
}

/**
 * A link's declared rank in a norm chain. Mirrors `NormChainLink.rank` in
 * `src/aiq_agent/cards/models.py` — the agent's display classification, not a
 * `norm_registry` lookup. The first three bind; `oib_richtlinie` binds where a
 * Land declares it; `oenorm`/`leitfaden` interpret.
 */
export type NormChainRank =
  | 'bundesgesetz'
  | 'landesgesetz'
  | 'verordnung'
  | 'oib_richtlinie'
  | 'oenorm'
  | 'leitfaden'

/** One link in a norm hierarchy, with the rank that sets its visual weight. */
export interface NormChainLinkData {
  label: string
  rank: NormChainRank
  note?: string | null
}

/** One key takeaway: the line the reader leaves with, plus the detail behind it. */
export interface KeyTakeawayData {
  text: string
  detail?: string | null
}

/**
 * What kind of remark a callout carries. Mirrors `CalloutCard.kind` in
 * `src/aiq_agent/cards/models.py`. The renderer prints the German word for each
 * beside its tone — the kind must never be carried by colour alone.
 */
export type CalloutKind = 'hinweis' | 'achtung' | 'frist' | 'tipp'

/**
 * One follow-up question. `question` is the exact text that lands in the
 * composer, so it is a whole sendable sentence — never a topic label. Mirrors
 * `FollowUp` in `src/aiq_agent/cards/models.py`.
 */
export interface FollowUpData {
  question: string
  hint?: string | null
}
