/**
 * IFC → `BimModelIndex` extraction, built on `@ifc-lite/parser`.
 *
 * Runs in Node (the BFF's ingestion path) and, unchanged, in the browser: the
 * parser is pure TypeScript with an optional WASM accelerator that we never
 * reach for, so the same module produces the same index on both sides. That is
 * the reason the viewer and the agent can never disagree about what is in a
 * model — there is one extractor, not a server one and a client one.
 *
 * What this module deliberately does NOT do: geometry. Triangulating a model is
 * the renderer's job and happens in the browser, on demand. Everything the
 * agent needs to *answer questions* — types, names, storeys, property sets,
 * quantities, materials, classifications — is metadata, and metadata is what
 * gets extracted, indexed and queried here.
 */

import {
  IfcParser,
  extractAllEntityAttributes,
  extractClassificationsOnDemand,
  extractMaterialsOnDemand,
  extractProjectUnits,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractRootAttributesFromEntity,
  extractTypePropertiesOnDemand,
  extractTypeQuantitiesOnDemand,
  getInheritanceChainAcrossSchemas,
  mergeInheritedPropertySets,
  normalizeIfcTypeName,
  type IfcDataStore,
  type MaterialInfo,
} from '@ifc-lite/parser'
import type { SpatialNode } from '@ifc-lite/data'
import { validateModel } from './validate'
import type {
  BimClassification,
  BimContainerKind,
  BimElement,
  BimHeader,
  BimModelIndex,
  BimPropertySets,
  BimPropertyValue,
  BimQuantitySets,
  BimSpatialNode,
  BimStorey,
  BimUnit,
} from './types'

/**
 * Hard cap on persisted element records. A federated model can carry millions
 * of entities; the counts and aggregates below stay exact regardless (they are
 * computed while walking, before the cap applies), but the per-element rows
 * stop so one upload cannot fill the tenant's table. `truncatedAt` records it
 * so every surface can say so out loud instead of quietly serving a subset.
 */
export const DEFAULT_ELEMENT_LIMIT = 200_000

/**
 * `IfcSpatialElement` subtypes we keep as first-class rows despite not being
 * `IfcElement`s. Spaces are the unit an architect actually asks about ("how
 * many rooms", "net floor area per storey"), so excluding them would make the
 * query layer useless for the most common question in the domain.
 */
const SPATIAL_ELEMENT_TYPES = new Set(['IfcSpace', 'IfcSpatialZone'])

/**
 * Feature elements are *subtractions and additions to* elements (openings,
 * recesses), not things in the building. Counting them as elements double-counts
 * every window hole and makes "how many elements are on the ground floor"
 * disagree with every other IFC tool.
 */
const EXCLUDED_SUPERTYPE = 'IfcFeatureElement'

/** IFC spatial containers, in coarse-to-fine order, keyed by canonical type. */
const CONTAINER_KIND_BY_TYPE: Record<string, BimContainerKind> = {
  IfcProject: 'project',
  IfcSite: 'site',
  IfcBuilding: 'building',
  IfcBuildingStorey: 'storey',
  IfcSpace: 'space',
  IfcSpatialZone: 'space',
}

/**
 * `SpatialNode.type` is an `IfcTypeEnum` ordinal, not a name, and the enum is
 * not exported as a value we can invert. The spatial tree only ever carries
 * these six, so mapping them explicitly is both complete and stable.
 */
const SPATIAL_NODE_TYPE_NAMES: Record<number, string> = {
  1: 'IfcProject',
  2: 'IfcSite',
  3: 'IfcBuilding',
  4: 'IfcBuildingStorey',
  5: 'IfcSpace',
  6: 'IfcSpatialZone',
}

export interface ExtractIfcOptions {
  /** Cap on persisted element records. Defaults to {@link DEFAULT_ELEMENT_LIMIT}. */
  elementLimit?: number
  /** Progress callback, forwarded from the parser plus our own element phase. */
  onProgress?: (progress: { phase: string; percent: number }) => void
}

/** Raised when the bytes are not an IFC file we can read. */
export class IfcExtractionError extends Error {
  readonly code: 'not-ifc' | 'parse-failed'

  constructor(code: 'not-ifc' | 'parse-failed', message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'IfcExtractionError'
    this.code = code
  }
}

