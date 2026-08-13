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
