/**
 * `buildGraph` over `fixtures/haus-mit-raeumen.ifc`.
 *
 * The fixture is hand-written so every assertion here can be checked by reading
 * 90 lines of STEP rather than trusting an exporter. Two rooms, four walls, one
 * of them between the rooms; a window in an exterior wall and a door in the
 * party wall, each through an IfcOpeningElement; space boundaries, a zone, a
 * wall-to-wall connection, and two fittings that live in a SPACE rather than on
 * a storey.
 *
 * Three of the suites below — `adjacentZone`, `hasSubElement direction` and
 * `longName` — are regression suites for defects this fixture found and
 * `build.ts` has since fixed. Each carries a docblock naming the invariant it
 * guards and the wrong answer that appeared when the invariant did not hold,
 * because in all three cases the wrong answer was a plausible one: a room
 * adjacent to itself, a storey reported as part of a room, a room called
 * „R.01". None of them looked like a crash, and none would have been noticed
 * without an assertion aimed at it.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildGraph } from '../src/graph/build.js'
import { out, into, around, label } from '../src/graph/types.js'
import type { BuildingGraph, GraphEdge, NodeKind } from '../src/graph/types.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/haus-mit-raeumen.ifc', import.meta.url))

/** GlobalIds, verbatim from the fixture. */
const ID = {
  project: '2Haus0Raeume00Project0',
  site: '2Haus0Raeume00Site0001',
  building: '2Haus0Raeume00Building',
  storeyEG: '2Haus0Raeume00StoreyEG',
  storeyOG: '2Haus0Raeume00StoreyOG',
  wandSued: '2Haus0Raeume00Wall0001',
  wandNord: '2Haus0Raeume00Wall0002',
  trennwand: '2Haus0Raeume00Wall0003',
  wandWest: '2Haus0Raeume00Wall0004',
  bodenplatte: '2Haus0Raeume00Slab0001',
  fenster: '2Haus0Raeume00Window01',
  tuer: '2Haus0Raeume00Door0001',
  wohnzimmer: '2Haus0Raeume00Space001',
  kueche: '2Haus0Raeume00Space002',
  kuechenzeile: '2Haus0Raeume00Furnit01',
  spuele: '2Haus0Raeume00Sanit001',
  fensteroeffnung: '2Haus0Raeume00Openin01',
  tueroeffnung: '2Haus0Raeume00Openin02',
  zone: '2Haus0Raeume00Zone0001',
  wallType: '2Haus0Raeume00WallTyp1',
  pset: '2Haus0Raeume00Pset0001',
} as const

function bytes(): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURE))
}

let graph: BuildingGraph

beforeAll(async () => {
  graph = await buildGraph(bytes())
})

const edgesOf = (kind: GraphEdge['kind']): GraphEdge[] => graph.edges.filter((e) => e.kind === kind)
const kindOf = (globalId: string): NodeKind | undefined => graph.nodes.get(globalId)?.kind
const pair = (e: GraphEdge) => new Set([e.from, e.to])

describe('the file itself', () => {
  it('is read as IFC4 and keeps its header', () => {
    expect(graph.schema).toBe('IFC4')
    expect(graph.sourceName).toBe('haus-mit-raeumen.ifc')
    expect(graph.originatingSystem).toBe('GRID')
    expect(graph.stats.entities).toBe(71)
    expect(graph.stats.fileSizeBytes).toBe(bytes().byteLength)
  })
})

