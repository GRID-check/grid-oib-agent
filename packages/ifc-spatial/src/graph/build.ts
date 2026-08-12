/**
 * IFC → {@link BuildingGraph}.
 *
 * ## What this does that a flattening extractor does not
 *
 * `@ifc-lite/parser` already builds a bidirectional relationship graph over the
 * whole file — `VoidsElement`, `FillsElement`, `SpaceBoundary`,
 * `ConnectsPathElements` and the rest are in memory the moment the parse ends.
 * Pipelines that flatten IFC into element rows read the containment edge, use it
 * to write a `storey_name` column, and drop everything else.
 *
 * Those dropped edges ARE the building. `fills` + `voids` is "this window sits
 * in that wall". `SpaceBoundary` is "that wall encloses this room". Two spaces
 * bounded by the same wall are neighbours. None of it needs geometry, and all of
 * it is thrown away by default.
 *
 * ## Direction is normalised here, not trusted
 *
 * IFC objectified relationships have a Relating and a Related side, and which
 * one a given library puts in `forward` is a library detail. Rather than encode
 * an assumption that a version bump could silently invert — the exact failure
 * shape that costs a day to find — the edges whose meaning depends on direction
 * (`voids`, `fills`, `interfaceOf`, `inGroup`) are oriented by looking at what
 * the two endpoints ARE. An opening is an opening whichever end of the relation
 * it sits on.
 */

import {
  IfcParser,
  extractGeoreferencingOnDemand,
  extractRootAttributesFromEntity,
  getAttributeNamesAcrossSchemas,
  normalizeIfcTypeName,
} from '@ifc-lite/parser'
import { RelationshipType } from '@ifc-lite/data'
import { createHash } from 'node:crypto'
import type { BuildingGraph, EdgeKind, GraphEdge, GraphNode, NodeKind, DialectEntry, BlindSpot, UnitInfo } from './types.js'

/**
 * Roots that carry a GlobalId and are not part of the building.
 *
 * A GlobalId is not the same as a thing in space: property sets, quantity sets,
 * classifications and the actors who authored the file all have one. Including
 * them would put several thousand nodes with no place in the graph and make
 * every "how many elements" answer disagree with every other IFC tool.
 */
const NON_PRODUCT_ROOTS = new Set([
  'IfcPropertySet',
  'IfcPropertySetTemplate',
  'IfcElementQuantity',
  'IfcClassification',
  'IfcClassificationReference',
  'IfcDocumentInformation',
  'IfcDocumentReference',
  'IfcActor',
  'IfcAsset',
  'IfcInventory',
  'IfcProjectOrder',
  'IfcWorkPlan',
  'IfcWorkSchedule',
  'IfcTask',
  'IfcProcedure',
  'IfcConstructionMaterialResource',
  'IfcPresentationLayerAssignment',
])

const SPACE_TYPES = new Set(['IfcSpace', 'IfcSpatialZone'])
const OPENING_TYPES = new Set(['IfcOpeningElement', 'IfcOpeningStandardCase', 'IfcVoidingFeature'])
const GROUP_TYPES = new Set(['IfcGroup', 'IfcZone', 'IfcSystem', 'IfcBuildingSystem', 'IfcDistributionSystem'])

/** Spatial-container types, coarse to fine. */
const CONTAINER_KIND: Record<string, NodeKind> = {
  IfcProject: 'project',
  IfcSite: 'site',
  IfcBuilding: 'building',
  IfcBuildingStorey: 'storey',
}

export interface BuildOptions {
  /**
   * Elements sampled when measuring the file's property dialect.
   *
   * The dialect is a description of the export, not an inventory, so it does
   * not need every element — but it must say when it sampled, because "0 % of
   * walls publish a FireRating" read off a sample is a different claim from the
   * same sentence read off the model. See {@link BuildingGraph.dialect} and the
   * `sampled` blind spot.
   */
  dialectSampleSize?: number
  onProgress?: (phase: string) => void
}

