/**
 * Model-level operators: what the agent is told before it asks anything.
 *
 * ## Why a briefing exists at all
 *
 * The expensive failures in model question-answering are not arithmetic
 * failures. They are GROUNDING failures: the agent filters on `Pset_WallCommon`
 * in a file whose exporter wrote `AllplanAttributes`, asks for storey
 * `"Erdgeschoss"` in a file that calls it `"EG 00"`, and gets back zero rows.
 * Zero rows renders as "no external walls on the ground floor" — a confident,
 * fluent, wrong sentence that nothing downstream can catch, because a filter
 * that matched nothing and a building that contains nothing produce the same
 * empty list.
 *
 * So the cure is not a warning ("check the property names first"); it is to
 * hand the agent the file's own vocabulary before it writes a query.
 * {@link renderBriefing} is that hand-over — a deterministic, rendered fact
 * sheet, not prose from a model, computed once per file and injected when a
 * conversation first touches it.
 *
 * ## The rule every line in here obeys
 *
 * **An absent fact must never render as a zero.** `0 Fenster mit Wandzuordnung`
 * is a sentence about a building. What the graph actually knows, when
 * `IfcRelFillsElement` was never exported, is a sentence about a FILE. The two
 * are told apart everywhere below: a population of zero says "the export
 * contains none", a resolution of zero out of many names the relation that is
 * missing, and neither is allowed to look like a measurement.
 *
 * This is the same discipline the query layer applies to truncation — a subset
 * reported as a total is the bug that survives review, because it reads
 * perfectly.
 *
 * ## What phase 0 may and may not say
 *
 * There is no geometry here. Every number below comes from declared attributes
 * or from walking declared relations. Lines the §8.1 layout reserves for
 * geometry — envelope areas, roof overhangs, computed room areas, real opening
 * areas — are therefore ABSENT rather than estimated: a briefing that guesses
 * is worse than no briefing, because it is trusted.
 */

import { computed, inferred, undecidable, type Answer } from '../envelope.js'
import { into, out, type BlindSpot, type BuildingGraph, type GraphNode, type NodeKind } from '../graph/types.js'

// ── The briefing, as data ───────────────────────────────────────────────────

export interface BriefingStorey {
  globalId: string
  name: string | null
  /** Metres. `null` when the file declares no elevation for this storey. */
  elevation: number | null
  /**
   * Structural storey-to-storey height in metres — the NEXT storey's elevation
   * minus this one. `null` for the topmost storey and wherever an elevation is
   * missing, never a fallback value: a guessed room height is the input to a
   * clear-height check, and a wrong one passes silently.
   */
  height: number | null
  /** Nodes that resolve to this storey by containment. */
  elementCount: number
  spaceCount: number
}

/** A count, for `byKind` / `byType` tables. */
export interface BriefingCount {
  key: string
  count: number
}

/**
 * How far a relation actually reaches, as `n of m`.
 *
 * Both numbers travel together because either alone lies. `n` alone hides that
 * the model has 300 windows and resolved 4 of them; `m` alone hides that the
 * export wrote the relation at all. `relation` names the IFC construct that
 * would supply the missing part, so a shortfall can be blamed on the export in
 * the export's own vocabulary rather than reported as a property of the
 * building.
 */
export interface Coverage {
  id:
    | 'oeffnungenMitWand'
    | 'raeumeMitBegrenzung'
    | 'raeumeMitNamen'
    | 'geschosseMitHoehenlage'
    | 'bauteileMitGeschoss'
  /** German label for the population, printable as-is. */
  what: string
  /** Members for which the fact resolves. */
  n: number
  /** Members it could resolve for. `0` means the population itself is empty. */
  of: number
  /** The IFC relation or attribute that supplies it. */
  relation: string
}

export interface BriefingDialectEntry {
  set: string
  property: string
  /** Elements carrying a non-null value, within the scanned set. */
  filled: number
  /** Elements scanned — NOT elements that could carry the property. */
  scanned: number
  /** German gloss when this property answers a question the rules ask. */
  concept: string | null
  sample: Array<string | number | boolean>
}

export interface BriefingRoomUse {
  aufenthaltsraum: number
  nebenraum: number
  erschliessung: number
  /** Spaces whose name matched no lexicon entry — including unnamed ones. */
  unklassifiziert: number
  /** False when the model publishes no spaces; the counts are then meaningless. */
  decidable: boolean
}

/**
 * The machine-readable précis. {@link renderBriefing} is a projection of this
 * and adds no facts of its own, so anything a caller reads in the text block it
 * can also read here without re-parsing German.
 */
export interface Briefing {
  /** sha256 of the source bytes — the identity of everything below. */
  contentHash: string
  schema: string
  sourceName: string | null
  originatingSystem: string | null
  totals: {
    entities: number
    nodes: number
    edges: number
    buildings: number
    storeys: number
    spaces: number
    windows: number
    doors: number
  }
  storeys: BriefingStorey[]
  /** Whether storey heights could be derived at all. See {@link storeyHeights}. */
  storeyHeightsDecidable: boolean
  byKind: BriefingCount[]
  byType: BriefingCount[]
  /** IFC types not in `byType` because the list is capped. */
  typesOmitted: number
  coverage: Coverage[]
  roomUse: BriefingRoomUse
  dialect: BriefingDialectEntry[]
  dialectOmitted: number
  /** Elements the dialect measurement looked at. */
  propertiesScanned: number
  /**
   * Decisive properties NOT found anywhere in this file.
   *
   * The dialect can only list what exists, so absence is invisible in it — and
   * absence is exactly what makes a filter return nothing. Naming the gap here
   * turns "no wall has a fire rating" into "this export publishes no fire
   * rating", which is the true statement and the actionable one.
   */
  absentProperties: Array<{ concept: string; property: string }>
  blindSpots: BlindSpot[]
}

/** IFC types printed in the type table before it is capped. */
const MAX_TYPES = 15
/** Property lines printed in the DIALEKT block. */
const MAX_DIALECT = 10
/** Storeys printed in the GESCHOSSE block. */
const MAX_STOREYS = 12
/** Blind spots printed; the builder emits a handful, a cap guards the budget. */
const MAX_BLIND_SPOTS = 8

/**
 * Properties that decide a question somebody actually asks, with the German
 * word the question is asked in.
 *
 * Two jobs: promote these to the front of the DIALEKT block when present (a
 * list sorted purely by fill count is dominated by exporter boilerplate), and
 * report them in `absentProperties` when not. Deliberately short — every entry
 * costs tokens in every briefing for every model.
 */
const DECISIVE_PROPERTIES: ReadonlyArray<{ concept: string; property: string }> = [
  { concept: 'Feuerwiderstand', property: 'FireRating' },
  { concept: 'Brennbarkeit', property: 'Combustible' },
  { concept: 'U-Wert', property: 'ThermalTransmittance' },
  { concept: 'Schallschutz', property: 'AcousticRating' },
  { concept: 'tragend', property: 'LoadBearing' },
  { concept: 'außenliegend', property: 'IsExternal' },
  { concept: 'Raumfläche', property: 'NetFloorArea' },
  { concept: 'Höhe', property: 'Height' },
  { concept: 'Brüstungshöhe', property: 'SillHeight' },
]