describe('nodes', () => {
  it('has one node per product root and nothing else', () => {
    // 1 project + 1 site + 1 building + 2 storeys + 2 spaces + 2 openings
    // + 1 zone + 9 elements (4 walls, slab, window, door, furniture, sink).
    expect(graph.nodes.size).toBe(19)

    const tally: Record<string, number> = {}
    for (const n of graph.nodes.values()) tally[n.kind] = (tally[n.kind] ?? 0) + 1
    expect(tally).toEqual({
      project: 1,
      site: 1,
      building: 1,
      storey: 2,
      space: 2,
      element: 9,
      opening: 2,
      group: 1,
    })
  })

  it('calls an IfcSpace a space, an IfcOpeningElement an opening, an IfcZone a group', () => {
    expect(kindOf(ID.wohnzimmer)).toBe('space')
    expect(kindOf(ID.kueche)).toBe('space')
    expect(kindOf(ID.fensteroeffnung)).toBe('opening')
    expect(kindOf(ID.tueroeffnung)).toBe('opening')
    expect(kindOf(ID.zone)).toBe('group')
    expect(kindOf(ID.fenster)).toBe('element')
    expect(kindOf(ID.wandSued)).toBe('element')
  })

  it('does not make nodes out of type definitions, relations or property sets', () => {
    // IfcWallType carries a GlobalId and would otherwise double every wall.
    expect(graph.nodes.has(ID.wallType)).toBe(false)
    expect(graph.byType.has('IfcWallType')).toBe(false)
    expect(graph.nodes.has(ID.pset)).toBe(false)

    const types = [...new Set([...graph.nodes.values()].map((n) => n.ifcType))].sort()
    expect(types.filter((t) => t.startsWith('IfcRel'))).toEqual([])
    expect(types.filter((t) => /(Type|Style)$/.test(t))).toEqual([])
    expect(types).toEqual([
      'IfcBuilding',
      'IfcBuildingStorey',
      'IfcDoor',
      'IfcFurniture',
      'IfcOpeningElement',
      'IfcProject',
      'IfcSanitaryTerminal',
      'IfcSite',
      'IfcSlab',
      'IfcSpace',
      'IfcWall',
      'IfcWindow',
      'IfcZone',
    ])
  })

  it('reads PredefinedType by attribute NAME, not by position', () => {
    expect(graph.nodes.get(ID.wandSued)?.predefinedType).toBe('SOLIDWALL')
    expect(graph.nodes.get(ID.bodenplatte)?.predefinedType).toBe('BASESLAB')
    expect(graph.nodes.get(ID.fensteroeffnung)?.predefinedType).toBe('OPENING')
    // The two that a positional read gets wrong, and why this is name-based:
    // IfcDoor's PredefinedType is followed by OperationType and
    // UserDefinedOperationType, so reading the tail attribute returned null;
    // IfcSpace's is followed by ElevationWithFlooring and PRECEDED by the
    // CompositionType enum, so a scan backwards for "something enum-shaped"
    // returned ELEMENT for every room in the building.
    expect(graph.nodes.get(ID.tuer)?.predefinedType).toBe('DOOR')
    expect(graph.nodes.get(ID.wohnzimmer)?.predefinedType).toBe('INTERNAL')
  })

  it('indexes by canonical type name', () => {
    expect(graph.byType.get('IfcWall')).toHaveLength(4)
    expect(graph.byType.get('IfcSpace')).toEqual([ID.wohnzimmer, ID.kueche])
    expect(graph.byType.get('IfcOpeningElement')).toHaveLength(2)
    expect(graph.byType.get('IfcZone')).toEqual([ID.zone])
  })
})

describe('storeys', () => {
  it('are sorted lowest-first with their elevations resolved', () => {
    expect(graph.storeys.map((s) => s.name)).toEqual(['Erdgeschoss', 'Obergeschoss'])
    // The parser normalises the file's millimetres to metres, so 3000. reads 3.
    expect(graph.storeys.map((s) => s.elevation)).toEqual([0, 3])
    expect(graph.storeys[0]!.globalId).toBe(ID.storeyEG)
  })

  it('resolves the storey of an element contained in a storey', () => {
    expect(graph.nodes.get(ID.wandSued)?.storeyGlobalId).toBe(ID.storeyEG)
    expect(graph.nodes.get(ID.wandSued)?.storeyName).toBe('Erdgeschoss')
    expect(graph.nodes.get(ID.wohnzimmer)?.storeyGlobalId).toBe(ID.storeyEG)
  })

  it('walks the spatial chain project → site → building → storey → space', () => {
    expect(out(graph, 'hasSubElement', ID.project)).toEqual([ID.site])
    expect(out(graph, 'hasSubElement', ID.site)).toEqual([ID.building])
    expect(out(graph, 'hasSubElement', ID.building)).toEqual([ID.storeyEG, ID.storeyOG])
    expect(out(graph, 'hasSubElement', ID.storeyEG)).toEqual([ID.wohnzimmer, ID.kueche])
  })
})

