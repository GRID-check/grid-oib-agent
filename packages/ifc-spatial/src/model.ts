/**
 * A model as a caller actually wants it: the graph, the geometry, and the
 * relations that only exist once both are in hand.
 *
 * ## Why this is not just `buildGraph`
 *
 * The topological half and the geometric half are separable in the code and not
 * in the questions. "Which room does this window serve" is a topological
 * question that most real exports cannot answer topologically, because they
 * write no `IfcRelSpaceBoundary` — the sample house this library was measured
 * against has none, and neither do most Revit exports without a deliberate
 * setting. The relation has to be recovered from geometry and then folded back
 * into the graph, at which point `opensTo` starts working and says, correctly,
 * that it measured rather than read.
 *
 * Leaving that composition to each caller means each caller gets it slightly
 * wrong, and the ones who forget it entirely conclude the building has no
 * rooms.
 *
 * ## Degradation is a property, not an error
 *
 * The geometry kernel is WASM and can fail to initialise — an old runtime, a
 * locked-down container. When it does, this returns a model with `geometry:
 * null` and a stated reason rather than throwing: every topological answer is
 * still available and correct, and the metric ones become `decidable: false`
 * with a reason a human can act on. A library that refuses to open a building
 * at all because it could not tessellate it has turned a partial answer into no
 * answer.
 */

import { buildGraph, findBlindSpots, type BuildOptions, type GeometryStatus } from './graph/build.js'
import { runGeometryPass, type GeometryIndex, type GeometryOptions } from './geometry/pass.js'
import { withDerivedBoundaries, type BoundaryOptions } from './geometry/boundaries.js'
import type { BuildingGraph } from './graph/types.js'

export interface SpatialModel {
  /** Topology, with geometry-derived boundaries folded in when available. */
  graph: BuildingGraph
  /** `null` when the geometry pass was skipped or could not run. */
  geometry: GeometryIndex | null
  /** Why there is no geometry, when there is none. Present only then. */
  geometryUnavailable?: string
  contentHash: string
}

export interface OpenOptions extends BuildOptions {
  /** Skip the geometry pass entirely — topology only, and much faster. */
  skipGeometry?: boolean
  geometry?: GeometryOptions
  boundaries?: BoundaryOptions
}

export async function openModel(bytes: Uint8Array, options: OpenOptions = {}): Promise<SpatialModel> {
  const base = await buildGraph(bytes, options)

  if (options.skipGeometry) {
    const unavailable = 'Geometrie-Pass wurde übersprungen'
    return {
      graph: withBlindSpots(base, { unavailable, elementsWithGeometry: 0, spacesWithGeometry: 0, spaces: countSpaces(base), truncated: false, triangles: 0, retainedTriangles: 0 }),
      geometry: null,
      geometryUnavailable: unavailable,
      contentHash: base.contentHash,
    }
  }

  let geometry: GeometryIndex
  try {
    geometry = await runGeometryPass(bytes, base, options.geometry ?? {})
  } catch (error) {
    const unavailable =
      `Geometrie konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}. ` +
      'Topologische Fragen sind unverändert beantwortbar, alle Maße nicht.'
    return {
      graph: withBlindSpots(base, { unavailable, elementsWithGeometry: 0, spacesWithGeometry: 0, spaces: countSpaces(base), truncated: false, triangles: 0, retainedTriangles: 0 }),
      geometry: null,
      geometryUnavailable: unavailable,
      contentHash: base.contentHash,
    }
  }

  // Only when the file itself declares no boundaries is anything derived —
  // `withDerivedBoundaries` refuses to duplicate a declared relation, so this is
  // safe on a file that has them and load-bearing on the many that do not.
  const bounded = withDerivedBoundaries(base, geometry, options.boundaries ?? {})

  // Blind spots are recomputed HERE and not left as `buildGraph` wrote them.
  //
  // `buildGraph` runs before the geometry pass by construction, so the list it
  // produces has to assume the worst about geometry — and the assumption it
  // used to bake in ("keine Geometrie in dieser Ausbaustufe") was then reported
  // verbatim on models whose every element had just been tessellated. An agent
  // reading that stops asking exactly the questions this library exists to
  // answer. What replaces it is what the pass actually found: whether it ran,
  // whether retention was capped, and which rooms came back without a solid.
  const spaces = countSpaces(bounded)
  let spacesWithGeometry = 0
  for (const node of bounded.nodes.values()) {
    if (node.kind === 'space' && geometry.elements.has(node.globalId)) spacesWithGeometry++
  }
  const graph = withBlindSpots(bounded, {
    unavailable: null,
    elementsWithGeometry: geometry.stats.elementsWithGeometry,
    spacesWithGeometry,
    spaces,
    truncated: geometry.stats.trianglesTruncated,
    triangles: geometry.stats.triangles,
    retainedTriangles: geometry.stats.retainedTriangles,
  })
  return { graph, geometry, contentHash: base.contentHash }
}

