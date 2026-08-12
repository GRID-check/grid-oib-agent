/**
 * `@grid/ifc-spatial` — spatial reasoning over IFC, for language agents.
 *
 * Give it the bytes of an IFC file and it gives back a typed building graph —
 * which window sits in which wall, which walls enclose which room, which rooms
 * are neighbours — plus a closed set of operators over that graph, each of which
 * answers in an {@link Answer} envelope that states how the value was obtained
 * and whether it could be obtained at all. The relations are already in the
 * file; every pipeline that flattens IFC into element rows throws them away, and
 * that is the gap this package closes.
 *
 * ## What it deliberately is not
 *
 * - **Not a renderer.** No tessellation, no meshes, no viewer. It reads a file
 *   and answers questions about it.
 * - **Not geometry — yet.** Phase 0 is pure topology: no distances, no clear
 *   widths, no overhangs, no 45° light prism, no areas computed from shape.
 *   Every one of those needs a geometry pass that is not here, and an operator
 *   that would need it returns `decidable: false` rather than an approximation.
 *   A guess with a unit attached is the one output this library will not produce.
 * - **Not multi-tenant.** There is no auth, no user, no organisation and no
 *   audit trail. A hash is not a permission: the host decides who may see which
 *   building, before the bytes reach {@link GraphCache}. Building that here
 *   would mean a second, weaker copy of the host's access rules.
 * - **Not a compliance checker.** It supplies the numbers a check is written
 *   against; which clause applies, and to what, is the host's judgment.
 */

// The answer contract: `Answer`, its provenance trichotomy, and the
// constructors every operator returns through.
export * from './envelope.js'

// IFC bytes → graph.
export { buildGraph, type BuildOptions } from './graph/build.js'

// The graph itself, and the traversal helpers. Named rather than starred so a
// collision with an operator's name is a compile error here, in one place,
// instead of an ambiguity a caller discovers.
export type {
  NodeKind,
  EdgeKind,
  GraphNode,
  GraphEdge,
  DialectEntry,
  BlindSpot,
  UnitInfo,
  BuildingGraph,
} from './graph/types.js'
export { out, into, around, node, label } from './graph/types.js'

// Content-addressed cache: the reason "just send the file" does not mean "parse
// it again every time".
export { GraphCache, estimateBytes, hashBytes, type GraphCacheOptions } from './cache.js'

// The operators. Topology answers arrangement questions, refs resolves the names
// a user says into the ids the graph speaks, model answers about the file as a
// whole (briefing, inventory, blind spots).
export * from './operators/topology.js'
export * from './operators/refs.js'
export * from './operators/model.js'

// Geometry, the operators built on it, and the drawing surface. Added as one
// block because they arrived together and are useless apart: a measurement
// without the pass that produced it, or a drawing without the measurements it
// annotates, is half a feature.
export * from './operators/constructive.js'
export * from './operators/metric.js'
export * from './render/project.js'
export * from './geometry/pass.js'
export * from './geometry/boundaries.js'
export * from './model.js'