describe('containsElement', () => {
  it('reaches elements contained in a SPACE, not only in a storey', () => {
    expect(out(graph, 'containsElement', ID.kueche).sort()).toEqual([ID.kuechenzeile, ID.spuele].sort())
    expect(into(graph, 'containsElement', ID.kuechenzeile)).toEqual([ID.kueche])
  })

  it('still carries the storey containment', () => {
    expect(out(graph, 'containsElement', ID.storeyEG).sort()).toEqual(
      [ID.wandSued, ID.wandNord, ID.trennwand, ID.wandWest, ID.bodenplatte, ID.fenster, ID.tuer].sort()
    )
    // The two fittings belong to the Kueche, not directly to the storey.
    expect(out(graph, 'containsElement', ID.storeyEG)).not.toContain(ID.kuechenzeile)
  })

  it('is oriented container → element', () => {
    for (const e of edgesOf('containsElement')) {
      expect(['storey', 'space', 'building', 'site', 'project']).toContain(kindOf(e.from))
      expect(e.provenance).toBe('declared')
    }
  })
})

describe('hostedIn — the window↔wall chain', () => {
  it('resolves the window to the wall it is cut into', () => {
    expect(out(graph, 'hostedIn', ID.fenster)).toEqual([ID.wandSued])
  })

  it('marks it computed, via voids+fills', () => {
    const edge = edgesOf('hostedIn').find((e) => e.from === ID.fenster)
    expect(edge).toBeDefined()
    expect(edge!.to).toBe(ID.wandSued)
    expect(edge!.provenance).toBe('computed')
    expect(edge!.via).toBe('voids+fills')
  })

  it('resolves the door to the party wall too, and nothing else is hosted', () => {
    expect(out(graph, 'hostedIn', ID.tuer)).toEqual([ID.trennwand])
    expect(edgesOf('hostedIn')).toHaveLength(2)
  })

  it('is oriented filler → host, never host → filler', () => {
    expect(out(graph, 'hostedIn', ID.wandSued)).toEqual([])
    expect(into(graph, 'hostedIn', ID.wandSued)).toEqual([ID.fenster])
  })

  it('rests on declared voids and fills, each read once', () => {
    expect(out(graph, 'voids', ID.wandSued)).toEqual([ID.fensteroeffnung])
    expect(out(graph, 'fills', ID.fensteroeffnung)).toEqual([ID.fenster])
    expect(edgesOf('voids')).toHaveLength(2)
    expect(edgesOf('fills')).toHaveLength(2)
    // voids goes element → opening; fills goes opening → filler. Not the reverse.
    for (const e of edgesOf('voids')) expect(kindOf(e.to)).toBe('opening')
    for (const e of edgesOf('fills')) expect(kindOf(e.from)).toBe('opening')
  })
})

describe('interfaceOf', () => {
  it('is oriented space → bounding element, never the reverse', () => {
    const boundaries = edgesOf('interfaceOf')
    expect(boundaries.length).toBeGreaterThan(0)
    for (const e of boundaries) {
      expect(kindOf(e.from)).toBe('space')
      expect(kindOf(e.to)).not.toBe('space')
      expect(e.provenance).toBe('declared')
    }
  })

  it('lists the bounding elements of each room, deduplicated', () => {
    expect(out(graph, 'interfaceOf', ID.wohnzimmer).sort()).toEqual(
      [ID.wandSued, ID.wandNord, ID.trennwand, ID.fenster].sort()
    )
    expect(out(graph, 'interfaceOf', ID.kueche).sort()).toEqual([ID.trennwand, ID.wandWest].sort())
    // Each IfcRelSpaceBoundary is visited from both endpoints; six relations
    // must still yield six edges.
    expect(edgesOf('interfaceOf')).toHaveLength(6)
  })

  it('links the window to its space', () => {
    expect(into(graph, 'interfaceOf', ID.fenster)).toEqual([ID.wohnzimmer])
  })
})

