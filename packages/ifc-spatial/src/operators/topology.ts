/**
 * The topological operators: which thing sits in, bounds, fills or touches which.
 *
 * These are the questions the graph was built to answer, and every one of them
 * is a pure index lookup — no geometry, no tolerance, nothing to tune. "Which
 * wall is this window in", "what encloses this room", "which rooms are
 * neighbours" are all already in the file, and this module is the thin, closed
 * vocabulary over them: every operator takes a GlobalId and returns
 * {@link ElementRef}s that are themselves valid subjects for the next call.
 *
 * ## Three outcomes, never two
 *
 * The whole value of this module is that it distinguishes cases a `string[]`
 * return type collapses:
 *
 *   - **empty and decidable** — the element exists, the relation exists in this
 *     model, and this element takes part in none of it. `[]` is the truth.
 *   - **undecidable** — the RELATION is absent from the whole export. "Dieser
 *     Raum wird von nichts begrenzt" is a wrong answer; "dieser Export enthält
 *     keine Raumbegrenzungen" is a right one, and it is a finding the architect
 *     can act on. The {@link MissingFact} names the IFC relation and repeats the
 *     remedy the graph's own blind-spot list gives, so an agent that read the
 *     blind spots up front and one that hit this at call time say the same
 *     sentence.
 *   - **exception** — the GlobalId names nothing here. That is not a fact about
 *     the building at all; see {@link UnknownElementError}.
 *
 * A fourth case gets an undecidable rather than a throw: an operator called on
 * the wrong kind of element (`bounds()` on a wall). The caller is an agent
 * choosing operators from names, and mis-aiming is its most likely error, so the
 * answer says which kind was expected and which operator it probably wanted. A
 * thrown error there would cost a whole turn to recover from; an undecidable
 * with a suggestion costs one line of reasoning.
 */

import { computed, declared, undecidable, type Answer, type Provenance } from '../envelope.js'
import { around, into, node, out, type BuildingGraph, type EdgeKind, type GraphNode, type NodeKind } from '../graph/types.js'
import { toRef, toRefs, type ElementRef } from './refs.js'

/**
 * The caller could not look — as opposed to having looked and found nothing.
 *
 * envelope.ts reserves the exception for exactly this: `decidable: false` means
 * the question was well-formed and this file cannot answer it, which is a claim
 * about the EXPORT. An id that is not in the model supports no claim about the
 * export whatsoever; the id is wrong, or it belongs to a different file, or it
 * was invented. Handing that back as an undecidable would let a hallucinated
 * GlobalId be reported as "das Modell sagt dazu nichts" — the one failure mode
 * this library exists to prevent.
 */
export class UnknownElementError extends Error {
  constructor(
    readonly globalId: string,
    readonly method: string
  ) {
    super(`Unbekannte GlobalId "${globalId}" — dieses Modell enthält dieses Bauteil nicht (${method}).`)
    this.name = 'UnknownElementError'
  }
}

/**
 * The IFC relation behind each edge kind, and what to tell the architect.
 *
 * The remedies are lifted verbatim from `findBlindSpots` in build.ts rather than
 * paraphrased: the same gap must produce the same German sentence whether it is
 * discovered when the graph is built or when an operator is called, otherwise a
 * user gets two different instructions for one problem and trusts neither.
 */
const RELATIONS: Partial<Record<EdgeKind, { ifc: string; remedy: string }>> = {
  voids: {
    ifc: 'IfcRelVoidsElement',
    remedy: 'Öffnungen und Füllungen mitexportieren',
  },
  fills: {
    ifc: 'IfcRelFillsElement',
    remedy: 'Öffnungen und Füllungen mitexportieren',
  },
  interfaceOf: {
    ifc: 'IfcRelSpaceBoundary',
    remedy: 'Space Boundaries (2nd level) mitexportieren — in Revit/ArchiCAD eine Exporteinstellung',
  },
  connects: {
    ifc: 'IfcRelConnectsElements / IfcRelConnectsPathElements',
    remedy: 'Bauteilverbindungen mitexportieren — viele Exporte lassen sie weg',
  },
  containsElement: {
    ifc: 'IfcRelContainedInSpatialStructure',
    remedy: 'Bauteile der Ebene bzw. dem Raum zuordnen und die räumliche Struktur mitexportieren',
  },
}

/**
 * The `via` strings build.ts stamps on the edges it derives.
 *
 * Duplicated here instead of read back off the edge, because the adjacency index
 * (`graph.out` / `graph.in`) stores GlobalIds only — recovering the `GraphEdge`
 * would mean a linear scan of `graph.edges` for every ref in every answer. They
 * must stay in step with the derive block in build.ts.
 */
