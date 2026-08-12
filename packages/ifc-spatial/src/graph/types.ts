/**
 * The building graph: what the agent reasons over.
 *
 * ## Why a graph and not a table
 *
 * An IFC element table answers questions about elements considered one at a
 * time. Almost every question an architect actually has is about an
 * ARRANGEMENT — which window sits in which wall, which rooms share it, what is
 * above what — and no column can hold that. The relations are already in the
 * file; they are simply thrown away by every pipeline that flattens IFC into
 * rows.
 *
 * ## Why these edge names
 *
 * They follow the W3C Linked Building Data group's **Building Topology
 * Ontology** (BOT) where BOT has a name for the thing: `containsElement`,
 * `adjacentElement`, `adjacentZone`, `hasSubElement`, `interfaceOf`. A
 * published vocabulary argued over by other people beats a private one, and it
 * makes an RDF projection later a rename rather than a redesign. Where IFC has
 * a relation BOT does not model — `voids`, `fills`, `connects` — the IFC name
 * is kept verbatim rather than paraphrased.
 *
 * ## Every edge knows how it got here
 *
 * `provenance: 'declared'` means an IfcRel* in the file says so.
 * `'computed'` means we derived it — from other edges at phase 0, from geometry
 * later. `'inferred'` means a heuristic.
 *
 * The distinction is load-bearing, not decorative: an agent answering "which
 * rooms does this door connect" must be able to say whether the file states it
 * or whether we worked it out, because the two carry different weight in front
 * of a building authority.
 */

import type { Provenance } from '../envelope.js'

/** What a node is, coarsely. Finer detail lives in `ifcType`. */
export type NodeKind =
  | 'project'
  | 'site'
  | 'building'
  | 'storey'
  | 'space'
  | 'element'
  | 'opening'
  | 'group'

/**
 * Edge kinds, all directed.
 *
 * Direction is stated per kind because "adjacent" reads as symmetric and is
 * stored once; traversal helpers expose both directions rather than the graph
 * storing each pair twice.
 */
export type EdgeKind =
  /** zone → element it contains (IfcRelContainedInSpatialStructure). */
  | 'containsElement'
  /** whole → part (IfcRelAggregates), including project → site → building → storey. */
  | 'hasSubElement'
  /** element → the opening cut out of it (IfcRelVoidsElement). */
  | 'voids'
  /** opening → the element filling it (IfcRelFillsElement). */
  | 'fills'
  /** window/door → the wall it sits in. Derived from voids+fills. */
  | 'hostedIn'
  /** space → bounding element (IfcRelSpaceBoundary). BOT: interfaceOf. */
  | 'interfaceOf'
  /** element ↔ element (IfcRelConnectsPathElements / IfcRelConnectsElements). */
  | 'connects'
  /** element/space → the IfcZone or IfcGroup it belongs to. */
  | 'inGroup'
  /** space ↔ space sharing a bounding element. Derived. */
  | 'adjacentZone'
  /** opening or its filler → a space it opens into. Derived. */
  | 'opensTo'

export interface GraphNode {
  /** IFC GlobalId — the identity that survives a re-export. */
  globalId: string
  /** STEP express id. Unique within THIS file only; kept for viewer selection. */
  expressId: number
  kind: NodeKind
  /** Canonical PascalCase entity name, e.g. `IfcWall`. */
  ifcType: string
  name: string | null
  /** `IfcSpace.LongName` and friends — the human label when `name` is a code. */
  longName: string | null
  predefinedType: string | null
  /** Storey elevation in the file's length unit, for storey nodes. */
  elevation: number | null
  /** The storey this node resolves to, walking up containment. */
  storeyGlobalId: string | null
  storeyName: string | null
}

export interface GraphEdge {
  kind: EdgeKind
  /** GlobalId of the source node. */
  from: string
  /** GlobalId of the target node. */
  to: string
  provenance: Provenance
  /**
   * How this edge was obtained, for `computed` and `inferred` edges:
   * `"voids+fills"`, `"shared bounding element"`. Absent for declared edges,
   * whose IFC relation type is implied by `kind`.
   */
  via?: string
}