describe('adjacentZone', () => {
  it('links Wohnzimmer and Kueche through the party wall', () => {
    // Necessary condition only — the exact contract is the suite below.
    expect(around(graph, 'adjacentZone', ID.wohnzimmer)).toContain(ID.kueche)
    expect(into(graph, 'interfaceOf', ID.trennwand).sort()).toEqual([ID.wohnzimmer, ID.kueche].sort())
  })

  /**
   * Invariant: one `adjacentZone` edge per adjacent pair, and no room adjacent
   * to itself.
   *
   * Guarded because the derivations are indexed off the edge ARRAY, and that
   * array holds every declared relation twice by design — `related()` reads
   * both `forward` and `inverse`, so each IfcRelSpaceBoundary is pushed once
   * while visiting the space and once while visiting the wall. `dedupe` cleans
   * that up, and for as long as `buildIndex` ran before it the derivations saw
   * the duplicates:
   *
   *     in['interfaceOf'][Aussenwand Sued]  = [Wohnzimmer, Wohnzimmer]
   *     in['interfaceOf'][Trennwand]        = [Wohnzimmer, Kueche, Wohnzimmer, Kueche]
   *
   * A wall bounding ONE room then cleared the `spaces.length < 2` guard, and
   * this fixture produced four edges instead of one — Wohnzimmer→Wohnzimmer,
   * Kueche→Kueche, and the real pair stored twice with its ends swapped. Two
   * rooms adjacent to themselves, from a perfectly correct file.
   *
   * `build.ts` now dedupes before indexing, and says so at that line. What
   * makes this worth a standing test rather than a comment is that the failure
   * is invisible from the edge list: `dedupe` still ran, so the FINAL graph was
   * duplicate-free and only the derived edges were wrong.
   */
  it('stores the pair exactly once and never a room next to itself', () => {
    const adjacent = edgesOf('adjacentZone')
    expect(adjacent).toHaveLength(1)
    expect(pair(adjacent[0]!)).toEqual(new Set([ID.wohnzimmer, ID.kueche]))
    for (const e of adjacent) expect(e.from).not.toBe(e.to)
    expect(adjacent[0]!.provenance).toBe('computed')
    // Names the TYPE of the separator, because only a vertical one may create
    // an adjacency at all — a shared floor slab must not.
    expect(adjacent[0]!.via).toBe('shared bounding IfcWall')
  })
})

describe('opensTo', () => {
  it('gets the door to BOTH spaces', () => {
    expect(out(graph, 'opensTo', ID.tuer).sort()).toEqual([ID.wohnzimmer, ID.kueche].sort())
  })

  it('gets the window to the one room its wall bounds', () => {
    expect(out(graph, 'opensTo', ID.fenster)).toEqual([ID.wohnzimmer])
  })

  it('gets the openings themselves too, not only their fillers', () => {
    expect(out(graph, 'opensTo', ID.fensteroeffnung)).toEqual([ID.wohnzimmer])
    expect(out(graph, 'opensTo', ID.tueroeffnung).sort()).toEqual([ID.wohnzimmer, ID.kueche].sort())
  })

  it('never makes a bounding wall "open into" the rooms it encloses', () => {
    // The party wall bounds both rooms and hosts the door. The DOOR opens into
    // them; the wall is what separates them.
    expect(out(graph, 'opensTo', ID.trennwand)).toEqual([])
    for (const e of edgesOf('opensTo')) {
      expect(['element', 'opening']).toContain(kindOf(e.from))
      expect(graph.nodes.get(e.from)?.ifcType).not.toBe('IfcWall')
    }
  })

  it('is computed, oriented → space, and says which route it took', () => {
    const opens = edgesOf('opensTo')
    // window + door (fillers) and their two openings: 1 + 2 + 1 + 2.
    expect(opens).toHaveLength(6)
    for (const e of opens) {
      expect(kindOf(e.to)).toBe('space')
      expect(e.provenance).toBe('computed')
      // The route names itself, and which one ran is decided by whether the
      // subject carries a boundary of its OWN: that one is precise (the file
      // says which room this opening serves) and beats the host wall's, which
      // is every room along the wall.
      const own = into(graph, 'interfaceOf', e.from)
      expect(e.via).toBe(
        own.length > 0
          ? 'interfaceOf (eigene Raumbegrenzung)'
          : kindOf(e.from) === 'opening'
            ? 'voids+interfaceOf (Gastbauteil)'
            : 'hostedIn+interfaceOf (Gastbauteil)'
      )
    }
  })
})

describe('connects', () => {
  it('is stored once per pair, in express-id order', () => {
    const connects = edgesOf('connects')
    expect(connects).toHaveLength(1)
    expect(connects[0]!.from).toBe(ID.wandSued)
    expect(connects[0]!.to).toBe(ID.wandNord)
    expect(connects[0]!.provenance).toBe('declared')
    // Both walls can find each other, but only one edge exists.
    expect(around(graph, 'connects', ID.wandNord)).toEqual([ID.wandSued])
  })
})

describe('inGroup', () => {
  it('points member → zone for both rooms', () => {
    expect(out(graph, 'inGroup', ID.wohnzimmer)).toEqual([ID.zone])
    expect(out(graph, 'inGroup', ID.kueche)).toEqual([ID.zone])
    expect(into(graph, 'inGroup', ID.zone).sort()).toEqual([ID.wohnzimmer, ID.kueche].sort())
    expect(edgesOf('inGroup')).toHaveLength(2)
  })
})