export async function buildGraph(bytes: Uint8Array, options: BuildOptions = {}): Promise<BuildingGraph> {
  const t0 = Date.now()
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

  options.onProgress?.('parse')
  const store = await new IfcParser().parseColumnar(buffer)
  const parseMs = Date.now() - t0

  const t1 = Date.now()
  options.onProgress?.('nodes')

  const nodes = new Map<string, GraphNode>()
  const byType = new Map<string, string[]>()
  /** express id → GlobalId, so relationship edges (which speak express ids) can be translated. */
  const idOf = new Map<number, string>()

  for (const [rawType, expressIds] of store.entityIndex.byType) {
    const ifcType = normalizeIfcTypeName(rawType)
    if (!isProductType(ifcType)) continue

    for (const expressId of expressIds) {
      const entity = store.getEntity(expressId)
      if (!entity) continue
      const root = extractRootAttributesFromEntity(entity)
      if (!root?.globalId) continue

      const node: GraphNode = {
        globalId: root.globalId,
        expressId,
        kind: kindOf(ifcType),
        ifcType,
        name: nonEmpty(root.name),
        longName: longNameOf(entity, ifcType),
        predefinedType: predefinedTypeOf(entity, ifcType),
        elevation: null,
        storeyGlobalId: null,
        storeyName: null,
      }
      nodes.set(root.globalId, node)
      idOf.set(expressId, root.globalId)
      push(byType, ifcType, root.globalId)
    }
  }

  options.onProgress?.('spatial')
  const edges: GraphEdge[] = []
  const hierarchy = store.spatialHierarchy

  // Storey elevations and the containment chain come from the parser's own
  // spatial hierarchy rather than being re-walked here: it already resolves
  // aggregated descendants (a beam inside an assembly inside a storey), which a
  // naive walk of IfcRelContainedInSpatialStructure misses.
  if (hierarchy) {
    for (const [storeyExpressId, elevation] of hierarchy.storeyElevations) {
      const globalId = idOf.get(storeyExpressId)
      const n = globalId ? nodes.get(globalId) : null
      if (n) n.elevation = elevation
    }

    walkSpatial(hierarchy.project, null)

    const containment = hierarchy.elementToContainer ?? hierarchy.elementToStorey
    for (const [elementExpressId, containerExpressId] of containment) {
      const from = idOf.get(containerExpressId)
      const to = idOf.get(elementExpressId)
      if (!from || !to || from === to) continue
      edges.push({ kind: 'containsElement', from, to, provenance: 'declared' })
    }

    // Storey resolution is a separate map: an element contained in a space is
    // still on a storey, and both facts are wanted.
    for (const [elementExpressId, storeyExpressId] of hierarchy.elementToStorey) {
      const elementId = idOf.get(elementExpressId)
      const storeyId = idOf.get(storeyExpressId)
      const n = elementId ? nodes.get(elementId) : null
      if (!n || !storeyId) continue
      n.storeyGlobalId = storeyId
      n.storeyName = nodes.get(storeyId)?.name ?? null
    }
  }

  function walkSpatial(spatialNode: { expressId: number; children?: unknown[] } | undefined, parentId: string | null): void {
    if (!spatialNode) return
    const globalId = idOf.get(spatialNode.expressId) ?? null
    if (globalId && parentId) {
      edges.push({ kind: 'hasSubElement', from: parentId, to: globalId, provenance: 'declared' })
    }
    const children = (spatialNode.children ?? []) as Array<{ expressId: number; children?: unknown[] }>
    for (const child of children) walkSpatial(child, globalId ?? parentId)
  }

  options.onProgress?.('relations')

  // ── Declared relations ────────────────────────────────────────────────────
  // Each block reads one IFC relation and orients it by what the endpoints ARE,
  // never by which side the parser calls `forward`.
  for (const [expressId, globalId] of idOf) {
    const node = nodes.get(globalId)
    if (!node) continue

    for (const otherExpressId of related(store, expressId, RelationshipType.VoidsElement)) {
      const otherId = idOf.get(otherExpressId)
      const other = otherId ? nodes.get(otherId) : null
      if (!other || !otherId) continue
      // The opening is the void; the other end is the element it is cut out of.
      if (other.kind === 'opening' && node.kind !== 'opening') {
        edges.push({ kind: 'voids', from: globalId, to: otherId, provenance: 'declared' })
      }
    }

    for (const otherExpressId of related(store, expressId, RelationshipType.FillsElement)) {
      const otherId = idOf.get(otherExpressId)
      const other = otherId ? nodes.get(otherId) : null
      if (!other || !otherId) continue
      if (node.kind === 'opening' && other.kind !== 'opening') {
        edges.push({ kind: 'fills', from: globalId, to: otherId, provenance: 'declared' })
      }
    }

    for (const otherExpressId of related(store, expressId, RelationshipType.SpaceBoundary)) {
      const otherId = idOf.get(otherExpressId)
      const other = otherId ? nodes.get(otherId) : null
      if (!other || !otherId) continue
      // Oriented space → bounding element, which is how the question is asked
      // ("what encloses this room"). The reverse is one index lookup away.
      if (node.kind === 'space' && other.kind !== 'space') {
        edges.push({ kind: 'interfaceOf', from: globalId, to: otherId, provenance: 'declared' })
      } else if (other.kind === 'space' && node.kind !== 'space') {
        edges.push({ kind: 'interfaceOf', from: otherId, to: globalId, provenance: 'declared' })
      } else if (node.kind === 'space' && other.kind === 'space' && expressId < otherExpressId) {
        // A boundary with a space on BOTH sides is two rooms meeting through a
        // virtual element. `interfaceOf` cannot express it — it points at a
        // bounding ELEMENT — and dropping it lost the adjacency entirely, which
        // is the one fact such a boundary exists to state. It is the same claim
        // `adjacentZone` makes, so it is recorded there, and as `declared`
        // rather than `computed` because here the file says so outright.
        edges.push({ kind: 'adjacentZone', from: globalId, to: otherId, provenance: 'declared', via: 'virtual space boundary' })
      }
    }

    for (const relType of [RelationshipType.ConnectsPathElements, RelationshipType.ConnectsElements]) {
      for (const otherExpressId of related(store, expressId, relType)) {
        const otherId = idOf.get(otherExpressId)
        if (!otherId || otherId === globalId) continue
        // Symmetric in meaning; stored once, in express-id order, so a pair
        // cannot appear twice with the ends swapped.
        if (expressId < otherExpressId) {
          edges.push({ kind: 'connects', from: globalId, to: otherId, provenance: 'declared' })
        }
      }
    }

    for (const otherExpressId of related(store, expressId, RelationshipType.AssignsToGroup)) {
      const otherId = idOf.get(otherExpressId)
      const other = otherId ? nodes.get(otherId) : null
      if (!other || !otherId) continue
      if (other.kind === 'group' && node.kind !== 'group') {
        edges.push({ kind: 'inGroup', from: globalId, to: otherId, provenance: 'declared' })
      }
    }

    // Aggregates is the one relation whose direction cannot be recovered from
    // its endpoints: an IfcElementAssembly aggregating an IfcBeam has no
    // container kind on either side, so "whole" and "part" are distinguishable
    // only by which side of the relation each sat on. Reading both directions
    // here — correct everywhere else, because everywhere else the endpoints
    // carry the answer — produced `hasSubElement: Wohnzimmer → Erdgeschoss`,
    // i.e. the storey as a part of the room.
    //
    // So this block, alone, trusts `forward`, which the parser orients
    // RelatingObject → RelatedObjects. Verified against a fixture rather than
    // assumed: a storey's forward edges are its spaces, a space's are empty.
    for (const otherExpressId of relatedForward(store, expressId, RelationshipType.Aggregates)) {
      const otherId = idOf.get(otherExpressId)
      if (!otherId || otherId === globalId || !nodes.get(otherId)) continue
      // The spatial walk above already covered project → site → building →
      // storey → space, so this adds element assemblies without duplicating it.
      if (CONTAINER_KIND[nodes.get(globalId)!.ifcType]) continue
      edges.push({ kind: 'hasSubElement', from: globalId, to: otherId, provenance: 'declared' })
    }
  }

  // ── Derived relations ─────────────────────────────────────────────────────
  //
  // Deduplicate BEFORE indexing. `related()` reads a relation from both ends by
  // design, so every declared edge is pushed twice — once while visiting each
  // endpoint — and the duplicates are harmless in the edge list only because
  // `dedupe` runs later. Indexing the raw array made them visible to the
  // derivations: `interfaceOf` came back as `[Wohnzimmer, Wohnzimmer]` for a
  // wall bounding one room, which passed the `length < 2` guard and produced
  // `adjacentZone: Wohnzimmer → Wohnzimmer`. A room adjacent to itself, from a
  // correct file.
  options.onProgress?.('derive')
  dedupe(edges)
  const index = buildIndex(edges)

  // hostedIn: filler → host, through the opening that joins them. This is the
  // window↔wall relation, and it is a two-hop walk of edges the file states.
  for (const openingId of byType.get('IfcOpeningElement') ?? []) {
    deriveHost(openingId)
  }
  for (const type of OPENING_TYPES) {
    if (type === 'IfcOpeningElement') continue
    for (const openingId of byType.get(type) ?? []) deriveHost(openingId)
  }

  function deriveHost(openingId: string): void {
    const hosts = index.in.get('voids')?.get(openingId) ?? []
    const fillers = index.out.get('fills')?.get(openingId) ?? []
    for (const filler of fillers) {
      for (const host of hosts) {
        edges.push({ kind: 'hostedIn', from: filler, to: host, provenance: 'computed', via: 'voids+fills' })
      }
    }
  }

  // adjacentZone: two spaces bounded by the same element are neighbours. Pure
  // topology — no geometry, no tolerance, and true whenever the export wrote
  // space boundaries at all.
  const spacesByBoundary = index.in.get('interfaceOf') ?? new Map<string, string[]>()
  for (const [, spaces] of spacesByBoundary) {
    if (spaces.length < 2) continue
    for (let i = 0; i < spaces.length; i++) {
      for (let j = i + 1; j < spaces.length; j++) {
        edges.push({
          kind: 'adjacentZone',
          from: spaces[i]!,
          to: spaces[j]!,
          provenance: 'computed',
          via: 'shared bounding element',
        })
      }
    }
  }

  // opensTo: a window or door opens into every space bounded by its host wall,
  // and into any space that bounds it directly.
  //
  // Openings are subjects here too, not only their fillers. An
  // IfcOpeningElement reaches its host through `voids` rather than `hostedIn`,
  // and restricting this to `kind === 'element'` meant asking an opening what
  // it opens into always answered "nothing" — a confident empty result for a
  // question the file can answer.
  dedupe(edges)
  const index2 = buildIndex(edges)
  for (const [globalId, node] of nodes) {
    if (node.kind !== 'element' && node.kind !== 'opening') continue
    const hosts =
      node.kind === 'opening'
        ? index2.in.get('voids')?.get(globalId) ?? []
        : index2.out.get('hostedIn')?.get(globalId) ?? []
    // No host means this is not something sitting IN a wall, and only such an
    // element opens into anything. Without this guard the direct-boundary
    // branch below fires for every bounding element, so each wall "opened
    // into" the rooms it encloses — true of a doorway, nonsense about a wall.
    if (hosts.length === 0) continue
    const spaces = new Set<string>()
    for (const host of hosts) {
      for (const space of index2.in.get('interfaceOf')?.get(host) ?? []) spaces.add(space)
    }
    for (const space of index2.in.get('interfaceOf')?.get(globalId) ?? []) spaces.add(space)
    for (const space of spaces) {
      edges.push({
        kind: 'opensTo',
        from: globalId,
        to: space,
        provenance: 'computed',
        via: node.kind === 'opening' ? 'voids+interfaceOf' : 'hostedIn+interfaceOf',
      })
    }
  }

  dedupe(edges)
  const finalIndex = buildIndex(edges)

  options.onProgress?.('dialect')
  const dialectSampleSize = options.dialectSampleSize ?? 4000
  const { dialect, sampled } = measureDialect(store, nodes, dialectSampleSize)

  const storeys = [...(byType.get('IfcBuildingStorey') ?? [])]
    .map((id) => nodes.get(id)!)
    .filter(Boolean)
    .sort(byElevation)

  const header = store.sourceHeader
  const edgesByKind: Record<string, number> = {}
  for (const edge of edges) edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1

  const graph: BuildingGraph = {
    contentHash,
    schema: store.schemaVersion,
    sourceName: header?.name ?? null,
    originatingSystem: header?.originatingSystem ?? null,
    units: { length: lengthUnitOf(store) },
    trueNorth: trueNorthOf(store),
    georeferenced: isGeoreferenced(store),
    nodes,
    edges,
    out: finalIndex.out,
    in: finalIndex.in,
    byType,
    storeys,
    dialect,
    blindSpots: [],
    stats: {
      entities: store.entityCount,
      nodes: nodes.size,
      edges: edges.length,
      edgesByKind,
      parseMs,
      buildMs: Date.now() - t1,
      fileSizeBytes: bytes.byteLength,
    },
  }

  graph.blindSpots = findBlindSpots(graph, sampled ? dialectSampleSize : null)
  return graph
}