const VIA_HOSTED_IN = 'voids+fills'
const VIA_ADJACENT_ZONE = 'shared bounding element'
const VIA_OPENS_TO = 'hostedIn+interfaceOf'

// ── operators ───────────────────────────────────────────────────────────────

/**
 * Openings cut out of this element — the window and door reveals in a wall, the
 * stair opening in a slab.
 *
 * Note that this returns the OPENINGS, not what fills them: an opening with no
 * filler is a hole, and telling the two apart matters for a wall-area takeoff.
 * Chain `fillerOf()` on each result for the windows and doors.
 */
export function hosts(graph: BuildingGraph, globalId: string): Answer<ElementRef[]> {
  const method = `hosts(${globalId})`
  const subject = require_(graph, globalId, method)

  if (subject.kind === 'opening') {
    return wrongKind(subject, method, 'hosts', 'ein durchbrochenes Bauteil (Wand, Decke)', 'für eine Öffnung: fillerOf() liefert ihre Füllung')
  }
  if (subject.kind !== 'element') {
    return wrongKind(subject, method, 'hosts', 'ein Bauteil (Wand, Decke)', 'für Räume: bounds(), für Geschosse: elementsOfStorey()')
  }

  const blocked = unavailable<ElementRef[]>(graph, { answered: 'voids', inputs: ['voids'], from: [globalId], method })
  if (blocked) return blocked

  const ids = out(graph, 'voids', globalId)
  return declared(toRefs(graph, ids), { from: [globalId, ...ids], method })
}

/**
 * The wall or slab this window or door sits in.
 *
 * Computed, not declared: IFC never states "this window is in that wall". It
 * states that the wall is voided by an opening and that the opening is filled by
 * the window, and build.ts walks the two hops. The distinction is worth carrying
 * — the answer is only as good as the export's opening bookkeeping, and an
 * agent quoting this in front of a building authority must be able to say so.
 *
 * A list rather than one element because a filler CAN legitimately sit in more
 * than one opening (a window band split across two wall segments); one result is
 * the normal case, not a guarantee.
 */
export function hostedIn(graph: BuildingGraph, globalId: string): Answer<ElementRef[]> {
  const method = `hostedIn(${globalId})`
  const subject = require_(graph, globalId, method)

  if (subject.kind !== 'element' && subject.kind !== 'opening') {
    return wrongKind(subject, method, 'hostedIn', 'ein Fenster oder eine Tür', 'für Räume: bounds(), für Bauteile einer Ebene: elementsOfStorey()', 'computed')
  }

  const blocked = unavailable<ElementRef[]>(graph, {
    answered: 'hostedIn',
    inputs: ['voids', 'fills'],
    from: [globalId],
    method,
    provenance: 'computed',
  })
  if (blocked) return blocked

  const ids = out(graph, 'hostedIn', globalId)
  return computed(toRefs(graph, ids, VIA_HOSTED_IN), { from: [globalId, ...ids], method })
}

/**
 * What fills this opening — the window, door or louvre placed in the hole.
 *
 * An empty result on an opening that exists is a real finding: unfilled
 * openings are how a wall ends up with an area a schedule cannot account for.
 */
export function fillerOf(graph: BuildingGraph, openingGlobalId: string): Answer<ElementRef[]> {
  const method = `fillerOf(${openingGlobalId})`
  const subject = require_(graph, openingGlobalId, method)

  if (subject.kind !== 'opening') {
    return wrongKind(subject, method, 'fillerOf', 'eine Öffnung (IfcOpeningElement)', 'für ein Bauteil: hosts() liefert seine Öffnungen, hostedIn() das umgebende Bauteil')
  }

  const blocked = unavailable<ElementRef[]>(graph, { answered: 'fills', inputs: ['fills'], from: [openingGlobalId], method })
  if (blocked) return blocked

  const ids = out(graph, 'fills', openingGlobalId)
  return declared(toRefs(graph, ids), { from: [openingGlobalId, ...ids], method })
}

/**
 * The elements bounding this space — its walls, floor, ceiling, and the windows
 * and doors in them when the export writes 2nd-level boundaries.
 *
 * This is the operator that turns a room from a label into a thing with sides,
 * and it is also the one most often undecidable: space boundaries are an export
 * OPTION in every major authoring tool, and plenty of models arrive without
 * them. Saying so is the point.
 */
