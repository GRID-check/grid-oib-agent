/**
 * Structural types for the schematic-card sub-objects.
 *
 * The generated Zod schemas (`@/shared/cards/generated`) type nested card
 * structures as `z.any()`, so the renderers declare the shapes they consume
 * here, mirroring the canonical Pydantic models in
 * `src/aiq_agent/cards/models.py`. Keep these in sync with the backend.
 */

export type DimStatus = 'pass' | 'fail' | 'warning' | 'needs_input'

/** A verifiable pointer into a regulation — the atom of grounding. */
export interface NormReferenceData {
  document: string
  section?: string | null
  edition?: string | null
  excerpt?: string | null
}

/** One measured dimension drawn on a schematic and checked against a limit. */
export interface DimensionCheckData {
  label: string
  value?: number | null
  required?: number | null
  unit?: string
  comparator?: '<=' | '>=' | null
  status: DimStatus
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