// ── helpers ─────────────────────────────────────────────────────────────────

function related(store: { relationships: { getRelated(id: number, t: number, d: 'forward' | 'inverse'): number[] } }, expressId: number, relType: number): number[] {
  // Both directions, because orientation is decided by node kind downstream and
  // a relation we only half-read is a relation we half-lose.
  const forward = safe(() => store.relationships.getRelated(expressId, relType, 'forward'))
  const inverse = safe(() => store.relationships.getRelated(expressId, relType, 'inverse'))
  return forward.length || inverse.length ? [...new Set([...forward, ...inverse])] : []
}

/** One direction only — for the relations whose meaning IS the direction. */
function relatedForward(store: { relationships: { getRelated(id: number, t: number, d: 'forward' | 'inverse'): number[] } }, expressId: number, relType: number): number[] {
  return safe(() => store.relationships.getRelated(expressId, relType, 'forward'))
}

function safe(fn: () => number[]): number[] {
  try {
    return fn() ?? []
  } catch {
    return []
  }
}

function isProductType(ifcType: string): boolean {
  if (ifcType.startsWith('IfcRel')) return false
  if (NON_PRODUCT_ROOTS.has(ifcType)) return false
  // IfcTypeObject subtypes (IfcWallType, IfcDoorStyle, …) are definitions, not
  // occurrences. They carry GlobalIds and would otherwise double every element.
  if (/(Type|Style)$/.test(ifcType) && ifcType !== 'IfcSpaceType') return false
  return true
}