export function bounds(graph: BuildingGraph, spaceGlobalId: string): Answer<ElementRef[]> {
  const method = `bounds(${spaceGlobalId})`
  const subject = require_(graph, spaceGlobalId, method)

  if (subject.kind !== 'space') {
    return wrongKind(subject, method, 'bounds', 'einen Raum (IfcSpace)', 'für ein Bauteil: enclosedBy() liefert die Räume, die es begrenzt')
  }

  const blocked = unavailable<ElementRef[]>(graph, {
    answered: 'interfaceOf',
    inputs: ['interfaceOf'],
    from: [spaceGlobalId],
    method,
  })
  if (blocked) return blocked

  const ids = out(graph, 'interfaceOf', spaceGlobalId)
  return declared(toRefs(graph, ids), { from: [spaceGlobalId, ...ids], method })
}

/**
 * The spaces this element bounds — the inverse of {@link bounds}.
 *
 * Two results on a wall mean it separates those two rooms, which is the input to
 * every Trennwand question (sound insulation, fire compartmentation). One result
 * means the far side is outside the model or unbounded, which is not the same as
 * "outside the building" and must not be reported as such.
 */
export function enclosedBy(graph: BuildingGraph, elementGlobalId: string): Answer<ElementRef[]> {
  const method = `enclosedBy(${elementGlobalId})`
  const subject = require_(graph, elementGlobalId, method)

  if (subject.kind === 'space') {
    return wrongKind(subject, method, 'enclosedBy', 'ein Bauteil (Wand, Decke, Fenster)', 'für einen Raum: bounds() liefert die begrenzenden Bauteile, adjacentSpaces() die Nachbarräume')
  }

  const blocked = unavailable<ElementRef[]>(graph, {
    answered: 'interfaceOf',
    inputs: ['interfaceOf'],
    from: [elementGlobalId],
    method,
  })
  if (blocked) return blocked

  const ids = into(graph, 'interfaceOf', elementGlobalId)
  return declared(toRefs(graph, ids), { from: [elementGlobalId, ...ids], method })
}

/**
 * The spaces a window or door opens into.
 *
 * Derived from the host wall's boundaries: a window opens into every room its
 * wall encloses, plus any room that bounds the window directly (which 2nd-level
 * boundaries do state). Two results on a door is the answer to "which rooms does
 * this door connect"; one result is a door to the outside, or a door whose far
 * room the export did not bound.
 *
 * `computed` matters here more than anywhere else in this module — the chain is
 * three relations deep, and every one of them is an export setting.
 */
export function opensTo(graph: BuildingGraph, globalId: string): Answer<ElementRef[]> {
  const method = `opensTo(${globalId})`
  const subject = require_(graph, globalId, method)

  if (subject.kind !== 'element' && subject.kind !== 'opening') {
    return wrongKind(subject, method, 'opensTo', 'ein Fenster oder eine Tür', 'für einen Raum: adjacentSpaces() liefert die Nachbarräume', 'computed')
  }

  const blocked = unavailable<ElementRef[]>(graph, {
    answered: 'opensTo',
    inputs: ['voids', 'fills', 'interfaceOf'],
    from: [globalId],
    method,
    provenance: 'computed',
  })
  if (blocked) return blocked

  const ids = out(graph, 'opensTo', globalId)
  return computed(toRefs(graph, ids, VIA_OPENS_TO), { from: [globalId, ...ids], method })
}

/**
 * Elements physically joined to this one — wall-to-wall corners and T-joints,
 * beam-to-column connections.
 *
 * Traversed in both directions because the relation is symmetric in meaning and
 * build.ts stores it once, in express-id order, to keep a pair from appearing
 * twice with its ends swapped. Reading only `out` would make the answer depend
 * on which of two walls the caller happened to ask about — the kind of silent
 * asymmetry that reads as a modelling defect and is not one.
 */
export function connects(graph: BuildingGraph, globalId: string): Answer<ElementRef[]> {
  const method = `connects(${globalId})`
  require_(graph, globalId, method)

  const blocked = unavailable<ElementRef[]>(graph, { answered: 'connects', inputs: ['connects'], from: [globalId], method })
  if (blocked) return blocked

  const ids = around(graph, 'connects', globalId)
  return declared(toRefs(graph, ids), { from: [globalId, ...ids], method })
}

/**
 * The elements this container holds directly.
 *
 * Whenever the export assigns elements to spaces rather than only to storeys,
 * this is the answer to "welche Bauteile sind in Raum X" — call it on the
 * IfcSpace. Many exports assign everything to the storey instead, in which case
 * a space returns an empty list and the room's contents have to come from
 * {@link bounds} plus geometry; the empty list is honest either way, and
 * `contains()` on the storey shows which convention this file follows.
 *
 * Directly: an element inside an assembly inside this storey arrives through
 * `hasSubElement` and is not repeated here. {@link elementsOfStorey} is the
 * operator that flattens that.
 */
