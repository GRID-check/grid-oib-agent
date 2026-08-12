/**
 * Domain types for the BIM/IFC subsystem.
 *
 * A GRID "BIM model" is what falls out of parsing one uploaded IFC file with
 * `@ifc-lite/parser`: a spatial hierarchy, a flat list of elements carrying
 * their property sets / quantities / materials / classifications, and the
 * aggregates the UI and the agent read instead of re-deriving them.
 *
 * Everything here is plain JSON — the index is written to object storage, the
 * summary lands in a `jsonb` column, and the element records become
 * `bim_elements` rows. No class instances, no `Date`s, no `undefined` in
 * serialized positions (drizzle round-trips `null`, not `undefined`).
 */

import type { BimHealth } from './validate'

/** Scalar shapes an IFC property can carry once flattened for storage. */
export type BimPropertyValue = string | number | boolean | null

/** `{ "Pset_WallCommon": { "IsExternal": true, … } }` */
export type BimPropertySets = Record<string, Record<string, BimPropertyValue>>

/** `{ "Qto_WallBaseQuantities": { "NetSideArea": 24.5, … } }` — always numeric. */
export type BimQuantitySets = Record<string, Record<string, number>>

/**
 * Where an element sits in the spatial structure. `storey` is the common case;
 * `space`, `building` and `site` happen in models that contain elements at a
 * coarser level (site furniture, building-wide systems), and `null` is the
 * honest answer for an element no `IfcRelContainedInSpatialStructure` reaches.
 */
export type BimContainerKind = 'storey' | 'space' | 'building' | 'site' | 'project'

/** One physical element (or space) of the model. */
export interface BimElement {
  /** IFC GlobalId (22-char base64 GUID) — the stable, cross-tool identity. */
  globalId: string
  /** STEP express id, unique within THIS file only. Kept for viewer selection. */
  expressId: number
  /** Canonical PascalCase entity name, e.g. `IfcWall`. */
  ifcType: string
  name: string | null
  description: string | null
  /** `SOLIDWALL`, `FLOOR`, … — the enum literal, uppercase, as authored. */
  predefinedType: string | null
  objectType: string | null
  tag: string | null
  /** Name of the `IfcTypeObject` this element is defined by, when any. */
  typeName: string | null
  containerKind: BimContainerKind | null
  containerGlobalId: string | null
  containerName: string | null
  /** Storey the element resolves to by walking up the containment chain. */
  storeyGlobalId: string | null
  storeyName: string | null
  /** Distinct material names, outermost-first for layer sets. */
  materials: string[]
  classifications: BimClassification[]
  properties: BimPropertySets
  quantities: BimQuantitySets
}

export interface BimClassification {
  system: string | null
  identification: string | null
  name: string | null
}

/** A node of the spatial tree (project → site → building → storey → space). */
export interface BimSpatialNode {
  globalId: string | null
  expressId: number
  ifcType: string
  name: string | null
  /** Storey elevation in metres, already unit-converted by the parser. */
  elevation: number | null
  /** Number of elements directly contained by this node. */
  elementCount: number
  children: BimSpatialNode[]
}

export interface BimStorey {
  globalId: string | null
  expressId: number
  name: string | null
  elevation: number | null
  elementCount: number
}

/** `FILE_NAME` / `FILE_DESCRIPTION` provenance, as authored by the exporter. */
export interface BimHeader {
  name: string | null
  timeStamp: string | null
  author: string[]
  organization: string[]
  preprocessorVersion: string | null
  originatingSystem: string | null
  description: string[]
}

export interface BimUnit {
  /** `m`, `mm`, `m²`, … as declared by the file. */
  symbol: string
  /** Factor converting a value in this unit to its SI base. */
  siScale: number
}

export interface BimUnits {
  length: BimUnit | null
  area: BimUnit | null
  volume: BimUnit | null
}

/**
 * The compact, always-loaded part of a model: everything except the element
 * list. Small enough to live in a `jsonb` column and be sent to the client on
 * first paint, which is what makes the overview render before any element
 * query runs.
 */