function kindOf(ifcType: string): NodeKind {
  if (CONTAINER_KIND[ifcType]) return CONTAINER_KIND[ifcType]!
  if (SPACE_TYPES.has(ifcType)) return 'space'
  if (OPENING_TYPES.has(ifcType)) return 'opening'
  if (GROUP_TYPES.has(ifcType)) return 'group'
  return 'element'
}

/**
 * Attribute positions, by name, from the parser's own schema registry.
 *
 * Reading STEP attributes by position is the obvious approach and it is wrong
 * in a way that produces plausible values rather than errors. `PredefinedType`
 * is the last attribute on an `IfcWall` and the second-to-last on an `IfcSpace`
 * — whose actual last attribute is `ElevationWithFlooring`, and whose
 * second-to-last, when `PredefinedType` is unset, is the `CompositionType`
 * enum. A positional read therefore reported every room's PredefinedType as
 * `ELEMENT`: a real-looking enum, from the right file, off by one attribute.
 *
 * The registry knows the true index per type and per schema, so nothing here
 * has to guess.
 */
const ATTRIBUTE_NAMES = new Map<string, readonly string[] | null>()

function attributeOf(entity: { attributes: unknown[] }, ifcType: string, name: string): unknown {
  let names = ATTRIBUTE_NAMES.get(ifcType)
  if (names === undefined) {
    names = safeAttributeNames(ifcType)
    ATTRIBUTE_NAMES.set(ifcType, names)
  }
  if (!names) return undefined
  const index = names.indexOf(name)
  return index >= 0 ? entity.attributes[index] : undefined
}