export function contains(graph: BuildingGraph, containerGlobalId: string): Answer<ElementRef[]> {
  const method = `contains(${containerGlobalId})`
  const subject = require_(graph, containerGlobalId, method)

  if (!CONTAINER_KINDS.has(subject.kind)) {
    return wrongKind(subject, method, 'contains', 'einen räumlichen Container (Geschoss, Raum, Gebäude)', 'für ein Bauteil: containerOf() liefert seinen Container, hosts() seine Öffnungen')
  }

  const blocked = unavailable<ElementRef[]>(graph, {
    answered: 'containsElement',
    inputs: ['containsElement'],
    from: [containerGlobalId],
    method,
  })
  if (blocked) return blocked

  const ids = out(graph, 'containsElement', containerGlobalId)
  return declared(toRefs(graph, ids), { from: [containerGlobalId, ...ids], method })
}

/**
 * The immediate spatial container of this element — the storey, or the space
 * when the export assigns elements that finely.
 *
 * `null` is a decidable answer: a storey's parent building travels on
 * `hasSubElement`, not on containment, and an element the exporter left
 * unassigned really has no container. Both are things worth reporting; neither
 * is a missing relation.
 */
export function containerOf(graph: BuildingGraph, globalId: string): Answer<ElementRef | null> {
  const method = `containerOf(${globalId})`
  require_(graph, globalId, method)

  const blocked = unavailable<ElementRef | null>(graph, {
    answered: 'containsElement',
    inputs: ['containsElement'],
    from: [globalId],
    method,
  })
  if (blocked) return blocked

  const ids = into(graph, 'containsElement', globalId)
  const first = ids[0]
  if (!first) return declared(null, { from: [globalId], method })

  return declared(toRef(graph, first), {
    from: [globalId, first],
    method,
    // IFC allows an element to be contained in exactly one spatial structure.
    // More than one is an export defect, and reporting the first silently would
    // hide it behind an answer that looks ordinary.
    ...(ids.length > 1
      ? {
          caveat:
            `Dieses Bauteil ist ${ids.length} räumlichen Containern zugeordnet, IFC erlaubt genau einen. ` +
            `Gemeldet ist der erste — ein Befund über den Export.`,
        }
      : {}),
  })
}

/**
 * The rooms next door — spaces sharing a bounding element with this one.
 *
 * Purely topological: two spaces bounded by the same wall are neighbours, no
 * geometry and no tolerance involved. What it does NOT say is whether they are
 * connected — a shared wall with no door in it still makes neighbours. Use
 * {@link opensTo} on the doors for connectivity.
 *
 * Both directions, because build.ts writes the pair once (i < j over the spaces
 * on a shared boundary) and reading one direction would make the answer depend
 * on which of two neighbours was asked about.
 */
export function adjacentSpaces(graph: BuildingGraph, spaceGlobalId: string): Answer<ElementRef[]> {
  const method = `adjacentSpaces(${spaceGlobalId})`
  const subject = require_(graph, spaceGlobalId, method)

  if (subject.kind !== 'space') {
    return wrongKind(subject, method, 'adjacentSpaces', 'einen Raum (IfcSpace)', 'für ein Bauteil: enclosedBy() liefert die Räume, die es begrenzt', 'computed')
  }

  const blocked = unavailable<ElementRef[]>(graph, {
    answered: 'adjacentZone',
    inputs: ['interfaceOf'],
    from: [spaceGlobalId],
    method,
    provenance: 'computed',
  })
  if (blocked) return blocked

  const ids = around(graph, 'adjacentZone', spaceGlobalId)
  return computed(toRefs(graph, ids, VIA_ADJACENT_ZONE), { from: [spaceGlobalId, ...ids], method })
}

/**
 * Everything on this storey.
 *
 * Resolved through `GraphNode.storeyGlobalId` rather than the containment edge,
 * and the difference is not academic: a door assigned to a space, or a beam
 * inside an assembly, is contained by the space or the assembly and would be
 * missing from a walk of `containsElement` out of the storey. It is still on the
 * storey, and every per-floor count — "wie viele Fenster im Erdgeschoss" — is
 * wrong if it is left out. The parser resolves that chain once when the graph is
 * built; this reads it back.
 *
 * The storey itself is excluded, and so are the spaces' own child elements'
 * duplicates — each node appears at most once because each node resolves to at
 * most one storey.
 */