// ── briefing() ──────────────────────────────────────────────────────────────

/**
 * Compute the précis. Pure, deterministic, and free — no geometry, no IO, one
 * pass over nodes plus a few index lookups.
 *
 * Deterministic matters more than it sounds: this text enters the model's
 * context on every conversation about the file, so a briefing that varies
 * between calls makes two answers about the same building differ for reasons
 * nobody can reconstruct afterwards.
 */
export function briefing(graph: BuildingGraph): Briefing {
  const spaceIds = spaceIdsOf(graph)
  const windowIds = graph.byType.get('IfcWindow') ?? []
  const doorIds = graph.byType.get('IfcDoor') ?? []

  // Storey occupancy, counted from the resolved storey rather than from the
  // containment edge: an element contained in a space is still on a storey, and
  // `build.ts` resolves both. Counting edges would under-report every model
  // whose exporter nests elements inside spaces or assemblies.
  const elementsPerStorey = new Map<string, number>()
  const spacesPerStorey = new Map<string, number>()
  const kindCounts = new Map<NodeKind, number>()
  for (const node of graph.nodes.values()) {
    kindCounts.set(node.kind, (kindCounts.get(node.kind) ?? 0) + 1)
    if (!node.storeyGlobalId) continue
    if (node.kind === 'space') {
      spacesPerStorey.set(node.storeyGlobalId, (spacesPerStorey.get(node.storeyGlobalId) ?? 0) + 1)
    } else if (node.kind === 'element' || node.kind === 'opening') {
      elementsPerStorey.set(node.storeyGlobalId, (elementsPerStorey.get(node.storeyGlobalId) ?? 0) + 1)
    }
  }

  const heights = heightsOf(graph)
  const storeys: BriefingStorey[] = graph.storeys.map((storey) => ({
    globalId: storey.globalId,
    name: storeyName(storey),
    elevation: storey.elevation,
    height: heights.get(storey.globalId) ?? null,
    elementCount: elementsPerStorey.get(storey.globalId) ?? 0,
    spaceCount: spacesPerStorey.get(storey.globalId) ?? 0,
  }))

  const byType: BriefingCount[] = [...graph.byType.entries()]
    .map(([ifcType, ids]) => ({ key: ifcType, count: ids.length }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))

  const fillers = [...windowIds, ...doorIds]
  const hosted = fillers.filter((id) => out(graph, 'hostedIn', id).length > 0).length
  const bounded = spaceIds.filter((id) => out(graph, 'interfaceOf', id).length > 0).length
  const named = spaceIds.filter((id) => roomLabel(graph.nodes.get(id) ?? null) !== null).length
  const withElevation = graph.storeys.filter((s) => s.elevation !== null).length
  const placeable = [...graph.nodes.values()].filter((n) => n.kind === 'element' || n.kind === 'opening')
  const placed = placeable.filter((n) => n.storeyGlobalId !== null).length

  const coverage: Coverage[] = [
    {
      id: 'oeffnungenMitWand',
      what: 'Fenster/Türen einer Wand zugeordnet',
      n: hosted,
      of: fillers.length,
      relation: 'IfcRelVoidsElement + IfcRelFillsElement',
    },
    {
      id: 'raeumeMitBegrenzung',
      what: 'Räume mit deklarierter Raumbegrenzung',
      n: bounded,
      of: spaceIds.length,
      relation: 'IfcRelSpaceBoundary',
    },
    {
      id: 'raeumeMitNamen',
      what: 'Räume mit Namen',
      n: named,
      of: spaceIds.length,
      relation: 'IfcSpace.Name / LongName',
    },
    {
      id: 'geschosseMitHoehenlage',
      what: 'Geschoße mit Höhenlage',
      n: withElevation,
      of: graph.storeys.length,
      relation: 'IfcBuildingStorey.Elevation',
    },
    {
      id: 'bauteileMitGeschoss',
      what: 'Bauteile einem Geschoß zugeordnet',
      n: placed,
      of: placeable.length,
      relation: 'IfcRelContainedInSpatialStructure',
    },
  ]

  const classified = classifyRooms(graph)
  const roomUse: BriefingRoomUse = {
    aufenthaltsraum: classified.filter((r) => r.kind === 'aufenthaltsraum').length,
    nebenraum: classified.filter((r) => r.kind === 'nebenraum').length,
    erschliessung: classified.filter((r) => r.kind === 'erschliessung').length,
    unklassifiziert: classified.filter((r) => r.kind === null).length,
    decidable: spaceIds.length > 0,
  }

  const { dialect, omitted, absent } = summariseDialect(graph)

  return {
    contentHash: graph.contentHash,
    schema: graph.schema,
    sourceName: graph.sourceName,
    originatingSystem: graph.originatingSystem,
    totals: {
      entities: graph.stats.entities,
      nodes: graph.stats.nodes,
      edges: graph.stats.edges,
      buildings: (graph.byType.get('IfcBuilding') ?? []).length,
      storeys: graph.storeys.length,
      spaces: spaceIds.length,
      windows: windowIds.length,
      doors: doorIds.length,
    },
    storeys,
    storeyHeightsDecidable: withElevation >= 2,
    byKind: [...kindCounts.entries()]
      .map(([kind, count]) => ({ key: kind, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    byType: byType.slice(0, MAX_TYPES),
    typesOmitted: Math.max(0, byType.length - MAX_TYPES),
    coverage,
    roomUse,
    dialect,
    dialectOmitted: omitted,
    propertiesScanned: graph.dialect[0]?.candidates ?? 0,
    absentProperties: absent,
    blindSpots: graph.blindSpots,
  }
}

// ── renderBriefing() ────────────────────────────────────────────────────────

/**
 * The text block the agent gets in context. The single most important function
 * in this module.
 *
 * ## Why render at all, when `briefing()` returns JSON
 *
 * Because this is read by a language model under a budget, and JSON spends a
 * third of its tokens on punctuation and repeated keys. A fixed-column block
 * with German labels also has a property JSON does not: it is quotable. An
 * agent that copies `Pset_WallCommon.ThermalTransmittance` out of the DIALEKT
 * block cannot mistype it, which was the failure this whole module exists to
 * prevent.
 *
 * ## The budget is a correctness feature, not a cost feature
 *
 * Every list here is capped and every cap announces what it dropped
 * (`+18 weitere Typen`). Silent truncation is the same bug as a subset reported
 * as a total: an agent reading a list that ENDS believes it is complete, and
 * then answers "the model contains no IfcRamp" from a table that was cut at 15
 * rows. Target is ~1 200 tokens; a large model with a rich dialect stays inside
 * it because the caps, not the model, decide the length.
 */
export function renderBriefing(graph: BuildingGraph): string {
  const b = briefing(graph)
  const lines: string[] = []
  const add = (label: string, ...body: string[]) => {
    for (const [index, text] of body.entries()) {
      lines.push(`${index === 0 ? label.padEnd(10) : ' '.repeat(10)}${text}`)
    }
  }

  // GEBÄUDE ─ identity first, so a briefing pasted into a transcript can still
  // be matched to the file it describes six turns later.
  const identity = [
    b.sourceName ?? 'Datei ohne Namen im IFC-Header',
    b.schema,
    b.originatingSystem ?? 'Herkunftssystem nicht im Header deklariert',
    `sha ${b.contentHash.slice(0, 8)}`,
  ]
  add(
    'GEBÄUDE',
    identity.join(' · '),
    [
      // A missing spatial container is named by its ENTITY, never counted as
      // zero: "0 Gebäude" is a sentence about a building site, "kein
      // IfcBuilding" is a sentence about this export — which is the true one.
      b.totals.buildings > 0 ? plural(b.totals.buildings, 'Gebäude', 'Gebäude') : 'kein IfcBuilding',
      b.totals.storeys > 0 ? plural(b.totals.storeys, 'Geschoß', 'Geschoße') : 'keine IfcBuildingStorey',
      b.totals.spaces > 0 ? plural(b.totals.spaces, 'Raum', 'Räume') : 'keine IfcSpace',
      `${b.totals.nodes} Knoten`,
      `${b.totals.edges} Beziehungen`,
    ].join(' · ')
  )

  // GESCHOSSE ─ the names an agent must not invent. A model with no storey
  // structure says so; it never renders as an empty list.
  if (b.storeys.length === 0) {
    add('GESCHOSSE', 'keine IfcBuildingStorey — dieser Export enthält keine Geschoßgliederung')
  } else {
    const shown = b.storeys.slice(0, MAX_STOREYS)
    const cells = shown.map((storey) => {
      const height = storey.height === null ? '' : ` h ${storey.height.toFixed(2)}`
      const where = storey.elevation === null ? 'ohne Höhenlage' : metres(storey.elevation)
      return `${storey.name ?? storey.globalId} ${where}${height} · ${storey.elementCount} Bauteile`
    })
    const overflow = b.storeys.length - shown.length
    add('GESCHOSSE', ...wrap(cells, ' | ', overflow > 0 ? `(+${overflow} weitere Geschoße)` : null))
    add(
      '',
      b.storeyHeightsDecidable
        ? 'h = Rohbau-Geschoßhöhe OK–OK aus den Höhenlagen, kein Deckenaufbau abgezogen — nicht die lichte Raumhöhe'
        : 'keine Geschoßhöhen: weniger als zwei Geschoße veröffentlichen eine Höhenlage'
    )
  }

  // BAUTEILE ─ the type vocabulary. An agent filtering on `IfcWallStandardCase`
  // in an IFC4 file that only has `IfcWall` gets nothing; this block is where it
  // finds out which spelling this file uses.
  if (b.byType.length === 0) {
    add('BAUTEILE', 'keine Bauteile im Modell — dieser Export enthält keine IfcProduct-Instanzen')
  } else {
    const cells = b.byType.map((entry) => `${entry.key} ${entry.count}`)
    add(
      'BAUTEILE',
      ...wrap(cells, ' · ', b.typesOmitted > 0 ? `(+${b.typesOmitted} weitere Typen)` : null)
    )
  }

  // RÄUME ─ every count here is `n von m` with the responsible relation named,
  // so a zero can be read as a statement about the export and not the building.
  if (b.totals.spaces === 0) {
    add(
      'RÄUME',
      'keine IfcSpace/IfcSpatialZone — Räume wurden nicht exportiert; über die Raumaufteilung des',
      'Gebäudes sagt das nichts'
    )
  } else {
    add('RÄUME', `${b.totals.spaces} IfcSpace/IfcSpatialZone`)
    for (const id of ['raeumeMitNamen', 'raeumeMitBegrenzung'] as const) {
      const entry = b.coverage.find((c) => c.id === id)
      if (entry) add('', coverageLine(entry))
    }
    const use = b.roomUse
    add(
      '',
      `Lexikonvorschlag (unbestätigt): ${use.aufenthaltsraum} Aufenthalts-, ${use.nebenraum} Neben-, ` +
        `${use.erschliessung} Erschließungsräume, ${use.unklassifiziert} ohne Zuordnung`
    )
    add('', 'Aufenthaltsraum ist eine rechtliche Einstufung — dieser Vorschlag ersetzt keine Prüfung')
  }

  // ÖFFNUNGEN ─ window↔wall is the relation most exports drop, and its absence
  // is the difference between "no window in this wall" and "no relation in this
  // file".
  const openings = b.coverage.find((c) => c.id === 'oeffnungenMitWand')
  if (b.totals.windows + b.totals.doors === 0) {
    add('ÖFFNUNGEN', 'keine IfcWindow/IfcDoor — Öffnungen wurden nicht exportiert')
  } else {
    add('ÖFFNUNGEN', `${b.totals.windows} Fenster · ${b.totals.doors} Türen`)
    if (openings) add('', coverageLine(openings))
  }

  // DIALEKT ─ the reason this module exists. Absolute counts, not percentages of
  // a population nobody defined: `graph.dialect` measures fill against every
  // scanned element, so "3 %" for a wall property would be arithmetic on the
  // wrong denominator, printed as a fact.
  if (b.dialect.length === 0) {
    add('DIALEKT', 'keine Merkmale gefunden — dieser Export schreibt keine Property Sets an Bauteile')
  } else {
    add('DIALEKT', `${b.propertiesScanned} Bauteile untersucht; Zahl = Bauteile mit befülltem Wert`)
    for (const entry of b.dialect) {
      const gloss = entry.concept ? `${entry.concept} → ` : ''
      const sample = entry.sample.length > 0 ? `  [${entry.sample.slice(0, 2).map(shorten).join(', ')}]` : ''
      add('', `${gloss}${entry.set}.${entry.property} ${entry.filled}${sample}`)
    }
    if (b.dialectOmitted > 0) add('', `(+${b.dialectOmitted} weitere Merkmale, nach Befüllung sortiert)`)
  }

  // FEHLT ─ what the DIALEKT block structurally cannot show. A property absent
  // from the file has no row to appear in, and a filter on it returns nothing
  // that looks exactly like a real negative answer.
  // Suppressed when the dialect is empty: the DIALEKT block has already said
  // that this export writes no property sets at all, and repeating every
  // decisive property underneath it would imply nine separate findings where
  // there is one.
  if (b.absentProperties.length > 0 && b.dialect.length > 0) {
    add(
      'FEHLT',
      ...wrap(
        b.absentProperties.map((entry) => `${entry.concept} (${entry.property})`),
        ' · ',
        null
      )
    )
    add('', 'nirgends in dieser Datei befüllt — eine Abfrage darauf liefert leer, nicht „nein"')
  }

  // BLIND ─ the honesty budget, precomputed by the graph builder.
  const spots = b.blindSpots.slice(0, MAX_BLIND_SPOTS)
  if (spots.length > 0) {
    add('BLIND', ...spots.map((spot) => `${spot.what} → ${spot.consequence}; Abhilfe: ${spot.remedy}`))
    const overflow = b.blindSpots.length - spots.length
    if (overflow > 0) add('', `(+${overflow} weitere)`)
  }

  return lines.join('\n')
}

// ── storeyHeights() ─────────────────────────────────────────────────────────

/**
 * Storey heights as the difference between consecutive declared elevations.
 *
 * ## Why the caveat is not optional
 *
 * This number is a *Rohbau-Geschoßhöhe*: top of slab to top of slab. The number
 * an architect is usually being asked for — and the one OIB 3 §3 and every
 * habitable-room check want — is the *lichte Raumhöhe*, which is this minus the
 * floor build-up and the slab. The two differ by 30–50 cm, which is the entire
 * margin of a 2.50 m minimum. Reporting the storey pitch as a room height turns
 * a failing room into a passing one, and reads perfectly while doing it. So the
 * caveat travels with the value, and a caller that drops it is publishing a
 * different claim than the one this function makes.
 *
 * ## Why the top storey is `null`
 *
 * There is no next elevation. Every fallback available — the storey below,
 * an average, a default 2.80 — is a fabrication that the answer contract has no
 * way to mark, since it would arrive as a number like all the others. `null`
 * survives into the render as "nicht bestimmbar", which is true.
 *
 * Storeys with no declared elevation are excluded rather than interpolated, and
 * the caveat says how many, because a silently shortened list is a subset
 * reported as a total.
 */
export function storeyHeights(
  graph: BuildingGraph
): Answer<Array<{ storey: string; elevation: number; height: number | null }>> {
  const method = 'storeyHeights(graph)'
  // `graph.storeys` is sorted lowest-first with elevation-less storeys last, so
  // the filter preserves the ordering the difference depends on. Re-sorting here
  // would silently disagree with the builder if its rule ever changed.
  const withElevation = graph.storeys.filter(
    (storey): storey is GraphNode & { elevation: number } => storey.elevation !== null
  )
  const missingElevation = graph.storeys.length - withElevation.length

  if (withElevation.length < 2) {
    return undecidable({
      from: graph.storeys.map((storey) => storey.globalId),
      method,
      provenance: 'computed',
      missing: {
        what: 'IfcBuildingStorey.Elevation',
        remedy:
          withElevation.length === 0 && graph.storeys.length === 0
            ? 'Das Modell enthält keine IfcBuildingStorey. Geschoße im CAD anlegen und mitexportieren.'
            : 'Mindestens zwei Geschoße müssen eine Höhenlage (Elevation) deklarieren. ' +
              'Im CAD die Geschoßhöhen setzen und neu exportieren.',
        elements: graph.storeys.map((storey) => storey.globalId),
      },
    })
  }

  const value = withElevation.map((storey, index) => {
    const next = withElevation[index + 1]
    return {
      storey: storeyName(storey) ?? storey.globalId,
      elevation: storey.elevation,
      // Rounded to the millimetre: the difference of two floating-point
      // elevations produces 2.8499999999999996, and a height printed with
      // sixteen digits reads as a precision this value does not have.
      height: next ? Math.round((next.elevation - storey.elevation) * 1000) / 1000 : null,
    }
  })

  const caveat = [
    'Rohbau-Geschoßhöhe von Geschoßoberkante zu Geschoßoberkante, gebildet aus den deklarierten ' +
      'Höhenlagen. Kein Deckenaufbau und keine Deckenstärke abgezogen — das ist NICHT die lichte ' +
      'Raumhöhe und nicht für einen Raumhöhennachweis verwendbar.',
    `Das oberste Geschoß (${value[value.length - 1]?.storey ?? '—'}) hat keine nächste Höhenlage; ` +
      'seine Höhe bleibt offen statt geschätzt.',
  ]
  if (missingElevation > 0) {
    caveat.push(
      `${missingElevation} Geschoß(e) ohne deklarierte Höhenlage sind nicht enthalten — die Liste ist ` +
        'kein vollständiges Geschoßverzeichnis.'
    )
  }
  // A non-positive pitch is not a building; it is two storeys sharing an
  // elevation or an inverted export. Worth surfacing, because every downstream
  // height check would otherwise consume it as a measurement.
  const suspicious = value.filter((entry) => entry.height !== null && entry.height <= 0).length
  if (suspicious > 0) {
    caveat.push(
      `${suspicious} Geschoßübergang(e) ergeben eine Höhe ≤ 0 — zwei Geschoße mit gleicher oder ` +
        'fallender Höhenlage. Das ist ein Befund über den Export, nicht über das Gebäude.'
    )
  }

  return computed(value, {
    unit: 'm',
    from: withElevation.map((storey) => storey.globalId),
    method,
    caveat: caveat.join(' '),
  })
}

// ── inventory() ─────────────────────────────────────────────────────────────

export type RoomUseKind = 'aufenthaltsraum' | 'nebenraum' | 'erschliessung'

export interface RoomProposal {
  globalId: string
  name: string | null
  confidence: number
  because: string[]
}

/**
 * Propose which rooms are Aufenthaltsräume, Nebenräume or Erschließungsflächen,
 * from what they are CALLED.
 *
 * ## This is a proposal for a human, never a verdict
 *
 * **Aufenthaltsraum is a legal classification, not a geometric one.** OIB and
 * the Länder-Bauordnungen define it by intended use — a room meant for more
 * than transient occupancy — and that intent lives in the architect's head and
 * the Einreichplan, not in the IFC file. Nothing measurable settles it: a 14 m²
 * room with a window is a Kinderzimmer or a Lagerraum depending on what the
 * plan says it is.
 *
 * What this function has is the name the architect typed. That is real evidence
 * — people call bedrooms "Schlafen" — and it is *only* evidence. So every result
 * is `inferred`, carries a per-room confidence and the reasons behind it, and is
 * phrased as a proposal a human confirms. An agent that reports "7
 * Aufenthaltsräume" as a finding has misused this function; the correct sentence
 * names it as a naming-based proposal and asks for confirmation.
 *
 * ## Why the lexicon is German and umlaut-tolerant
 *
 * The room names in an Austrian or German model are German, and exporters
 * mangle umlauts in three different ways depending on the file's encoding and
 * the CAD's locale: `Küche`, `Kueche`, `KÜCHE`, and NFD-decomposed `Küche` are
 * all the same room. Matching on the raw string would classify the same building
 * differently depending on which machine exported it.
 *
 * ## Why the longest match wins
 *
 * `Waschküche` contains `küche`. Ranking matches by the length of the matched
 * term puts a laundry in `nebenraum` where it belongs, instead of proposing it
 * as a habitable room because it has a kitchen in its name.
 */
export function inventory(graph: BuildingGraph, kind: RoomUseKind): Answer<RoomProposal[]> {
  const method = `inventory(graph, '${kind}')`
  const spaceIds = spaceIdsOf(graph)

  if (spaceIds.length === 0) {
    return undecidable({
      from: [],
      method,
      provenance: 'inferred',
      missing: {
        what: 'IfcSpace',
        remedy:
          'Dieser Export enthält keine Räume. Räume im CAD als IfcSpace exportieren — ohne sie ist ' +
          'keine Raumnutzung ableitbar, weder aus Namen noch aus Geometrie.',
      },
    })
  }

  const classified = classifyRooms(graph)
  const matching = classified.filter((room) => room.kind === kind)
  const unnamed = classified.filter((room) => room.name === null).length
  const unclassified = classified.filter((room) => room.kind === null).length

  const value: RoomProposal[] = matching.map((room) => ({
    globalId: room.globalId,
    name: room.name,
    confidence: room.confidence,
    because: room.because,
  }))

  const because = [
    `Einstufung aus dem Raumnamen gegen ein deutsch/österreichisch-englisches Lexikon (${LEXICON.length} Einträge), ` +
      'Groß-/Kleinschreibung und Umlautvarianten (Küche/Kueche/KÜCHE) vereinheitlicht.',
    'Bei mehreren Treffern gewinnt der längere Begriff (Waschküche vor Küche).',
    `${matching.length} von ${spaceIds.length} Räumen als ${GERMAN_KIND[kind]} vorgeschlagen.`,
  ]
  if (graph.stats.edgesByKind['opensTo']) {
    because.push('Fensterzuordnung (opensTo) als Zusatzsignal, wo der Export sie hergibt.')
  } else {
    because.push(
      'Keine Fensterzuordnung im Modell — die Einstufung stützt sich allein auf den Namen, nicht auf Belichtung.'
    )
  }

  const caveat = [
    'Aufenthaltsraum ist eine RECHTLICHE Einstufung nach der Nutzung, keine geometrische Eigenschaft. ' +
      'Diese Liste ist ein Vorschlag aus Raumnamen und muss von einem Menschen bestätigt werden — sie ' +
      'ist kein Nachweis und keine Feststellung.',
  ]
  if (unnamed > 0) {
    caveat.push(`${unnamed} Raum/Räume tragen keinen Namen und konnten gar nicht eingestuft werden.`)
  }
  if (unclassified > unnamed) {
    caveat.push(
      `${unclassified - unnamed} weitere Raumnamen passen zu keinem Lexikoneintrag — ein Befund über die ` +
        'Raumbenennung im Export, nicht über die Nutzung.'
    )
  }
  if (value.length === 0) {
    caveat.push(
      `Kein Raumname in diesem Modell deutet auf ${GERMAN_KIND[kind]} hin. Das heißt nicht, dass das ` +
        'Gebäude keine hat — es heißt, dass die Benennung im Export nichts dazu sagt.'
    )
  }

  // The envelope's single confidence is the mean of the per-room values, so a
  // list built from three weak substring matches cannot present itself with the
  // same authority as a list of exact hits. Per-room numbers stay in `value`;
  // this one is what a renderer puts in front of the sentence.
  const mean =
    value.length === 0
      ? 0
      : Math.round((value.reduce((sum, room) => sum + room.confidence, 0) / value.length) * 100) / 100

  return inferred(value, {
    from: value.map((room) => room.globalId),
    method,
    confidence: mean,
    because,
    caveat: caveat.join(' '),
  })
}

// ── the lexicon ─────────────────────────────────────────────────────────────

interface LexiconEntry {
  /** Normalised search term — lower case, umlauts transliterated. */
  term: string
  kind: RoomUseKind
  /**
   * A term that is suggestive but not decisive on its own (`halle`, `gang`).
   * Caps confidence, because a "Halle" is a foyer in one plan and a workshop in
   * the next.
   */
  weak?: boolean
  /** A qualification that belongs in this room's `because` when it matches. */
  note?: string
}

const GERMAN_KIND: Record<RoomUseKind, string> = {
  aufenthaltsraum: 'Aufenthaltsraum',
  nebenraum: 'Nebenraum',
  erschliessung: 'Erschließungsfläche',
}

/**
 * The room-name lexicon, in normalised form (no umlauts, lower case).
 *
 * Ordering is irrelevant — matching ranks by term length, not by position —
 * which means an entry can be added without reasoning about what it shadows.
 */
const LEXICON: ReadonlyArray<LexiconEntry> = [
  // Aufenthaltsräume: rooms for more than transient occupancy.
  { term: 'wohnzimmer', kind: 'aufenthaltsraum' },
  { term: 'wohnraum', kind: 'aufenthaltsraum' },
  { term: 'wohnkueche', kind: 'aufenthaltsraum' },
  { term: 'wohnessbereich', kind: 'aufenthaltsraum' },
  { term: 'wohnen', kind: 'aufenthaltsraum' },
  { term: 'esszimmer', kind: 'aufenthaltsraum' },
  { term: 'essplatz', kind: 'aufenthaltsraum' },
  { term: 'essen', kind: 'aufenthaltsraum' },
  { term: 'speisesaal', kind: 'aufenthaltsraum' },
  { term: 'schlafzimmer', kind: 'aufenthaltsraum' },
  { term: 'schlafraum', kind: 'aufenthaltsraum' },
  { term: 'schlafen', kind: 'aufenthaltsraum' },
  { term: 'kinderzimmer', kind: 'aufenthaltsraum' },
  { term: 'jugendzimmer', kind: 'aufenthaltsraum' },
  { term: 'gaestezimmer', kind: 'aufenthaltsraum' },
  { term: 'zimmer', kind: 'aufenthaltsraum', weak: true, note: '„Zimmer" allein sagt die Nutzung nicht' },
  {
    term: 'kueche',
    kind: 'aufenthaltsraum',
    note: 'Küchen zählen nur als Aufenthaltsraum, wenn sie zum nicht nur vorübergehenden Aufenthalt bestimmt sind — eine Kochnische nicht',
  },
  { term: 'kochen', kind: 'aufenthaltsraum' },
  { term: 'arbeitszimmer', kind: 'aufenthaltsraum' },
  { term: 'arbeitsraum', kind: 'aufenthaltsraum' },
  { term: 'arbeiten', kind: 'aufenthaltsraum' },
  { term: 'bueroraum', kind: 'aufenthaltsraum' },
  { term: 'buero', kind: 'aufenthaltsraum' },
  { term: 'aufenthaltsraum', kind: 'aufenthaltsraum' },
  { term: 'aufenthalt', kind: 'aufenthaltsraum' },
  { term: 'wintergarten', kind: 'aufenthaltsraum' },
  { term: 'gastraum', kind: 'aufenthaltsraum' },
  { term: 'besprechungsraum', kind: 'aufenthaltsraum' },
  { term: 'besprechung', kind: 'aufenthaltsraum' },
  { term: 'konferenzraum', kind: 'aufenthaltsraum' },
  { term: 'seminarraum', kind: 'aufenthaltsraum' },
  { term: 'klassenzimmer', kind: 'aufenthaltsraum' },
  { term: 'gruppenraum', kind: 'aufenthaltsraum' },
  { term: 'spielzimmer', kind: 'aufenthaltsraum' },
  { term: 'spielraum', kind: 'aufenthaltsraum' },
  { term: 'atelier', kind: 'aufenthaltsraum' },
  { term: 'ordination', kind: 'aufenthaltsraum' },
  { term: 'verkaufsraum', kind: 'aufenthaltsraum' },
  { term: 'bibliothek', kind: 'aufenthaltsraum' },

  // Nebenräume: served rooms, not meant for lasting occupancy.
  { term: 'badezimmer', kind: 'nebenraum' },
  { term: 'baderaum', kind: 'nebenraum' },
  { term: 'bad', kind: 'nebenraum' },
  { term: 'dusche', kind: 'nebenraum' },
  { term: 'duschbad', kind: 'nebenraum' },
  { term: 'wc', kind: 'nebenraum' },
  { term: 'toilette', kind: 'nebenraum' },
  { term: 'sanitaer', kind: 'nebenraum' },
  { term: 'abstellraum', kind: 'nebenraum' },
  { term: 'abstell', kind: 'nebenraum' },
  { term: 'abstellnische', kind: 'nebenraum' },
  { term: 'vorratsraum', kind: 'nebenraum' },
  { term: 'vorrat', kind: 'nebenraum' },
  { term: 'speisekammer', kind: 'nebenraum' },
  { term: 'speis', kind: 'nebenraum' },
  { term: 'hauswirtschaftsraum', kind: 'nebenraum' },
  { term: 'hausanschlussraum', kind: 'nebenraum' },
  { term: 'hwr', kind: 'nebenraum' },
  { term: 'technikraum', kind: 'nebenraum' },
  { term: 'haustechnik', kind: 'nebenraum' },
  { term: 'technik', kind: 'nebenraum' },
  { term: 'heizraum', kind: 'nebenraum' },
  { term: 'heizung', kind: 'nebenraum' },
  { term: 'lueftungszentrale', kind: 'nebenraum' },
  { term: 'elektroraum', kind: 'nebenraum' },
  { term: 'serverraum', kind: 'nebenraum' },
  { term: 'lagerraum', kind: 'nebenraum' },
  { term: 'lager', kind: 'nebenraum' },
  { term: 'kellerabteil', kind: 'nebenraum' },
  { term: 'keller', kind: 'nebenraum' },
  { term: 'waschkueche', kind: 'nebenraum' },
  { term: 'waschraum', kind: 'nebenraum' },
  { term: 'trockenraum', kind: 'nebenraum' },
  { term: 'putzraum', kind: 'nebenraum' },
  { term: 'muellraum', kind: 'nebenraum' },
  { term: 'abfall', kind: 'nebenraum' },
  { term: 'garage', kind: 'nebenraum' },
  { term: 'carport', kind: 'nebenraum' },
  { term: 'fahrradraum', kind: 'nebenraum' },
  { term: 'kinderwagenraum', kind: 'nebenraum' },
  { term: 'kinderwagen', kind: 'nebenraum' },
  { term: 'schrankraum', kind: 'nebenraum' },
  { term: 'ankleide', kind: 'nebenraum' },
  { term: 'garderobe', kind: 'nebenraum' },
  { term: 'sauna', kind: 'nebenraum' },
  { term: 'dachboden', kind: 'nebenraum' },
  { term: 'aufzugsschacht', kind: 'nebenraum' },
  { term: 'schacht', kind: 'nebenraum', weak: true },
  // Freibereiche are neither: they cannot be Aufenthaltsräume, and calling them
  // Nebenräume is a stretch. They are placed here rather than left unmatched so
  // that a terrace never lands in the habitable-room proposal, and the `note`
  // carries the qualification into the reasons.
  {
    term: 'balkon',
    kind: 'nebenraum',
    note: 'Freibereich — kein Aufenthaltsraum, aber auch kein Nebenraum im engeren Sinn',
  },
  {
    term: 'terrasse',
    kind: 'nebenraum',
    note: 'Freibereich — kein Aufenthaltsraum, aber auch kein Nebenraum im engeren Sinn',
  },
  {
    term: 'loggia',
    kind: 'nebenraum',
    note: 'Freibereich — kein Aufenthaltsraum, aber auch kein Nebenraum im engeren Sinn',
  },
  {
    term: 'dachterrasse',
    kind: 'nebenraum',
    note: 'Freibereich — kein Aufenthaltsraum, aber auch kein Nebenraum im engeren Sinn',
  },

  // Erschließung: circulation.
  { term: 'flur', kind: 'erschliessung' },
  { term: 'gang', kind: 'erschliessung' },
  { term: 'diele', kind: 'erschliessung' },
  { term: 'vorraum', kind: 'erschliessung' },
  { term: 'vorzimmer', kind: 'erschliessung' },
  { term: 'stiegenhaus', kind: 'erschliessung' },
  { term: 'stiege', kind: 'erschliessung' },
  { term: 'treppenhaus', kind: 'erschliessung' },
  { term: 'treppenraum', kind: 'erschliessung' },
  { term: 'treppe', kind: 'erschliessung' },
  { term: 'korridor', kind: 'erschliessung' },
  { term: 'erschliessung', kind: 'erschliessung' },
  { term: 'windfang', kind: 'erschliessung' },
  { term: 'eingangsbereich', kind: 'erschliessung' },
  { term: 'eingang', kind: 'erschliessung' },
  { term: 'foyer', kind: 'erschliessung' },
  { term: 'halle', kind: 'erschliessung', weak: true, note: '„Halle" kann Eingangshalle oder Nutzungshalle sein' },
  { term: 'liftvorraum', kind: 'erschliessung' },
  { term: 'aufzug', kind: 'erschliessung' },
  { term: 'lift', kind: 'erschliessung' },
  { term: 'laubengang', kind: 'erschliessung' },
  { term: 'rampe', kind: 'erschliessung' },
  { term: 'fluchtweg', kind: 'erschliessung' },
  { term: 'schleuse', kind: 'erschliessung' },
  { term: 'podest', kind: 'erschliessung' },

  // ── English, because the export language is not the building's country ────
  //
  // The file this library was first measured against is an Austrian sample
  // house exported from Revit with its rooms named "Living room", "Bedroom",
  // "Entrance hall" — and a German-only lexicon classified none of the four.
  // That failure is the common case, not the exotic one: the authoring tool's
  // UI language decides these strings, and an office running an English Revit
  // produces English room names for a building in Vienna. A lexicon that only
  // reads German silently reports "0 Aufenthaltsräume" about a house full of
  // them, which is worse than saying nothing.
  { term: 'living room', kind: 'aufenthaltsraum' },
  { term: 'livingroom', kind: 'aufenthaltsraum' },
  { term: 'sitting room', kind: 'aufenthaltsraum' },
  { term: 'family room', kind: 'aufenthaltsraum' },
  { term: 'dining room', kind: 'aufenthaltsraum' },
  { term: 'dining', kind: 'aufenthaltsraum' },
  { term: 'lounge', kind: 'aufenthaltsraum' },
  { term: 'kitchen', kind: 'aufenthaltsraum' },
  { term: 'master bedroom', kind: 'aufenthaltsraum' },
  { term: 'bedroom', kind: 'aufenthaltsraum' },
  { term: 'bed room', kind: 'aufenthaltsraum' },
  { term: 'guest room', kind: 'aufenthaltsraum' },
  { term: 'nursery', kind: 'aufenthaltsraum' },
  { term: 'children', kind: 'aufenthaltsraum' },
  { term: 'study', kind: 'aufenthaltsraum' },
  { term: 'home office', kind: 'aufenthaltsraum' },
  { term: 'office', kind: 'aufenthaltsraum' },
  { term: 'workroom', kind: 'aufenthaltsraum' },
  { term: 'classroom', kind: 'aufenthaltsraum' },
  { term: 'meeting room', kind: 'aufenthaltsraum' },
  { term: 'living', kind: 'aufenthaltsraum', weak: true, note: '„living" allein kann auch Wohnbereich einer Erschließung sein' },
  { term: 'room', kind: 'aufenthaltsraum', weak: true, note: '„room" allein sagt die Nutzung nicht' },

  { term: 'bathroom', kind: 'nebenraum' },
  { term: 'shower room', kind: 'nebenraum' },
  { term: 'bath', kind: 'nebenraum' },
  { term: 'toilet', kind: 'nebenraum' },
  { term: 'restroom', kind: 'nebenraum' },
  { term: 'store room', kind: 'nebenraum' },
  { term: 'storeroom', kind: 'nebenraum' },
  { term: 'storage', kind: 'nebenraum' },
  { term: 'utility room', kind: 'nebenraum' },
  { term: 'utility', kind: 'nebenraum' },
  { term: 'laundry', kind: 'nebenraum' },
  { term: 'plant room', kind: 'nebenraum' },
  { term: 'technical room', kind: 'nebenraum' },
  { term: 'boiler room', kind: 'nebenraum' },
  { term: 'basement', kind: 'nebenraum' },
  { term: 'cellar', kind: 'nebenraum' },
  { term: 'pantry', kind: 'nebenraum' },
  { term: 'larder', kind: 'nebenraum' },
  { term: 'wardrobe', kind: 'nebenraum' },
  { term: 'closet', kind: 'nebenraum' },
  { term: 'cloakroom', kind: 'nebenraum' },
  { term: 'attic', kind: 'nebenraum' },
  { term: 'bin store', kind: 'nebenraum' },
  { term: 'bike store', kind: 'nebenraum' },
  { term: 'balcony', kind: 'nebenraum', note: 'Freibereich — kein Aufenthaltsraum, aber auch kein Nebenraum im engeren Sinn' },
  { term: 'terrace', kind: 'nebenraum', note: 'Freibereich — kein Aufenthaltsraum, aber auch kein Nebenraum im engeren Sinn' },

  { term: 'entrance hall', kind: 'erschliessung' },
  { term: 'entrance', kind: 'erschliessung' },
  { term: 'hallway', kind: 'erschliessung' },
  { term: 'corridor', kind: 'erschliessung' },
  { term: 'passage', kind: 'erschliessung' },
  { term: 'lobby', kind: 'erschliessung' },
  { term: 'foyer', kind: 'erschliessung' },
  { term: 'staircase', kind: 'erschliessung' },
  { term: 'stairwell', kind: 'erschliessung' },
  { term: 'stairs', kind: 'erschliessung' },
  { term: 'stair', kind: 'erschliessung' },
  { term: 'landing', kind: 'erschliessung' },
  { term: 'vestibule', kind: 'erschliessung' },
  { term: 'porch', kind: 'erschliessung' },
  { term: 'elevator', kind: 'erschliessung' },
  { term: 'circulation', kind: 'erschliessung' },
  { term: 'hall', kind: 'erschliessung', weak: true, note: '„hall" kann Eingangshalle oder Nutzungshalle sein' },
]

/** Confidence by how the term was found. Exact beats word beats substring. */
const MATCH_CONFIDENCE = { exakt: 0.9, wort: 0.8, teil: 0.65 } as const
type MatchQuality = keyof typeof MATCH_CONFIDENCE
/**
 * Terms shorter than this are only matched on a word boundary.
 *
 * `wc` and `bad` as substrings hit room codes and foreign words (`BAD-03` is
 * fine, `Badminton` is not, and a Revit room named `WCB2` is a code). A short
 * term inside a longer word carries almost no signal, and the false positives
 * are exactly the confident-wrong kind.
 */
const MIN_SUBSTRING_TERM = 4

interface ClassifiedRoom {
  globalId: string
  name: string | null
  kind: RoomUseKind | null
  confidence: number
  because: string[]
}

/**
 * Run the lexicon over every space once. Shared by {@link inventory} and
 * {@link briefing} so the counts in the text block and the lists a caller
 * requests cannot disagree — two independent classifiers over one model is a
 * contradiction waiting to be quoted.
 */
function classifyRooms(graph: BuildingGraph): ClassifiedRoom[] {
  const hasOpensTo = (graph.stats.edgesByKind['opensTo'] ?? 0) > 0

  return spaceIdsOf(graph).map((globalId) => {
    const node = graph.nodes.get(globalId) ?? null
    const name = roomLabel(node)
    if (name === null) {
      return {
        globalId,
        name: null,
        kind: null,
        confidence: 0,
        because: ['Der Raum trägt weder Name noch LongName — nichts, worauf sich eine Einstufung stützen könnte.'],
      }
    }

    const normalised = normalise(name)
    const best = new Map<RoomUseKind, { entry: LexiconEntry; quality: MatchQuality }>()
    for (const entry of LEXICON) {
      const quality = matchQuality(normalised, entry.term)
      if (!quality) continue
      const current = best.get(entry.kind)
      // Longest term wins within a kind too, so the `note` that travels into the
      // reasons is the one from the most specific match.
      if (!current || entry.term.length > current.entry.term.length) best.set(entry.kind, { entry, quality })
    }
    if (best.size === 0) {
      return {
        globalId,
        name,
        kind: null,
        confidence: 0,
        because: [`Der Name „${name}" passt zu keinem Lexikoneintrag.`],
      }
    }

    const ranked = [...best.entries()].sort(
      (a, b) =>
        b[1].entry.term.length - a[1].entry.term.length ||
        MATCH_CONFIDENCE[b[1].quality] - MATCH_CONFIDENCE[a[1].quality]
    )
    const [kind, winner] = ranked[0]!
    const runnerUp = ranked[1]

    const because: string[] = [
      `Name „${name}" enthält „${winner.entry.term}" (${QUALITY_TEXT[winner.quality]}) → ${GERMAN_KIND[kind]}.`,
    ]
    let confidence: number = MATCH_CONFIDENCE[winner.quality]

    if (winner.entry.weak) {
      confidence = Math.min(confidence, 0.55)
      because.push(winner.entry.note ?? `„${winner.entry.term}" ist ein schwaches Signal.`)
    } else if (winner.entry.note) {
      because.push(winner.entry.note)
    }

    if (runnerUp) {
      const [otherKind, other] = runnerUp
      if (other.entry.term.length === winner.entry.term.length) {
        confidence *= 0.85
        because.push(
          `Mehrdeutig: „${other.entry.term}" spricht gleich stark für ${GERMAN_KIND[otherKind]}.`
        )
      } else {
        because.push(
          `„${winner.entry.term}" schlägt „${other.entry.term}" (${GERMAN_KIND[otherKind]}) als längerer Treffer.`
        )
      }
    }

    // The window signal is only evidence in a file that publishes the relation
    // at all. In a model with no `opensTo` edges, "this room has no window" is a
    // fact about the export — using it to lower a confidence would let an export
    // setting argue about a building.
    if (hasOpensTo) {
      const lit = into(graph, 'opensTo', globalId).some(
        (elementId) => graph.nodes.get(elementId)?.ifcType === 'IfcWindow'
      )
      if (lit) {
        confidence += 0.05
        because.push('Dem Raum ist mindestens ein Fenster zugeordnet (opensTo).')
      } else if (kind === 'aufenthaltsraum') {
        confidence -= 0.05
        because.push('Diesem Raum ist kein Fenster zugeordnet, obwohl das Modell Fensterzuordnungen führt.')
      }
    }

    return {
      globalId,
      name,
      kind,
      confidence: Math.round(Math.min(0.95, Math.max(0.3, confidence)) * 100) / 100,
      because,
    }
  })
}

const QUALITY_TEXT: Record<MatchQuality, string> = {
  exakt: 'exakter Name',
  wort: 'als ganzes Wort',
  teil: 'als Wortbestandteil',
}

function matchQuality(normalised: string, term: string): MatchQuality | null {
  if (normalised === term) return 'exakt'
  // Whole-word match by padding rather than by `new RegExp('(^| )' + term + '( |$)')`.
  //
  // Padding both sides with a space makes „starts-or-space" and „space-or-ends"
  // into one plain substring test, and it is EXACTLY equivalent — including for
  // a multi-word term, which a split-and-compare would have broken.
  //
  // The regex it replaces was already safe: `term` went through an escape, so
  // no caller could inject a quantifier and no catastrophic backtracking was
  // reachable. It was flagged as a ReDoS risk anyway, and the flag is fair as a
  // rule about the SHAPE of the code — a constructed regex is one careless edit
  // away from being unsafe, and the escape that protects it sits ten lines
  // below where anyone editing this line would look. A comparison that cannot
  // backtrack at all needs no such argument.
  if (` ${normalised} `.includes(` ${term} `)) return 'wort'
  if (term.length >= MIN_SUBSTRING_TERM && normalised.includes(term)) return 'teil'
  return null
}

/**
 * Fold a room name into the lexicon's alphabet.
 *
 * NFC first: an exporter may write `ü` as `u` + combining diaeresis, in which
 * case the umlaut rules below would not see a `ü` at all and `Küche` would fold
 * to `kuche` while a differently-encoded sibling folded to `kueche`. Same
 * building, two classifications, depending on the exporter's Unicode habits.
 *
 * The umlaut expansion runs BEFORE the generic diacritic strip, so `ü` becomes
 * `ue` (matching a file that already spells it `Kueche`) rather than `u`.
 */
function normalise(raw: string): string {
  return raw
    .normalize('NFC')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// ── shared helpers ──────────────────────────────────────────────────────────

/** Spaces AND spatial zones — `findBlindSpots` counts both, so this must too. */
function spaceIdsOf(graph: BuildingGraph): string[] {
  return [...(graph.byType.get('IfcSpace') ?? []), ...(graph.byType.get('IfcSpatialZone') ?? [])]
}

/**
 * `LongName` before `Name` for spaces: exporters put the room code in `Name`
 * (`101`) and the label in `LongName` (`Wohnen`), so reading `Name` first hands
 * the lexicon a number.
 */
function roomLabel(node: GraphNode | null): string | null {
  if (!node) return null
  return node.longName ?? node.name ?? null
}

function storeyName(storey: GraphNode): string | null {
  return storey.name ?? storey.longName ?? null
}

/** Storey → derived height, shared by `briefing` and `storeyHeights`. */
function heightsOf(graph: BuildingGraph): Map<string, number> {
  const answer = storeyHeights(graph)
  const map = new Map<string, number>()
  if (!answer.decidable || !answer.value) return map
  // `Answer.from` carries the storeys in the order the values were derived, so
  // the two lists line up by index without re-deriving which storey is which.
  for (const [index, entry] of answer.value.entries()) {
    const globalId = answer.from[index]
    if (globalId && entry.height !== null) map.set(globalId, entry.height)
  }
  return map
}

/**
 * Reshape `graph.dialect` for the briefing.
 *
 * Two changes to the raw list. First, decisive properties are promoted: sorting
 * purely by fill count puts `Pset_*Common.Reference` at the top of every Revit
 * model and buries the one property a fire-rating question needs. Second, the
 * list is capped and the remainder counted, because a dialect can run to
 * hundreds of entries and an uncapped one would eat the whole context budget.
 */
function summariseDialect(graph: BuildingGraph): {
  dialect: BriefingDialectEntry[]
  omitted: number
  absent: Array<{ concept: string; property: string }>
} {
  const conceptOf = new Map<string, string>()
  for (const entry of DECISIVE_PROPERTIES) conceptOf.set(entry.property.toLowerCase(), entry.concept)

  const seen = new Set<string>()
  const entries: BriefingDialectEntry[] = graph.dialect.map((entry) => {
    const key = entry.property.toLowerCase()
    seen.add(key)
    return {
      set: entry.set,
      property: entry.property,
      filled: entry.filled,
      scanned: entry.candidates,
      concept: conceptOf.get(key) ?? null,
      sample: entry.sample,
    }
  })

  // Stable: decisive first, then by fill count, then alphabetically. Two runs
  // over the same file must produce the same briefing.
  const ranked = [...entries].sort(
    (a, b) =>
      Number(b.concept !== null) - Number(a.concept !== null) ||
      b.filled - a.filled ||
      `${a.set}.${a.property}`.localeCompare(`${b.set}.${b.property}`)
  )

  return {
    dialect: ranked.slice(0, MAX_DIALECT),
    omitted: Math.max(0, ranked.length - MAX_DIALECT),
    absent: DECISIVE_PROPERTIES.filter((entry) => !seen.has(entry.property.toLowerCase())).map((entry) => ({
      concept: entry.concept,
      property: entry.property,
    })),
  }
}

/**
 * Render one `n of m` fact.
 *
 * The three branches are the whole point. An empty population, an unresolved
 * population and a partly resolved one are three different findings, and only
 * the third is about the building.
 */
function coverageLine(coverage: Coverage): string {
  if (coverage.of === 0) {
    return `${coverage.what}: dieser Export enthält keine solchen Elemente`
  }
  if (coverage.n === 0) {
    return (
      `${coverage.what}: 0 von ${coverage.of} — dieser Export schreibt kein ${coverage.relation} ` +
      '(Aussage über den Export, nicht über das Gebäude)'
    )
  }
  const percent = Math.round((coverage.n / coverage.of) * 100)
  const rest = coverage.n < coverage.of ? `, ${coverage.of - coverage.n} ohne` : ''
  return `${coverage.what}: ${coverage.n} von ${coverage.of} (${percent} %${rest}, ${coverage.relation})`
}

/**
 * `+2.85` / `±0.00` / `−2.60`, matching the layout in §8.1.
 *
 * `±0.00` rather than `+0.00` because a storey at datum is the reference every
 * other elevation is read against, and the plan convention says so.
 */
function metres(value: number): string {
  if (Math.abs(value) < 0.005) return '±0.00'
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function shorten(value: string | number | boolean): string {
  const text = String(value)
  return text.length > 18 ? `${text.slice(0, 17)}…` : text
}

/** Pack cells into lines of at most `WRAP_WIDTH` characters after the label column. */
const WRAP_WIDTH = 104

function wrap(cells: string[], separator: string, tail: string | null): string[] {
  const lines: string[] = []
  let current = ''
  for (const cell of cells) {
    const candidate = current.length === 0 ? cell : `${current}${separator}${cell}`
    if (candidate.length > WRAP_WIDTH && current.length > 0) {
      lines.push(current)
      current = cell
    } else {
      current = candidate
    }
  }
  if (current.length > 0) lines.push(current)
  if (tail) lines.push(tail)
  return lines
}