/**
 * The file's own vocabulary, measured rather than assumed.
 *
 * Property-set and quantity names are chosen by whichever application exported
 * the model, so "does this model publish U-values" is a question about THIS
 * file. `filled` is the count of elements carrying a non-null value, which is
 * the number that decides whether a filter on it will return anything.
 */
export interface DialectEntry {
  set: string
  property: string
  /** Elements carrying the property with a non-null value. */
  filled: number
  /**
   * Elements examined — the whole scan, not the elements whose type could
   * carry this property.
   *
   * The distinction matters because `filled / candidates` looks like a fill
   * rate and is not one: a FireRating found on 5 of 400 scanned elements is
   * "5 elements publish it", not "1 % of walls do", and the second sentence
   * would be wrong by however many of those 400 were windows. Working out the
   * real denominator needs a map from property set to the types allowed to
   * carry it, which this library does not have — so the honest reading is an
   * absolute count against a stated scan size, and consumers should print it
   * that way.
   */
  candidates: number
  /** Distinct values seen, capped — enough to recognise an enum from a measure. */
  sample: Array<string | number | boolean>
}

/** Something this file cannot answer, known before anybody asks. */
export interface BlindSpot {
  what: string
  consequence: string
  remedy: string
}

export interface UnitInfo {
  /** Symbol as declared, e.g. `mm`. */
  symbol: string
  /** Factor converting a value in this unit to metres. */
  toMetres: number
}

export interface BuildingGraph {
  /** sha256 of the source bytes — the cache key and the provenance of everything here. */
  contentHash: string
  schema: string
  /** FILE_NAME as authored, when the file carries one. */
  sourceName: string | null
  originatingSystem: string | null
  units: { length: UnitInfo | null }
  /**
   * True north as an angle in radians from +Y, when the file declares one.
   * `null` means the file does not say — and a facade orientation derived
   * without it is wrong by an unknown amount, so operators refuse rather than
   * assume zero.
   */
  trueNorth: number | null
  /** Whether the file carries an IfcMapConversion / RefLatitude. */
  georeferenced: boolean

  nodes: Map<string, GraphNode>
  edges: GraphEdge[]

  /** Adjacency, built once: `${kind}` → from → to[]. */
  out: Map<EdgeKind, Map<string, string[]>>
  /** The same, reversed. */
  in: Map<EdgeKind, Map<string, string[]>>

  /** GlobalIds per canonical IFC type. */
  byType: Map<string, string[]>
  /** Storeys, lowest first; storeys with no elevation sort last. */
  storeys: GraphNode[]

  dialect: DialectEntry[]
  blindSpots: BlindSpot[]

  stats: {
    entities: number
    nodes: number
    edges: number
    /** Per edge kind, so "this export wrote no space boundaries" is one lookup. */
    edgesByKind: Record<string, number>
    parseMs: number
    buildMs: number
    fileSizeBytes: number
  }
}

/** Targets of `kind` leaving `globalId`. */
export function out(graph: BuildingGraph, kind: EdgeKind, globalId: string): string[] {
  return graph.out.get(kind)?.get(globalId) ?? []
}

/** Sources of `kind` arriving at `globalId`. */
export function into(graph: BuildingGraph, kind: EdgeKind, globalId: string): string[] {
  return graph.in.get(kind)?.get(globalId) ?? []
}

/** Both directions, deduplicated — for the kinds that read as symmetric. */
export function around(graph: BuildingGraph, kind: EdgeKind, globalId: string): string[] {
  return [...new Set([...out(graph, kind, globalId), ...into(graph, kind, globalId)])]
}

export function node(graph: BuildingGraph, globalId: string): GraphNode | null {
  return graph.nodes.get(globalId) ?? null
}

/** A short human label for a node — what an answer should call it. */
export function label(n: GraphNode | null): string {
  if (!n) return 'unbekanntes Bauteil'
  const name = n.longName ?? n.name
  return name ? `${name} (${n.ifcType})` : `${n.ifcType} ${n.globalId}`
}