/** The four bytes every STEP physical file starts with, modulo leading space. */
const STEP_MAGIC = 'ISO-10303-21'

/**
 * True when the buffer looks like a STEP-encoded IFC file. Cheap prefix sniff,
 * mirroring the PDF magic-byte check on the Python side: a `.ifc` extension on
 * arbitrary bytes must fail as "not IFC", not as a parser stack trace.
 *
 * `.ifczip` (a zipped IFC) is NOT accepted by this check — the parser unwraps
 * it itself, so the caller passes the flag through {@link extractIfcModel}.
 */
export function looksLikeStepIfc(buffer: ArrayBuffer): boolean {
  const head = new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength))
  const text = new TextDecoder('latin1').decode(head)
  return text.trimStart().startsWith(STEP_MAGIC)
}

/** Coerce an ifc-lite property value into a storable JSON scalar. */
function toStorableValue(value: unknown, values: readonly string[] | undefined): BimPropertyValue {
  // Enumerated/list properties (IfcPropertyEnumeratedValue, IfcPropertyListValue)
  // arrive as a `values` array; join rather than drop, so a filter on
  // "Fire rating = REI 90" still matches a single-entry list.
  if (values && values.length > 0) return values.join(', ')
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return String(value)
}

/** Flatten ifc-lite's pset shape into `{ psetName: { propName: value } }`. */
function toPropertySets(
  sets: ReadonlyArray<{
    name: string
    properties: ReadonlyArray<{ name: string; value: unknown; values?: string[] }>
  }>
): BimPropertySets {
  const out: BimPropertySets = {}
  for (const set of sets) {
    if (!set.name) continue
    const bucket = (out[set.name] ??= {})
    for (const property of set.properties) {
      if (!property.name) continue
      bucket[property.name] = toStorableValue(property.value, property.values)
    }
  }
  return out
}

/** Flatten ifc-lite's qset shape, dropping non-finite values. */
function toQuantitySets(
  sets: ReadonlyArray<{ name: string; quantities: ReadonlyArray<{ name: string; value: number }> }>
): BimQuantitySets {
  const out: BimQuantitySets = {}
  for (const set of sets) {
    if (!set.name) continue
    const bucket = (out[set.name] ??= {})
    for (const quantity of set.quantities) {
      if (!quantity.name || !Number.isFinite(quantity.value)) continue
      bucket[quantity.name] = quantity.value
    }
  }
  return out
}

/**
 * Distinct material names for an element, outermost layer first.
 *
 * A layered wall's identity is its layer stack, so the list is kept ordered
 * rather than sorted — "Stahlbeton, Wärmedämmung" and "Wärmedämmung,
 * Stahlbeton" are different constructions.
 */
function toMaterialNames(info: MaterialInfo | null): string[] {
  if (!info) return []
  const names: string[] = []
  const push = (name: string | undefined) => {
    if (name && !names.includes(name)) names.push(name)
  }
  for (const layer of info.layers ?? []) push(layer.materialName)
  for (const profile of info.profiles ?? []) push(profile.materialName)
  for (const constituent of info.constituents ?? []) push(constituent.materialName)
  for (const material of info.materials ?? []) push(material.name)
  // A single IfcMaterial carries its name on the info itself; a set carries a
  // set name we do NOT want to conflate with a material (the layer names above
  // are the materials), so only fall back when nothing else resolved.
  if (names.length === 0) push(info.name)
  return names
}

function toClassifications(
  infos: ReadonlyArray<{ system?: string; identification?: string; name?: string }>
): BimClassification[] {
  return infos.map((info) => ({
    system: info.system ?? null,
    identification: info.identification ?? null,
    name: info.name ?? null,
  }))
}