function safeAttributeNames(ifcType: string): readonly string[] | null {
  try {
    return getAttributeNamesAcrossSchemas(ifcType) ?? null
  } catch {
    return null
  }
}

function predefinedTypeOf(entity: { attributes: unknown[] }, ifcType: string): string | null {
  const raw = attributeOf(entity, ifcType, 'PredefinedType')
  if (typeof raw !== 'string') return null
  return /^\.[A-Z0-9_]+\.$/.test(raw) ? raw.slice(1, -1) : null
}

/**
 * `LongName` — the label a person reads.
 *
 * Spatial elements routinely carry an ISO 19650 code in `Name` (`R.01`) and the
 * human name in `LongName` (`Wohnzimmer`). An answer that calls a room `R.01`
 * when the file also says `Wohnzimmer` is technically sourced and useless to
 * the reader.
 */
function longNameOf(entity: { attributes: unknown[] }, ifcType: string): string | null {
  const raw = attributeOf(entity, ifcType, 'LongName')
  return typeof raw === 'string' ? nonEmpty(raw) : null
}

function nonEmpty(value: string | undefined | null): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed.length > 0 ? trimmed : null
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function buildIndex(edges: GraphEdge[]): { out: Map<EdgeKind, Map<string, string[]>>; in: Map<EdgeKind, Map<string, string[]>> } {
  const out = new Map<EdgeKind, Map<string, string[]>>()
  const inn = new Map<EdgeKind, Map<string, string[]>>()
  for (const edge of edges) {
    if (!out.has(edge.kind)) out.set(edge.kind, new Map())
    if (!inn.has(edge.kind)) inn.set(edge.kind, new Map())
    push(out.get(edge.kind)!, edge.from, edge.to)
    push(inn.get(edge.kind)!, edge.to, edge.from)
  }
  return { out, in: inn }
}