export interface BimModelSummary {
  /** `IFC4`, `IFC2X3`, `IFC4X3`, … as declared in `FILE_SCHEMA`. */
  schema: string | null
  header: BimHeader
  units: BimUnits
  projectName: string | null
  siteName: string | null
  buildingNames: string[]
  storeys: BimStorey[]
  spatial: BimSpatialNode | null
  /** Element count per canonical IFC type, descending by count. */
  typeCounts: Record<string, number>
  /** Property-set names present anywhere in the model, sorted. */
  propertySetNames: string[]
  /** Quantity-set names present anywhere in the model, sorted. */
  quantitySetNames: string[]
  /** Distinct material names, sorted. */
  materialNames: string[]
  totals: {
    entities: number
    elements: number
    spaces: number
    storeys: number
  }
  /**
   * Sum of the quantities that carry building meaning, in the file's declared
   * units. `null` when the model publishes no such quantity — an absent
   * quantity is NOT zero, and the UI must be able to tell the two apart.
   */
  quantityTotals: {
    netFloorAreaM2: number | null
    grossFloorAreaM2: number | null
    netVolumeM3: number | null
  }
  /**
   * Validation findings (`validate.ts`). Stored with the model rather than
   * recomputed: the checks run over the FULL element set, including the ones a
   * truncated element list dropped, so they cannot be reproduced from what the
   * database holds.
   */
  health: BimHealth | null
  /** Parse wall-clock in ms and the source size, for the ingestion report. */
  parseMs: number
  fileSizeBytes: number
  /** Set when the element list was capped; the counts above are still exact. */
  truncatedAt: number | null
}

/** Full extraction result: the summary plus every element record. */
export interface BimModelIndex extends BimModelSummary {
  elements: BimElement[]
}

/** Lifecycle of a `bim_models` row. */
export type BimModelStatus = 'pending' | 'extracting' | 'ready' | 'failed'

export const BIM_MODEL_STATUSES = ['pending', 'extracting', 'ready', 'failed'] as const

/** File extensions the IFC pipeline claims. `.ifcxml` is deliberately absent. */
export const IFC_EXTENSIONS = ['.ifc', '.ifczip'] as const

/**
 * There is no registered IANA type for IFC. Browsers therefore send
 * `application/octet-stream` (or nothing) for a `.ifc` file, so the extension —
 * not the content type — decides. These are the types real clients have been
 * observed to send, kept only so an explicit accept-list can match them.
 */
export const IFC_MIME_TYPES = [
  'application/x-step',
  'application/step',
  'model/ifc',
  'application/ifc',
  'application/x-ifc',
] as const

/**
 * The IFC size ceiling. Defined in `@/shared/config/request-body-limit`, which
 * imports nothing because `next.config.ts` reads it at server start in an image
 * that holds almost none of `src/`. Re-exported here so the BIM pipeline keeps
 * one obvious place to import it from.
 */
export { DEFAULT_MAX_IFC_BYTES, maxIfcBytesFrom } from '@/shared/config/request-body-limit'

/**
 * Largest `op: 'elements'` page the query API serves, and therefore the page
 * size the viewer's full-model walk uses — one constant so the client cannot
 * ask for a size the schema refuses, and so the walk's request count is a
 * number a spec can reason about. At the 200 000-element extraction cap the
 * walk is 200 requests; at the old 200-row cap it was 1 000, which is how a
 * viewer load could drain a rate-limit budget by itself.
 */
export const BIM_ELEMENTS_PAGE_LIMIT = 1_000

/**
 * The largest `offset` an element page may ask for.
 *
 * It must stay ABOVE the extraction cap (`BIM_ELEMENT_LIMIT`, 200 000 by
 * default and raisable by env) or the viewer's own walk breaks in the middle
 * of a large model: it advances six pages of `BIM_ELEMENTS_PAGE_LIMIT` per
 * round and keeps going while pages come back full, so a ceiling below the
 * stored row count means one round gets a 400, `Promise.all` rejects, and the
 * whole element index fails rather than returning a partial one. Selection,
 * storey isolation and highlights all die with it.
 *
 * Not derived from `BIM_ELEMENT_LIMIT` directly because that constant lives in
 * the server-only service module, and this file is read by the browser. The
 * headroom is deliberate: raising the extraction cap must not silently
 * reintroduce the bug.
 */
export const BIM_ELEMENT_OFFSET_LIMIT = 1_000_000

/** True when a filename is one the IFC pipeline should handle. */
export function isIfcFilename(filename: string): boolean {
  const lower = filename.trim().toLowerCase()
  return IFC_EXTENSIONS.some((ext) => lower.endsWith(ext))
}