function countSpaces(graph: BuildingGraph): number {
  let n = 0
  for (const node of graph.nodes.values()) if (node.kind === 'space') n++
  return n
}

function withBlindSpots(graph: BuildingGraph, status: GeometryStatus): BuildingGraph {
  return { ...graph, blindSpots: findBlindSpots(graph, graph.dialectSampleSize, status) }
}

/**
 * Opened models, keyed by the hash of their bytes.
 *
 * Separate from {@link GraphCache} rather than an option on it, because the two
 * hold different things at different costs: a graph is kilobytes and a model
 * with retained triangles is tens of megabytes. Bounding them with one budget
 * would mean either evicting cheap graphs to make room for expensive geometry
 * or keeping expensive geometry alive under a limit sized for graphs.
 *
 * The bound here is therefore an entry count and not a byte estimate. An
 * estimate that cannot be trusted is worse than an honest coarse limit — the
 * dominant term is the retained triangle array, which `GeometryIndex.stats`
 * reports exactly, so a host that needs a byte budget can impose one from real
 * numbers instead of from a guess made here.
 */
export class SpatialCache {
  readonly #models = new Map<string, SpatialModel>()
  readonly #inFlight = new Map<string, Promise<SpatialModel>>()
  readonly #maxEntries: number
  #hits = 0
  #misses = 0

  constructor(options: { maxEntries?: number } = {}) {
    this.#maxEntries = Math.max(1, options.maxEntries ?? 4)
  }

  get stats(): { hits: number; misses: number; entries: number } {
    return { hits: this.#hits, misses: this.#misses, entries: this.#models.size }
  }

  /**
   * How many models this cache will hold at once.
   *
   * Exposed so a caller that keeps its OWN references to loaded models can size
   * that table from this number instead of picking a second, unrelated limit.
   * Two lids on the same models, chosen independently, means the larger one is
   * the real lid and the smaller one is decoration — and the larger one is
   * whichever was written by whoever last thought about it.
   */
  get maxEntries(): number {
    return this.#maxEntries
  }

  get(hash: string): SpatialModel | null {
    const model = this.#models.get(hash)
    if (!model) return null
    // Re-insert so Map insertion order stays LRU order.
    this.#models.delete(hash)
    this.#models.set(hash, model)
    return model
  }

  async load(bytes: Uint8Array, options: OpenOptions = {}): Promise<SpatialModel> {
    const { createHash } = await import('node:crypto')
    const hash = createHash('sha256').update(bytes).digest('hex')

    const resident = this.get(hash)
    if (resident) {
      this.#hits++
      return resident
    }
    const running = this.#inFlight.get(hash)
    if (running) {
      this.#hits++
      return running
    }

    this.#misses++
    // Single-flight for the reason it matters more here than for graphs: two
    // concurrent opens of a 150 MB model would run two geometry passes and hold
    // two full triangle sets at the same instant, which is precisely when memory
    // is tightest.
    const work = openModel(bytes, options).then((model) => {
      this.#models.set(hash, model)
      while (this.#models.size > this.#maxEntries) {
        const oldest = this.#models.keys().next().value
        if (oldest === undefined || oldest === hash) break
        this.#models.delete(oldest)
      }
      return model
    })
    const tracked = work.finally(() => this.#inFlight.delete(hash))
    this.#inFlight.set(hash, tracked)
    return tracked
  }

  clear(): void {
    this.#models.clear()
  }
}