export function elementsOfStorey(graph: BuildingGraph, storeyGlobalId: string): Answer<ElementRef[]> {
  const method = `elementsOfStorey(${storeyGlobalId})`
  const subject = require_(graph, storeyGlobalId, method)

  if (subject.kind !== 'storey') {
    return wrongKind(subject, method, 'elementsOfStorey', 'ein Geschoss (IfcBuildingStorey)', 'für einen Raum oder ein Gebäude: contains()')
  }

  // The storey resolution is model-wide or absent — if the export wrote no
  // spatial containment at all, no node carries a storey, and "dieses Geschoss
  // ist leer" would be a wrong answer about a building that has floors.
  let anyResolved = false
  const ids: string[] = []
  for (const n of graph.nodes.values()) {
    if (n.storeyGlobalId === null) continue
    anyResolved = true
    if (n.storeyGlobalId === storeyGlobalId && n.globalId !== storeyGlobalId) ids.push(n.globalId)
  }
  if (!anyResolved) {
    const relation = RELATIONS.containsElement!
    return undecidable<ElementRef[]>({
      from: [storeyGlobalId],
      method,
      missing: { what: relation.ifc, remedy: relation.remedy },
    })
  }

  return declared(toRefs(graph, ids), { from: [storeyGlobalId, ...ids], method })
}

// ── guards ──────────────────────────────────────────────────────────────────

/** Spatial containers, the only sensible subjects for {@link contains}. */
const CONTAINER_KINDS = new Set<NodeKind>(['project', 'site', 'building', 'storey', 'space'])

/**
 * The subject node, or a throw.
 *
 * Named with a trailing underscore because `require` is taken in enough
 * toolchains to be worth not fighting over.
 */
function require_(graph: BuildingGraph, globalId: string, method: string): GraphNode {
  const n = node(graph, globalId)
  if (!n) throw new UnknownElementError(globalId, method)
  return n
}

/**
 * The operator was aimed at the wrong kind of element.
 *
 * `missing.what` is German here, unlike everywhere else in this module where it
 * carries an IFC identifier — because nothing is in fact missing from the file.
 * What is missing is a match between the question and the subject, and naming an
 * IFC relation would send the architect off to re-export something that is
 * already there. `remedy` names the operator that WOULD answer it, which is the
 * only action that helps.
 */
function wrongKind<T>(
  subject: GraphNode,
  method: string,
  operator: string,
  expected: string,
  suggestion: string,
  provenance?: Provenance
): Answer<T> {
  return undecidable<T>({
    from: [subject.globalId],
    method,
    ...(provenance ? { provenance } : {}),
    missing: {
      what: `${operator}() erwartet ${expected}, bekam ${subject.ifcType}`,
      remedy: suggestion,
      elements: [subject.globalId],
    },
  })
}

/**
 * An undecidable when the relation is missing from the WHOLE model, and `null`
 * when it merely misses this element.
 *
 * The test is on the model-wide edge count, not on this element's edges, and
 * that asymmetry is the entire semantic contribution of this module. A wall with
 * no openings in a file full of openings is a wall with no openings. The same
 * wall in a file that exported no openings at all tells us nothing about the
 * wall — and the two are indistinguishable from the element alone.
 *
 * For derived edge kinds (`hostedIn`, `opensTo`, `adjacentZone`) the missing
 * fact names the DECLARED relations the derivation eats, since re-exporting
 * those is the action available to the architect; the derived edge is ours, and
 * they cannot export it.
 */
function unavailable<T>(
  graph: BuildingGraph,
  opts: { answered: EdgeKind; inputs: EdgeKind[]; from: string[]; method: string; provenance?: Provenance }
): Answer<T> | null {
  if (count(graph, opts.answered) > 0) return null

  // Name only the inputs that are actually absent; when all of them are present
  // yet the derivation produced nothing, they never met on the same opening or
  // boundary, and naming the whole chain is the honest description of that.
  const absent = opts.inputs.filter((kind) => count(graph, kind) === 0)
  const named = absent.length > 0 ? absent : opts.inputs

  const relations = named.map((kind) => RELATIONS[kind]).filter((r): r is { ifc: string; remedy: string } => Boolean(r))
  if (relations.length === 0) return null

  return undecidable<T>({
    from: opts.from,
    method: opts.method,
    ...(opts.provenance ? { provenance: opts.provenance } : {}),
    missing: {
      what: [...new Set(relations.map((r) => r.ifc))].join(' + '),
      remedy: [...new Set(relations.map((r) => r.remedy))].join('; '),
    },
  })
}

function count(graph: BuildingGraph, kind: EdgeKind): number {
  return graph.stats.edgesByKind[kind] ?? 0
}