/** `''` → `null`, so "absent" is one value in storage rather than two. */
function blankToNull(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

interface ContainerInfo {
  kind: BimContainerKind
  globalId: string | null
  name: string | null
  storeyGlobalId: string | null
  storeyName: string | null
}

/**
 * Walk the spatial tree once and produce (a) the serializable tree, (b) the
 * storey list, and (c) the element → container map every element record needs.
 *
 * The parser exposes `elementToStorey` on the hierarchy but leaves it empty on
 * the columnar path, so it is derived here from the tree it does populate.
 */
function walkSpatial(
  store: IfcDataStore,
  root: SpatialNode | null | undefined
): { tree: BimSpatialNode | null; storeys: BimStorey[]; containers: Map<number, ContainerInfo> } {
  const storeys: BimStorey[] = []
  const containers = new Map<number, ContainerInfo>()
  if (!root) return { tree: null, storeys, containers }

  const visit = (
    node: SpatialNode,
    inheritedStorey: { globalId: string | null; name: string | null } | null
  ): BimSpatialNode => {
    const ifcType = SPATIAL_NODE_TYPE_NAMES[node.type] ?? 'IfcSpatialElement'
    const entity = store.getEntity(node.expressId)
    const attrs = entity ? extractRootAttributesFromEntity(entity) : null
    const globalId = blankToNull(attrs?.globalId)
    const name = blankToNull(node.name) ?? blankToNull(attrs?.name)
    const kind = CONTAINER_KIND_BY_TYPE[ifcType] ?? null

    const storey =
      ifcType === 'IfcBuildingStorey' ? { globalId, name } : inheritedStorey

    const elements = node.elements ?? []
    if (kind) {
      for (const elementId of elements) {
        containers.set(elementId, {
          kind,
          globalId,
          name,
          storeyGlobalId: storey?.globalId ?? null,
          storeyName: storey?.name ?? null,
        })
      }
    }

    if (ifcType === 'IfcBuildingStorey') {
      storeys.push({
        globalId,
        expressId: node.expressId,
        name,
        elevation: typeof node.elevation === 'number' ? node.elevation : null,
        elementCount: elements.length,
      })
    }

    const children = (node.children ?? []).map((child) => visit(child, storey))

    // A space is both a container and a queryable element: record its own
    // containment so `IfcSpace` rows resolve to the storey they sit in.
    if (SPATIAL_ELEMENT_TYPES.has(ifcType) && inheritedStorey) {
      containers.set(node.expressId, {
        kind: 'storey',
        globalId: inheritedStorey.globalId,
        name: inheritedStorey.name,
        storeyGlobalId: inheritedStorey.globalId,
        storeyName: inheritedStorey.name,
      })
    }

    return {
      globalId,
      expressId: node.expressId,
      ifcType,
      name,
      elevation: typeof node.elevation === 'number' ? node.elevation : null,
      elementCount: elements.length,
      children,
    }
  }

  return { tree: visit(root, null), storeys, containers }
}

/** Types whose entities become `bim_elements` rows, in stable order. */
function selectElementTypes(store: IfcDataStore): string[] {
  const selected: string[] = []
  for (const rawType of store.entityIndex.byType.keys()) {
    const canonical = normalizeIfcTypeName(rawType)
    const chain = getInheritanceChainAcrossSchemas(rawType)
    if (chain.includes(EXCLUDED_SUPERTYPE)) continue
    if (chain.includes('IfcElement') || SPATIAL_ELEMENT_TYPES.has(canonical)) selected.push(rawType)
  }
  return selected.sort()
}

function toUnit(resolved: { symbol: string; siScale: number } | undefined): BimUnit | null {
  return resolved ? { symbol: resolved.symbol, siScale: resolved.siScale } : null
}

function toHeader(header: IfcDataStore['sourceHeader']): BimHeader {
  return {
    name: blankToNull(header?.name),
    timeStamp: blankToNull(header?.timeStamp),
    author: (header?.author ?? []).filter((value): value is string => Boolean(value)),
    organization: (header?.organization ?? []).filter((value): value is string => Boolean(value)),
    preprocessorVersion: blankToNull(header?.preprocessorVersion),
    originatingSystem: blankToNull(header?.originatingSystem),
    description: (header?.description ?? []).filter((value): value is string => Boolean(value)),
  }
}

/**
 * Quantity names that carry the same meaning across exporters. Summing "any
 * quantity called area" would add wall side areas to floor areas; these are the
 * names IFC actually standardises, so only they are totalled.
 */
const NET_FLOOR_AREA_KEYS = ['NetFloorArea', 'NetArea']
const GROSS_FLOOR_AREA_KEYS = ['GrossFloorArea', 'GrossArea']
const NET_VOLUME_KEYS = ['NetVolume']

/**
 * Round an accumulated measure to 4 decimals.
 *
 * Summing IEEE doubles turns 32 + 12.5 + 18 + 6.5 into 69.00000000000001 often
 * enough that the raw sum would leak into the UI and into every assertion about
 * it. 4 decimals is far below the precision any IFC exporter claims and far
 * above what a floor area is ever read to.
 */
function roundMeasure(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10_000) / 10_000
}

