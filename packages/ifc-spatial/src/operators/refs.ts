/**
 * What an element looks like when it is the ANSWER rather than the subject.
 *
 * The operators traverse a graph of GlobalIds, and a bare GlobalId is unusable
 * at both ends of the pipe: an agent cannot write a sentence about
 * `3Zq7$fRxT8kOa1bC2dE3fG`, and a reviewer cannot check one. So every operator
 * hands back the four fields needed to NAME the thing — plus `via`, which
 * records how it was reached whenever the edge that produced it was derived
 * rather than declared.
 *
 * `via` sits on the ref and not only on the {@link Answer} because a single
 * answer can mix routes later (a space reached through a shared wall is not the
 * same claim as one reached through a declared boundary), and the ref is where
 * that survives a `flatMap`.
 *
 * This module is deliberately tiny and dependency-free: every operator family —
 * topology, geometry, classification — returns `ElementRef[]`, so the refs one
 * operator emits are valid subjects for the next. That closure is what lets an
 * agent chain calls without a lookup table in between.
 */

import type { BuildingGraph, NodeKind } from '../graph/types.js'
import { node } from '../graph/types.js'

export interface ElementRef {
  globalId: string
  ifcType: string
  /**
   * The human label. `IfcSpace.LongName` wins over `Name` when both exist,
   * because a space's `Name` is routinely a room number (`1.14`) while the
   * name a person would use (`Wohnzimmer`) is in `LongName`. Same rule as
   * `label()` in the graph module, so an answer and a rendered node agree.
   */
  name: string | null
  kind: NodeKind
  /** How this ref was reached, when the edge that produced it was derived. */
  via?: string
}

/**
 * One ref, or `null` when the id names nothing in this graph.
 *
 * Returning `null` rather than throwing is the right call HERE and only here:
 * the ids fed to this function come off the graph's own adjacency index, so a
 * miss is a graph-consistency bug, not a caller mistake — and dropping the
 * dangling id degrades one answer instead of failing every answer that touches
 * it. A GlobalId that came from the CALLER is checked in the operator, where
 * the miss is genuinely the caller's, and throws there.
 */
export function toRef(graph: BuildingGraph, globalId: string, via?: string): ElementRef | null {
  const n = node(graph, globalId)
  if (!n) return null
  return {
    globalId: n.globalId,
    ifcType: n.ifcType,
    name: n.longName ?? n.name,
    kind: n.kind,
    ...(via ? { via } : {}),
  }
}

/**
 * Refs for a list of ids, in the order given, silently dropping unresolvable
 * ones (see {@link toRef}). The input order is the graph's edge-insertion
 * order, which is the file's order — stable across runs on the same bytes, so
 * two answers about the same model can be diffed.
 */
export function toRefs(graph: BuildingGraph, globalIds: string[], via?: string): ElementRef[] {
  const refs: ElementRef[] = []
  for (const id of globalIds) {
    const ref = toRef(graph, id, via)
    if (ref) refs.push(ref)
  }
  return refs
}