describe('dialect', () => {
  it('finds Pset_WallCommon.IsExternal with a plausible fill count', () => {
    const entry = graph.dialect.find((d) => d.set === 'Pset_WallCommon' && d.property === 'IsExternal')
    expect(entry).toBeDefined()
    // All four walls carry it; three external, one internal.
    expect(entry!.filled).toBe(4)
    // Candidates are the element and space nodes: 9 elements + 2 spaces.
    expect(entry!.candidates).toBe(11)
    expect(entry!.filled).toBeLessThanOrEqual(entry!.candidates)
    expect(new Set(entry!.sample)).toEqual(new Set([true, false]))
  })

  it('finds the U-value the walls publish', () => {
    const entry = graph.dialect.find((d) => d.set === 'Pset_WallCommon' && d.property === 'ThermalTransmittance')
    expect(entry).toBeDefined()
    expect(entry!.filled).toBe(4)
    expect(entry!.sample).toContain(0.19)
  })

  it('finds Pset_SpaceCommon on the rooms', () => {
    const sets = new Set(graph.dialect.map((d) => d.set))
    expect(sets).toContain('Pset_SpaceCommon')
    expect(sets).toContain('Pset_WindowCommon')
    const category = graph.dialect.find((d) => d.set === 'Pset_SpaceCommon' && d.property === 'Category')
    expect(category?.filled).toBe(2)
    expect(category?.sample).toEqual(['Aufenthaltsraum'])
  })

  it('is sorted by fill count, descending', () => {
    const filled = graph.dialect.map((d) => d.filled)
    expect([...filled].sort((a, b) => b - a)).toEqual(filled)
  })
})

describe('blindSpots', () => {
  const what = () => graph.blindSpots.map((b) => b.what)

  it('does not claim missing space boundaries, fills or spaces — this file has all three', () => {
    expect(what()).not.toContain('keine IfcRelSpaceBoundary')
    expect(what()).not.toContain('keine IfcRelFillsElement')
    expect(what()).not.toContain('keine IfcSpace-Elemente')
  })

  /**
   * `buildGraph` is the topological half and really has run no geometry, so it
   * must say so — but it must say THAT, and not the old sentence "keine
   * Geometrie in dieser Ausbaustufe", which was appended unconditionally and
   * therefore survived into every `openModel` result as well. See
   * `corpus.spec.ts` for the other half of this: after the pass has run, the
   * spot must be gone.
   */
  it('reports that no geometry pass has run — and does not claim the stage has none', () => {
    expect(what()).toContain('kein Geometrie-Pass gelaufen (nur Topologie)')
    expect(what()).not.toContain('keine Geometrie in dieser Ausbaustufe')
    const spot = graph.blindSpots.find((b) => b.what === 'kein Geometrie-Pass gelaufen (nur Topologie)')!
    expect(spot.consequence).toMatch(/nicht berechenbar/)
    expect(spot.remedy).toMatch(/openModel/)
  })

  it('reports the north and georeferencing gaps this file really has', () => {
    expect(what()).toContain('keine Nordrichtung')
    expect(what()).toContain('keine Georeferenzierung')
  })

  it('does not claim a sample it did not take', () => {
    // 11 candidates, default sample size 4000 — nothing was sampled.
    expect(what().some((w) => w.startsWith('Dialekt aus einer Stichprobe'))).toBe(false)
  })

  it('says it sampled when it did', async () => {
    const small = await buildGraph(bytes(), { dialectSampleSize: 2 })
    expect(small.blindSpots.map((b) => b.what)).toContain('Dialekt aus einer Stichprobe von 2 Bauteilen')
    expect(small.dialect.every((d) => d.candidates === 2)).toBe(true)
  })
})

describe('contentHash', () => {
  it('is stable across two builds of the same bytes', async () => {
    const a = await buildGraph(bytes())
    const b = await buildGraph(bytes())
    expect(a.contentHash).toBe(b.contentHash)
    expect(a.contentHash).toBe(graph.contentHash)
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs for different bytes', async () => {
    const source = readFileSync(FIXTURE, 'utf8')
    // Same length, one letter different — a rename, not a structural change.
    const edited = source.replace("'Fenster Sued'", "'Fenster Nord'")
    expect(edited).not.toBe(source)
    const other = await buildGraph(new Uint8Array(Buffer.from(edited, 'utf8')))
    expect(other.contentHash).not.toBe(graph.contentHash)
    // …and the graph is otherwise the same shape.
    expect(other.nodes.size).toBe(graph.nodes.size)
    expect(other.nodes.get(ID.fenster)?.name).toBe('Fenster Nord')
  })
})