function dedupe(edges: GraphEdge[]): void {
  const seen = new Set<string>()
  let write = 0
  for (let read = 0; read < edges.length; read++) {
    const edge = edges[read]!
    const key = `${edge.kind} ${edge.from} ${edge.to}`
    if (seen.has(key)) continue
    seen.add(key)
    edges[write++] = edge
  }
  edges.length = write
}

function byElevation(a: GraphNode, b: GraphNode): number {
  if (a.elevation === null && b.elevation === null) return (a.name ?? '').localeCompare(b.name ?? '')
  if (a.elevation === null) return 1
  if (b.elevation === null) return -1
  return a.elevation - b.elevation
}

/** SI prefixes IFC uses for a length unit, as factors on the base metre. */
const SI_PREFIX: Record<string, number> = {
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 1e1,
  DECI: 1e-1,
  CENTI: 1e-2,
  MILLI: 1e-3,
  MICRO: 1e-6,
}

/**
 * The file's declared length unit.
 *
 * Worth reading even though the parser hands storey elevations back already
 * converted: an answer that prints a number has to name a unit, and "the
 * elevations happen to be metres" is not the same statement as "this file is
 * authored in millimetres" — which is what an architect recognises their own
 * model by.
 *
 * A file using `IfcConversionBasedUnit` (feet, inches) yields `null` rather
 * than a wrong metre factor. Saying nothing is recoverable; saying `1.0` about
 * a file drawn in feet is not.
 */