function sumQuantity(element: BimElement, keys: readonly string[]): number | null {
  for (const set of Object.values(element.quantities)) {
    for (const key of keys) {
      const value = set[key]
      if (typeof value === 'number' && Number.isFinite(value)) return value
    }
  }
  return null
}

/**
 * Parse an IFC buffer into the index the rest of the system reads.
 *
 * @throws {IfcExtractionError} when the bytes are not IFC, or the parser fails.
 */
export async function extractIfcModel(
  buffer: ArrayBuffer,
  filename: string,
  options: ExtractIfcOptions = {}
): Promise<BimModelIndex> {
  const limit = Math.max(1, Math.trunc(options.elementLimit ?? DEFAULT_ELEMENT_LIMIT))
  const isZip = filename.trim().toLowerCase().endsWith('.ifczip')
  if (!isZip && !looksLikeStepIfc(buffer)) {
    throw new IfcExtractionError('not-ifc', 'File does not start with an ISO-10303-21 header')
  }

  const startedAt = Date.now()
  let store: IfcDataStore
  try {
    store = await new IfcParser().parseColumnar(buffer, { onProgress: options.onProgress })
  } catch (error) {
    throw new IfcExtractionError('parse-failed', 'IFC parsing failed', { cause: error })
  }
  const parseMs = Date.now() - startedAt

  const { tree, storeys, containers } = walkSpatial(store, store.spatialHierarchy?.project)
  const units = extractProjectUnits(store.source, store.entityIndex)

  const elements: BimElement[] = []
  const typeCounts: Record<string, number> = {}
  const propertySetNames = new Set<string>()
  const quantitySetNames = new Set<string>()
  const materialNames = new Set<string>()
  let elementTotal = 0
  let spaceTotal = 0
  let truncated = false

  let netFloorArea: number | null = null
  let grossFloorArea: number | null = null
  let netVolume: number | null = null
  const addTotal = (current: number | null, value: number | null): number | null =>
    value === null ? current : (current ?? 0) + value

  const elementTypes = selectElementTypes(store)
  for (const rawType of elementTypes) {
    const canonical = normalizeIfcTypeName(rawType)
    const expressIds = store.entityIndex.byType.get(rawType) ?? []
    typeCounts[canonical] = (typeCounts[canonical] ?? 0) + expressIds.length
    elementTotal += expressIds.length
    if (SPATIAL_ELEMENT_TYPES.has(canonical)) spaceTotal += expressIds.length

    for (const expressId of expressIds) {
      if (elements.length >= limit) {
        truncated = true
        continue
      }
      const entity = store.getEntity(expressId)
      if (!entity) continue

      const root = extractRootAttributesFromEntity(entity)
      const named = extractAllEntityAttributes(store, expressId)
      const predefinedType = named.find((attribute) => attribute.name === 'PredefinedType')

      // Occurrence property sets win over the ones inherited from the element's
      // IfcTypeObject — that is the IFC precedence rule, and `mergeInheritedPropertySets`
      // implements it, so an element that overrides its type's FireRating reads
      // as the override rather than as two conflicting values.
      const ownSets = extractPropertiesOnDemand(store, expressId)
      const typeInfo = extractTypePropertiesOnDemand(store, expressId)
      const mergedSets = typeInfo ? mergeInheritedPropertySets(ownSets, typeInfo.properties) : ownSets

      const ownQuantities = extractQuantitiesOnDemand(store, expressId)
      const typeQuantities = extractTypeQuantitiesOnDemand(store, expressId)
      const mergedQuantities = typeQuantities
        ? mergeInheritedPropertySets(
            ownQuantities.map((set) => ({ name: set.name, properties: set.quantities })),
            typeQuantities.quantities.map((set) => ({ name: set.name, properties: set.quantities }))
          ).map((set) => ({ name: set.name, quantities: set.properties }))
        : ownQuantities

      const materials = toMaterialNames(extractMaterialsOnDemand(store, expressId))
      const container = containers.get(expressId) ?? null

      const element: BimElement = {
        globalId: root.globalId || `express:${expressId}`,
        expressId,
        ifcType: canonical,
        name: blankToNull(root.name),
        description: blankToNull(root.description),
        predefinedType:
          typeof predefinedType?.value === 'string' ? blankToNull(predefinedType.value) : null,
        objectType: blankToNull(root.objectType),
        tag: blankToNull(root.tag),
        typeName: blankToNull(typeInfo?.typeName),
        containerKind: container?.kind ?? null,
        containerGlobalId: container?.globalId ?? null,
        containerName: container?.name ?? null,
        storeyGlobalId: container?.storeyGlobalId ?? null,
        storeyName: container?.storeyName ?? null,
        materials,
        classifications: toClassifications(extractClassificationsOnDemand(store, expressId)),
        properties: toPropertySets(mergedSets),
        quantities: toQuantitySets(mergedQuantities),
      }

      for (const name of Object.keys(element.properties)) propertySetNames.add(name)
      for (const name of Object.keys(element.quantities)) quantitySetNames.add(name)
      for (const name of materials) materialNames.add(name)

      // Building totals come from SPACES only. A wall also publishes
      // `NetVolume`, but that is the volume of its material, not of the
      // building — adding the two produces a number that means nothing.
      if (canonical === 'IfcSpace') {
        netFloorArea = addTotal(netFloorArea, sumQuantity(element, NET_FLOOR_AREA_KEYS))
        grossFloorArea = addTotal(grossFloorArea, sumQuantity(element, GROSS_FLOOR_AREA_KEYS))
        netVolume = addTotal(netVolume, sumQuantity(element, NET_VOLUME_KEYS))
      }

      elements.push(element)
    }
  }

  const orderedTypeCounts = Object.fromEntries(
    Object.entries(typeCounts).sort(([aName, aCount], [bName, bCount]) =>
      bCount === aCount ? aName.localeCompare(bName) : bCount - aCount
    )
  )

  const buildingNames = collectNames(tree, 'IfcBuilding')

  const index: BimModelIndex = {
    schema: blankToNull(store.schemaVersion),
    header: toHeader(store.sourceHeader),
    units: {
      length: toUnit(units.resolvedForUnitType('LENGTHUNIT')),
      area: toUnit(units.resolvedForUnitType('AREAUNIT')),
      volume: toUnit(units.resolvedForUnitType('VOLUMEUNIT')),
    },
    projectName: tree?.ifcType === 'IfcProject' ? tree.name : null,
    siteName: collectNames(tree, 'IfcSite')[0] ?? null,
    buildingNames,
    storeys: storeys.sort(sortStoreys),
    spatial: tree,
    typeCounts: orderedTypeCounts,
    propertySetNames: [...propertySetNames].sort(),
    quantitySetNames: [...quantitySetNames].sort(),
    materialNames: [...materialNames].sort(),
    totals: {
      entities: store.entityCount ?? 0,
      elements: elementTotal,
      spaces: spaceTotal,
      storeys: storeys.length,
    },
    quantityTotals: {
      netFloorAreaM2: roundMeasure(netFloorArea),
      grossFloorAreaM2: roundMeasure(grossFloorArea),
      netVolumeM3: roundMeasure(netVolume),
    },
    health: null,
    parseMs,
    fileSizeBytes: buffer.byteLength,
    truncatedAt: truncated ? limit : null,
    elements,
  }

  // Validation runs HERE, over the whole extraction, rather than later over the
  // stored rows: the element list may be capped and the findings must be about
  // the model, not about the subset that fit.
  index.health = validateModel(index)
  return index
}

/** Depth-first collection of node names for one spatial type. */
function collectNames(node: BimSpatialNode | null, ifcType: string): string[] {
  if (!node) return []
  const found: string[] = []
  const visit = (current: BimSpatialNode) => {
    if (current.ifcType === ifcType && current.name) found.push(current.name)
    for (const child of current.children) visit(child)
  }
  visit(node)
  return found
}

/**
 * Storeys sort by elevation, lowest first — the order a person reads a building
 * in. Storeys with no elevation sink to the end rather than being treated as
 * ground level, which would put an unplaced storey in the middle of the stack.
 */
function sortStoreys(a: BimStorey, b: BimStorey): number {
  if (a.elevation === null && b.elevation === null) return (a.name ?? '').localeCompare(b.name ?? '')
  if (a.elevation === null) return 1
  if (b.elevation === null) return -1
  return a.elevation - b.elevation
}