describe('progress and stats', () => {
  it('reports every phase once, in order', async () => {
    const phases: string[] = []
    await buildGraph(bytes(), { onProgress: (p) => phases.push(p) })
    expect(phases).toEqual(['parse', 'nodes', 'spatial', 'relations', 'derive', 'dialect'])
  })

  it('counts what it built', () => {
    expect(graph.stats.nodes).toBe(graph.nodes.size)
    expect(graph.stats.edges).toBe(graph.edges.length)
    const sum = Object.values(graph.stats.edgesByKind).reduce((a, b) => a + b, 0)
    expect(sum).toBe(graph.edges.length)
  })

  it('leaves no dangling edge endpoints', () => {
    for (const e of graph.edges) {
      expect(graph.nodes.has(e.from), `dangling from ${e.kind} ${e.from}`).toBe(true)
      expect(graph.nodes.has(e.to), `dangling to ${e.kind} ${e.to}`).toBe(true)
    }
  })

  it('stores no edge twice', () => {
    const keys = graph.edges.map((e) => `${e.kind} ${e.from} ${e.to}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

/**
 * Invariant: `hasSubElement` points whole → part, always, and never back.
 *
 * Guarded because IfcRelAggregates is the one relation whose endpoints do not
 * say which side is the whole. Everywhere else the node kinds settle it — a
 * storey contains an element, never the reverse — but an aggregation can hold a
 * container on either side, so orientation has to come from the relation's own
 * direction rather than from the things it joins.
 *
 * While this block read `related()`, which merges `forward` and `inverse`, a
 * space saw its storey on the inverse side and emitted
 *
 *     hasSubElement  Wohnzimmer (IfcSpace) → Erdgeschoss (IfcBuildingStorey)
 *
 * alongside the correct storey → space edge from `walkSpatial`. Both directions
 * of the same kind, so `out(graph, 'hasSubElement', space)` answered that the
 * storey is part of the room, and every element assembly would have doubled the
 * same way.
 *
 * `build.ts` now trusts `forward` in this one block, which the parser orients
 * RelatingObject → RelatedObjects. The second assertion pins the count as well
 * as the direction: a reversed edge survives a direction check alone if the
 * forward one is missing, and six is what this file declares.
 */
describe('hasSubElement direction', () => {
  it('never points from a part back to its whole', () => {
    for (const e of graph.edges.filter((x) => x.kind === 'hasSubElement')) {
      const where = `${label(graph.nodes.get(e.from) ?? null)} → ${label(graph.nodes.get(e.to) ?? null)}`
      expect(kindOf(e.from), where).not.toBe('space')
    }
  })

  it('has exactly the six spatial edges the file declares', () => {
    expect(graph.edges.filter((e) => e.kind === 'hasSubElement')).toHaveLength(6)
    expect(out(graph, 'hasSubElement', ID.wohnzimmer)).toEqual([])
  })
})

/**
 * Invariant: `LongName` is read, and `label()` prefers it over a coded `Name`.
 *
 * The fixture puts the ISO 19650 code in `Name` ('R.01') and the human label in
 * `LongName` ('Wohnzimmer'), because that is what real spatial elements do and
 * it is the case `GraphNode.longName` exists for. While node construction
 * hard-coded `longName: null`, `label()` of the living room printed
 * "R.01 (IfcSpace)" — sourced from the file, correct in every mechanical sense,
 * and useless to the architect reading the answer.
 *
 * That is the failure mode worth a standing test: nothing errors, nothing is
 * empty, and the sentence the agent writes is simply about a room the reader
 * cannot identify. The zone assertion is here because `longName` is read
 * per-type through the schema registry, so a group and a space are separate
 * paths and one can regress without the other.
 */
describe('longName', () => {
  it('resolves the human label of a room whose Name is a code', () => {
    expect(graph.nodes.get(ID.wohnzimmer)?.name).toBe('R.01')
    expect(graph.nodes.get(ID.wohnzimmer)?.longName).toBe('Wohnzimmer')
    expect(graph.nodes.get(ID.kueche)?.longName).toBe('Kueche')
    expect(label(graph.nodes.get(ID.wohnzimmer)!)).toBe('Wohnzimmer (IfcSpace)')
  })

  it('resolves the zone label too', () => {
    expect(graph.nodes.get(ID.zone)?.longName).toBe('Wohnbereich')
  })
})