function lengthUnitOf(store: IfcStoreLike): UnitInfo | null {
  for (const expressId of typeIds(store, 'IFCSIUNIT')) {
    const entity = store.getEntity(expressId)
    if (!entity) continue
    const [, unitType, prefix, name] = entity.attributes as Array<unknown>
    if (unitType !== '.LENGTHUNIT.' || name !== '.METRE.') continue
    const prefixName = typeof prefix === 'string' ? prefix.replace(/^\.|\.$/g, '') : ''
    const scale = prefixName ? SI_PREFIX[prefixName] : 1
    if (!scale) continue
    return { symbol: prefixName ? `${prefixName.slice(0, 1).toLowerCase()}m` : 'm', toMetres: scale }
  }
  return null
}

/**
 * True north, as an angle in radians from the +Y axis.
 *
 * `IfcGeometricRepresentationContext.TrueNorth` is an `IfcDirection` whose
 * ratios point north in project coordinates. Absent it, a facade's compass
 * orientation is unknowable — and the honest value is `null`, never 0. A
 * defaulted zero is a claim that the model is aligned to north, which is the
 * kind of assumption that turns into "diese Fassade liegt im Süden" about a
 * building rotated forty degrees.
 */
function trueNorthOf(store: IfcStoreLike): number | null {
  for (const expressId of typeIds(store, 'IFCGEOMETRICREPRESENTATIONCONTEXT')) {
    const context = store.getEntity(expressId)
    if (!context) continue
    const ref = attributeOf(context, 'IfcGeometricRepresentationContext', 'TrueNorth')
    if (typeof ref !== 'number') continue
    const direction = store.getEntity(ref)
    const ratios = direction?.attributes?.[0]
    if (!Array.isArray(ratios) || ratios.length < 2) continue
    const [x, y] = ratios as number[]
    if (typeof x !== 'number' || typeof y !== 'number' || (x === 0 && y === 0)) continue
    return Math.atan2(x, y)
  }
  return null
}

/** Whether the file places itself on the earth (IfcMapConversion or a site location). */
function isGeoreferenced(store: IfcStoreLike): boolean {
  try {
    return extractGeoreferencingOnDemand(store as never)?.hasGeoreference === true
  } catch {
    return false
  }
}

function typeIds(store: IfcStoreLike, upperType: string): number[] {
  return store.entityIndex.byType.get(upperType) ?? []
}

interface IfcStoreLike {
  entityIndex: { byType: { get(key: string): number[] | undefined } }
  getEntity(expressId: number): { attributes: unknown[] } | null
}

/**
 * What this file calls things, measured on the elements themselves.
 *
 * Filter on a property name this exporter never wrote and the result is zero
 * rows, which reads as "the building has none" — the single most common way a
 * model question gets a confidently wrong answer. The cure is to publish the
 * vocabulary rather than warn the reader to guess carefully.
 */
function measureDialect(
  store: { getProperties(id: number): Array<{ name: string; properties: Array<{ name: string; value: unknown }> }> },
  nodes: Map<string, GraphNode>,
  sampleSize: number
): { dialect: DialectEntry[]; sampled: boolean } {
  const candidates = [...nodes.values()].filter((n) => n.kind === 'element' || n.kind === 'space')
  const sampled = candidates.length > sampleSize
  const scan = sampled ? candidates.slice(0, sampleSize) : candidates

  const acc = new Map<string, { set: string; property: string; filled: number; sample: Set<string | number | boolean> }>()

  for (const node of scan) {
    let sets: Array<{ name: string; properties: Array<{ name: string; value: unknown }> }> = []
    try {
      sets = store.getProperties(node.expressId) ?? []
    } catch {
      continue
    }
    for (const set of sets) {
      for (const property of set.properties ?? []) {
        if (property.value === null || property.value === undefined || property.value === '') continue
        const key = `${set.name} ${property.name}`
        let entry = acc.get(key)
        if (!entry) {
          entry = { set: set.name, property: property.name, filled: 0, sample: new Set() }
          acc.set(key, entry)
        }
        entry.filled++
        if (entry.sample.size < 6 && (typeof property.value === 'string' || typeof property.value === 'number' || typeof property.value === 'boolean')) {
          entry.sample.add(property.value)
        }
      }
    }
  }

  const dialect = [...acc.values()]
    .map((entry) => ({
      set: entry.set,
      property: entry.property,
      filled: entry.filled,
      candidates: scan.length,
      sample: [...entry.sample],
    }))
    .sort((a, b) => b.filled - a.filled)

  return { dialect, sampled }
}

/**
 * What this file cannot answer, worked out before anybody asks.
 *
 * The point is to move the discovery of a gap from the end of a long agent turn
 * to the beginning of it. An agent told up front that this export wrote no
 * space boundaries does not spend six tool calls finding out, and does not
 * report "the building has no rooms" when the truth is "this export omitted a
 * relation".
 */
function findBlindSpots(graph: BuildingGraph, dialectSample: number | null): BlindSpot[] {
  const spots: BlindSpot[] = []
  const count = (kind: EdgeKind) => graph.stats.edgesByKind[kind] ?? 0
  const spaces = (graph.byType.get('IfcSpace') ?? []).length + (graph.byType.get('IfcSpatialZone') ?? []).length
  const fillers = ['IfcWindow', 'IfcDoor'].reduce((sum, t) => sum + (graph.byType.get(t) ?? []).length, 0)

  if (spaces === 0) {
    spots.push({
      what: 'keine IfcSpace-Elemente',
      consequence: 'Raumflächen, Raumtiefen und alles je Aufenthaltsraum sind nicht ableitbar',
      remedy: 'Räume im CAD als IfcSpace exportieren',
    })
  }
  if (count('interfaceOf') === 0 && spaces > 0) {
    spots.push({
      what: 'keine IfcRelSpaceBoundary',
      consequence: 'welche Wände einen Raum begrenzen und welche Räume aneinandergrenzen ist nicht deklariert',
      remedy: 'Space Boundaries (2nd level) mitexportieren — in Revit/ArchiCAD eine Exporteinstellung',
    })
  }
  if (count('fills') === 0 && fillers > 0) {
    spots.push({
      what: 'keine IfcRelFillsElement',
      consequence: `${fillers} Fenster/Türen lassen sich keiner Wand zuordnen`,
      remedy: 'Öffnungen und Füllungen mitexportieren',
    })
  }
  if (graph.trueNorth === null) {
    spots.push({
      what: 'keine Nordrichtung',
      consequence: 'Fassadenorientierung (Süd/Nord) ist nicht bestimmbar',
      remedy: 'TrueNorth im IfcGeometricRepresentationContext setzen',
    })
  }
  if (!graph.georeferenced) {
    spots.push({
      what: 'keine Georeferenzierung',
      consequence: 'Sonnenstand und Besonnung sind nicht berechenbar (der geometrische 45°-Nachweis bleibt möglich)',
      remedy: 'IfcMapConversion bzw. RefLatitude/RefLongitude setzen',
    })
  }
  spots.push({
    what: 'keine Geometrie in dieser Ausbaustufe',
    consequence:
      'Abstände, lichte Maße, Auskragungen, Flächen aus Geometrie und der freie Lichteinfall sind noch nicht berechenbar',
    remedy: 'Phase 1 dieses Dienstes (Geometrie-Pass) aktivieren',
  })
  if (dialectSample !== null) {
    spots.push({
      what: `Dialekt aus einer Stichprobe von ${dialectSample} Bauteilen`,
      consequence: 'Befüllungsgrade sind Anteile der Stichprobe, nicht des Modells',
      remedy: 'dialectSampleSize erhöhen',
    })
  }
  return spots
}
