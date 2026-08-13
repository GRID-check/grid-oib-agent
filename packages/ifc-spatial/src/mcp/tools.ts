/**
 * The tool surface, defined without a transport.
 *
 * ## Why this file has no MCP import
 *
 * MCP is how these tools are *delivered*, not what they *are*. Keeping the
 * definitions transport-free means the same handlers serve an MCP server, an
 * HTTP route inside a host application, or a direct in-process call from a
 * test, and none of those three has to reimplement the argument checking. It
 * also keeps the SDK out of the dependency path of anyone who wants the library
 * and not the server.
 *
 * ## Why one `relations` tool rather than eleven
 *
 * Every topological operator has the same signature — a model, an element, a
 * list back — so eleven tools would be eleven copies of one schema, and a model
 * choosing between them is choosing a name, not a shape. The reference
 * architecture for agentic BIM tooling reports the same thing from the other
 * direction: coarse, domain-shaped tools beat fine-grained access. What must
 * NOT be coarse is the meaning, so the enum documents each relation
 * individually and the answer says which one ran.
 *
 * The operators whose *shape* differs — a briefing, a table of storey heights,
 * a room inventory — get their own tools, because folding them into the same
 * enum would produce a return type that is a union of four things and a model
 * that guesses which one it got.
 */

import { readFile } from 'node:fs/promises'
import type { SpatialCache, SpatialModel } from '../model.js'
import type { Answer } from '../envelope.js'
import type { BuildingGraph } from '../graph/types.js'
import { node as findNode } from '../graph/types.js'
import {
  UnknownElementError,
  adjacentSpaces,
  bounds,
  connects,
  contains,
  containerOf,
  elementsOfStorey,
  enclosedBy,
  fillerOf,
  hostedIn,
  hosts,
  opensTo,
} from '../operators/topology.js'
import { toRef, toRefs, type ElementRef } from '../operators/refs.js'
import { inventory, renderBriefing, storeyHeights } from '../operators/model.js'
import { azimuth, clearHeight, distance, elevation, extent, floorArea, sillAndHead } from '../operators/metric.js'
import type { GeometryIndex } from '../geometry/pass.js'
import { project, type ViewKind } from '../render/project.js'
import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** JSON-Schema-shaped input description. Deliberately plain objects. */
export interface ToolDef {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

/** The relation names `relations` accepts, and what each one answers. */
const RELATIONS = {
  hostedIn: 'Welche Wand trägt dieses Fenster / diese Tür? (aus voids+fills abgeleitet)',
  hosts: 'Welche Öffnungen sind aus diesem Bauteil ausgeschnitten?',
  fillerOf: 'Was füllt diese Öffnung?',
  bounds: 'Welche Bauteile begrenzen diesen Raum?',
  enclosedBy: 'Welche Räume begrenzt dieses Bauteil?',
  opensTo: 'In welche Räume öffnet dieses Fenster / diese Tür?',
  connects: 'Welche Bauteile schließen an dieses an?',
  contains: 'Welche Bauteile liegen in diesem Geschoß oder Raum?',
  containerOf: 'In welchem Geschoß oder Raum liegt dieses Bauteil?',
  adjacentSpaces: 'Welche Räume grenzen an diesen Raum?',
  elementsOfStorey: 'Alle Bauteile dieses Geschoßes (auch die in Räumen).',
} as const

type RelationName = keyof typeof RELATIONS

const RELATION_FN: Record<RelationName, (graph: BuildingGraph, id: string) => Answer<ElementRef[]> | Answer<ElementRef | null>> = {
  hostedIn,
  hosts,
  fillerOf,
  bounds,
  enclosedBy,
  opensTo,
  connects,
  contains,
  containerOf,
  adjacentSpaces,
  elementsOfStorey,
}

/** The measurements `measure` exposes, and what each one answers. */
const MEASURES = {
  extent: 'Abmessungen und Schwerpunkt: Breite, Tiefe, Höhe, Mittelpunkt.',
  floorArea: 'Bodenfläche aus der Geometrie — auch wenn das Modell keine Raumfläche deklariert.',
  sillAndHead: 'Brüstungs- und Sturzhöhe eines Fensters oder einer Tür über SEINEM Geschoß.',
  elevation: 'Unter- und Oberkante, absolut und über dem eigenen Geschoß.',
  clearHeight: 'Höhe des Raumkörpers (nicht die lichte Höhe unter Unterzügen).',
  azimuth: 'Himmelsrichtung der Fassadenebene. Ohne TrueNorth in der Datei nicht entscheidbar.',
} as const

type MeasureName = keyof typeof MEASURES

export function createTools(cache: SpatialCache): ToolDef[] {
  /**
   * Models are addressed by the sha256 of their bytes, abbreviated the way a
   * git object is. A handle that IS the content means two uploads of the same
   * file are one model without anybody comparing filenames, and it means a
   * stale handle cannot silently resolve to a different building.
   *
   * ## Why this table is bounded, and bounded to the cache's own number
   *
   * These are strong references, and they are a SECOND set: evicting a model
   * from `cache` does not release it while this map still names it. Unbounded,
   * the map therefore quietly cancels the cache's lid — a `SpatialModel` holds
   * its `GeometryIndex`, whose retained triangles run to
   * `GeometryOptions.maxRetainedTriangles`, 2 000 000 by default and roughly
   * 150 MB of float64 apiece. A server that opens twenty large models over a
   * day would hold all twenty, and the cache's `maxEntries` would be a comment.
   *
   * So the bound is `cache.maxEntries` rather than a number chosen here. A
   * separate constant would be a second opinion about the same models, and the
   * bigger of the two opinions is the one that actually decides memory.
   */
  const maxOpen = cache.maxEntries
  const models = new Map<string, SpatialModel>()

  /**
   * Insertion order IS the LRU order — `Map` iterates oldest-first — so a hit
   * re-inserts to move the key to the end. Without that touch the eviction is
   * insertion-ordered rather than use-ordered, and the model an agent has been
   * asking about for twenty turns is the first one dropped.
   */
  function retain(model: SpatialModel): void {
    models.delete(model.contentHash)
    models.set(model.contentHash, model)
    while (models.size > maxOpen) {
      const oldest = models.keys().next().value
      if (oldest === undefined || oldest === model.contentHash) break
      models.delete(oldest)
    }
  }

  function resolve(raw: unknown): BuildingGraph {
    return resolveModel(raw).graph
  }

  /**
   * The geometry, or a German reason there is none.
   *
   * Every measurement routes through here so that "this container could not run
   * the geometry kernel" and "this element has no shape in the file" stay
   * different sentences. Collapsing them would tell an architect their building
   * is missing something when the truth is that our machine is.
   */
  function requireGeometry(raw: unknown): { model: SpatialModel; geometry: GeometryIndex } {
    const model = resolveModel(raw)
    if (!model.geometry) {
      throw new Error(
        `Für dieses Modell liegt keine Geometrie vor: ${model.geometryUnavailable ?? 'unbekannter Grund'}. ` +
          'Topologische Fragen (relations) sind unverändert beantwortbar.'
      )
    }
    return { model, geometry: model.geometry }
  }

  function resolveModel(raw: unknown): SpatialModel {
    const id = String(raw ?? '').trim().toLowerCase()
    if (!id) throw new Error('model fehlt — zuerst open_model aufrufen')
    const exact = models.get(id)
    if (exact) {
      retain(exact)
      return exact
    }
    if (id.length >= 8) {
      const matches = [...models.keys()].filter((hash) => hash.startsWith(id))
      if (matches.length === 1) {
        const model = models.get(matches[0]!)!
        retain(model)
        return model
      }
      if (matches.length > 1) throw new Error(`model "${id}" ist mehrdeutig (${matches.length} Treffer) — mehr Stellen angeben`)
    }
    // Says "erneut öffnen" and not merely "öffnen", because past `maxOpen` this
    // is also what an EVICTED handle hits. An agent told only "not open" about a
    // model it demonstrably opened ten turns ago concludes it hallucinated the
    // handle; told to re-open, it does, and the open is a cache hit if the model
    // is still resident.
    throw new Error(
      `model "${id}" ist nicht geöffnet — mit open_model (erneut) öffnen. ` +
        `Es bleiben höchstens ${maxOpen} Modelle gleichzeitig offen. ` +
        `Offen: ${[...models.keys()].map(short).join(', ') || 'keines'}`
    )
  }

  /**
   * An operator that throws {@link UnknownElementError} means the caller could
   * not look, which is a different thing from having looked and found nothing —
   * so it becomes a tool error, while every "the file cannot say" stays a
   * successful result carrying `decidable: false`. Collapsing the two would let
   * a typo in a GlobalId read as a finding about the building.
   */
  async function run<T>(fn: () => T): Promise<T> {
    try {
      return fn()
    } catch (error) {
      if (error instanceof UnknownElementError) {
        throw new Error(`${error.message} — GlobalId mit find_elements prüfen`)
      }
      throw error
    }
  }

  return [
    {
      name: 'open_model',
      title: 'IFC-Modell öffnen',
      description:
        'Liest eine IFC-Datei ein und gibt eine model-Kennung plus das Gebäude-Briefing zurück. ' +
        'IMMER zuerst aufrufen. Das Briefing nennt die Geschoßnamen, das Property-Vokabular dieser ' +
        'Datei und — wichtig — was diese Datei NICHT beantworten kann. Dieselbe Datei zweimal zu ' +
        'öffnen ist gratis: das Ergebnis ist über den Inhalt adressiert und wird zwischengespeichert.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Lokaler Dateipfad zur .ifc-Datei' },
          url: { type: 'string', description: 'HTTP(S)-URL, z. B. eine presigned URL' },
          base64: { type: 'string', description: 'Dateiinhalt base64-kodiert (nur für kleine Modelle sinnvoll)' },
        },
      },
      handler: async (args) => {
        const bytes = await readSource(args)
        const model = await cache.load(bytes)
        retain(model)
        return {
          model: short(model.contentHash),
          contentHash: model.contentHash,
          briefing: renderBriefing(model.graph),
          stats: model.graph.stats,
          geometry: model.geometry
            ? {
                elementsWithGeometry: model.geometry.stats.elementsWithGeometry,
                triangles: model.geometry.stats.triangles,
                ms: model.geometry.stats.ms,
                truncated: model.geometry.stats.trianglesTruncated,
              }
            : { unavailable: model.geometryUnavailable },
        }
      },
    },

    {
      name: 'briefing',
      title: 'Gebäude-Briefing',
      description:
        'Das Briefing eines bereits geöffneten Modells noch einmal: Geschoße mit Höhen, Zählungen, ' +
        'das Property-Vokabular dieser Datei und die blinden Flecken. Aufrufen, bevor auf einen ' +
        'Property- oder Geschoßnamen gefiltert wird — ein Name, den dieser Export nie geschrieben ' +
        'hat, liefert null Treffer und liest sich wie „das Gebäude hat keine".',
      inputSchema: {
        type: 'object',
        properties: { model: { type: 'string' } },
        required: ['model'],
      },
      handler: async (args) => ({ briefing: renderBriefing(resolve(args.model)) }),
    },

    {
      name: 'find_elements',
      title: 'Bauteile suchen',
      description:
        'Findet Bauteile nach IFC-Typ, Namensbestandteil, Geschoß oder Art und gibt ihre GlobalIds ' +
        'zurück — die Eingabe für jedes andere Werkzeug hier. Geschoßnamen wörtlich aus dem Briefing ' +
        'übernehmen.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          ifcType: { type: 'string', description: 'z. B. IfcWall, IfcWindow, IfcSpace' },
          nameContains: { type: 'string' },
          storey: { type: 'string', description: 'Geschoßname, wörtlich aus dem Briefing' },
          kind: { type: 'string', enum: ['project', 'site', 'building', 'storey', 'space', 'element', 'opening', 'group'] },
          limit: { type: 'number', default: 50 },
        },
        required: ['model'],
      },
      handler: async (args) => {
        const graph = resolve(args.model)
        const limit = clamp(Number(args.limit ?? 50), 1, 500)
        const wantedType = lower(args.ifcType)
        const wantedName = lower(args.nameContains)
        const wantedStorey = lower(args.storey)
        const wantedKind = lower(args.kind)

        const matches: string[] = []
        let total = 0
        for (const [globalId, n] of graph.nodes) {
          if (wantedType && n.ifcType.toLowerCase() !== wantedType) continue
          if (wantedKind && n.kind !== wantedKind) continue
          if (wantedStorey && (n.storeyName ?? '').toLowerCase() !== wantedStorey) continue
          if (wantedName && !`${n.name ?? ''} ${n.longName ?? ''}`.toLowerCase().includes(wantedName)) continue
          total++
          if (matches.length < limit) matches.push(globalId)
        }

        return {
          elements: toRefs(graph, matches),
          total,
          // Stated rather than implied: a page presented as a total is the
          // failure this whole library is built to avoid.
          truncated: total > matches.length,
          ...(total === 0
            ? {
                hint:
                  'Keine Treffer. Vor der Schlussfolgerung „gibt es nicht" das Briefing prüfen: ' +
                  'Geschoßnamen und Typen stammen aus diesem Export.',
              }
            : {}),
        }
      },
    },

    {
      name: 'element',
      title: 'Ein Bauteil',
      description: 'Alles über EIN Bauteil: Typ, Name, Geschoß, Container — und welche Relationen es überhaupt hat.',
      inputSchema: {
        type: 'object',
        properties: { model: { type: 'string' }, globalId: { type: 'string' } },
        required: ['model', 'globalId'],
      },
      handler: async (args) => {
        const graph = resolve(args.model)
        const globalId = String(args.globalId)
        const n = findNode(graph, globalId)
        if (!n) throw new Error(`Bauteil ${globalId} ist in diesem Modell nicht enthalten — GlobalId mit find_elements prüfen`)
        return {
          element: toRef(graph, globalId),
          storey: n.storeyName,
          elevation: n.elevation,
          predefinedType: n.predefinedType,
          container: (await run(() => containerOf(graph, globalId))).value,
          // Which questions are worth asking about THIS element, so the agent
          // does not probe eleven relations to find the two that exist.
          available: Object.keys(RELATIONS).filter((relation) => {
            const answer = RELATION_FN[relation as RelationName](graph, globalId)
            return answer.decidable && (Array.isArray(answer.value) ? answer.value.length > 0 : answer.value !== null)
          }),
        }
      },
    },

    {
      name: 'relations',
      title: 'Räumliche Beziehungen',
      description:
        'Die topologischen Operatoren. Jede Antwort sagt, WOHER sie kommt: `declared` steht so in ' +
        'der Datei, `computed` haben wir aus anderen Relationen abgeleitet. Ein leeres Ergebnis ' +
        'heißt „dieses Bauteil hat keine solche Beziehung"; `decidable: false` heißt „dieser Export ' +
        'schreibt diese Relation gar nicht" — das ist ein Befund über den Export, nicht über das ' +
        'Gebäude, und `missing` sagt, was ihn behebt.\n\n' +
        Object.entries(RELATIONS)
          .map(([name, meaning]) => `  ${name} — ${meaning}`)
          .join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          globalId: { type: 'string' },
          relation: { type: 'string', enum: Object.keys(RELATIONS) },
        },
        required: ['model', 'globalId', 'relation'],
      },
      handler: async (args) => {
        const graph = resolve(args.model)
        const relation = String(args.relation) as RelationName
        const fn = RELATION_FN[relation]
        if (!fn) throw new Error(`relation "${relation}" gibt es nicht. Erlaubt: ${Object.keys(RELATIONS).join(', ')}`)
        return run(() => fn(graph, String(args.globalId)))
      },
    },

    {
      name: 'measure',
      title: 'Maße aus der Geometrie',
      description:
        'Misst ein Bauteil am Modell. Diese Zahlen stammen aus der GEOMETRIE, nicht aus deklarierten ' +
        'Eigenschaften — sie sind also auch dann verfügbar, wenn der Export keine Mengen schreibt, und ' +
        'sie tragen immer eine Toleranz. Genau deshalb sind Raumflächen und Brüstungshöhen hier ' +
        'beantwortbar, wo eine reine Property-Abfrage leer zurückkommt.\n\n' +
        Object.entries(MEASURES)
          .map(([name, meaning]) => `  ${name} — ${meaning}`)
          .join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          globalId: { type: 'string' },
          measure: { type: 'string', enum: Object.keys(MEASURES) },
        },
        required: ['model', 'globalId', 'measure'],
      },
      handler: async (args) => {
        const { model, geometry } = requireGeometry(args.model)
        const globalId = String(args.globalId)
        const name = String(args.measure) as MeasureName
        return run(() => {
          switch (name) {
            case 'extent':
              return extent(model.graph, geometry, globalId)
            case 'floorArea':
              return floorArea(model.graph, geometry, globalId)
            case 'sillAndHead':
              return sillAndHead(model.graph, geometry, globalId)
            case 'elevation':
              return elevation(model.graph, geometry, globalId)
            case 'clearHeight':
              return clearHeight(model.graph, geometry, globalId)
            case 'azimuth':
              return azimuth(model.graph, geometry, globalId)
            default:
              throw new Error(`measure "${name}" gibt es nicht. Erlaubt: ${Object.keys(MEASURES).join(', ')}`)
          }
        })
      },
    },

    {
      name: 'distance',
      title: 'Abstand zwischen zwei Bauteilen',
      description:
        'Abstand zwischen zwei Bauteilen. mode: min (kürzester Abstand der Hüllkörper — 0, wenn sie ' +
        'sich überschneiden), centroid, horizontal, vertical. Ein Reviewer, der eine lichte Breite ' +
        'prüft, will horizontal; wer eine Höhe prüft, vertical. Der schräge Abstand beantwortet keines ' +
        'von beiden.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          a: { type: 'string' },
          b: { type: 'string' },
          mode: { type: 'string', enum: ['min', 'centroid', 'horizontal', 'vertical'], default: 'min' },
        },
        required: ['model', 'a', 'b'],
      },
      handler: async (args) => {
        const { model, geometry } = requireGeometry(args.model)
        return run(() =>
          distance(
            model.graph,
            geometry,
            String(args.a),
            String(args.b),
            (args.mode as 'min' | 'centroid' | 'horizontal' | 'vertical') ?? 'min'
          )
        )
      },
    },

    {
      name: 'draw',
      title: 'Das Gebäude zeichnen',
      description:
        'Zeichnet einen Grundriss, Schnitt oder eine Ansicht als SVG — aus GENAU denselben Dreiecken, ' +
        'aus denen auch gemessen wird. Frei einsetzbar, wann immer Hinsehen hilft: um zu verstehen, wie ' +
        'etwas angeordnet ist, um zu klären, welches Bauteil gemeint ist, um eine Antwort zu belegen, ' +
        'oder um zu prüfen, ob eine Zahl überhaupt plausibel sein kann.\n\n' +
        'EINE Regel: Zahlen kommen nie aus dem Bild. Maße liefern measure/distance; das Bild zeigt die ' +
        'Anordnung. Ein aus einer Zeichnung abgelesener Wert ist geraten, auch wenn er stimmt.\n\n' +
        "view: 'plan' (Grundriss von oben), 'section' (Schnitt — zeigt Profile, Überstände, " +
        "Anschlüsse), 'elevation' (Ansicht auf eine Fassade). include grenzt auf bestimmte Bauteile " +
        'ein, context zeichnet die Umgebung blass dazu, highlight hebt hervor. Ohne include wird ' +
        'alles gezeichnet, was Geometrie hat — bei großen Modellen lieber eingrenzen.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          view: { type: 'string', enum: ['plan', 'section', 'elevation'] },
          include: { type: 'array', items: { type: 'string' }, description: 'GlobalIds' },
          context: { type: 'array', items: { type: 'string' } },
          highlight: { type: 'array', items: { type: 'string' } },
          planeOffset: { type: 'number', description: 'Lage der Schnitt-/Blickebene in Metern' },
          planeNormal: { type: 'array', items: { type: 'number' }, description: '[x,y,z]; [0,0,1] schneidet waagrecht' },
          widthPx: { type: 'number' },
        },
        required: ['model', 'view'],
      },
      handler: async (args) => {
        const { model, geometry } = requireGeometry(args.model)
        const answer = project(model.graph, geometry, {
          view: String(args.view) as ViewKind,
          ...(Array.isArray(args.include) ? { include: args.include as string[] } : {}),
          ...(Array.isArray(args.context) ? { context: args.context as string[] } : {}),
          ...(Array.isArray(args.highlight) ? { highlight: args.highlight as string[] } : {}),
          ...(Array.isArray(args.planeNormal) ? { planeNormal: args.planeNormal as [number, number, number] } : {}),
          ...(typeof args.planeOffset === 'number' ? { planeOffset: args.planeOffset } : {}),
          ...(typeof args.widthPx === 'number' ? { widthPx: args.widthPx } : {}),
        })
        if (!answer.decidable || !answer.value) return answer

        // The SVG goes to a file rather than into the reply. A whole-building
        // plan is a few hundred kilobytes of path data — putting that in an
        // agent's context would evict the conversation to deliver something the
        // agent cannot read anyway. The host shows the file; the agent gets the
        // facts about the drawing.
        const dir = await mkdtemp(join(tmpdir(), 'ifc-spatial-'))
        const file = join(dir, `${args.view}-${short(model.contentHash)}.svg`)
        await writeFile(file, answer.value.svg, 'utf8')

        const { svg, ...rest } = answer.value
        return {
          ...answer,
          value: { ...rest, path: file, bytes: Buffer.byteLength(svg, 'utf8') },
          note:
            'Die Zeichnung liegt als Datei vor und kann dem Nutzer gezeigt werden. ' +
            'Maße nicht aus dem Bild ablesen — dafür measure/distance verwenden.',
        }
      },
    },

    {
      name: 'storey_heights',
      title: 'Geschoßhöhen',
      description:
        'Geschoßhöhen als Differenz der Geschoß-Elevationen. Das ist die STRUKTURELLE Höhe von ' +
        'Rohdecke zu Rohdecke, nicht die lichte Raumhöhe — die Antwort sagt das selbst und der ' +
        'Hinweis gehört in jede Aussage darüber.',
      inputSchema: { type: 'object', properties: { model: { type: 'string' } }, required: ['model'] },
      handler: async (args) => storeyHeights(resolve(args.model)),
    },

    {
      name: 'room_inventory',
      title: 'Räume nach vermuteter Nutzung',
      description:
        'Ordnet Räume nach Namen einer vermuteten Nutzung zu (Aufenthaltsraum, Nebenraum, ' +
        'Erschließung). Das Ergebnis ist ausdrücklich `inferred`: ob ein Raum ein Aufenthaltsraum ' +
        'ist, ist eine rechtliche Einstufung und keine geometrische. Als Vorschlag zur Bestätigung ' +
        'behandeln, nie als Feststellung.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string' },
          kind: { type: 'string', enum: ['aufenthaltsraum', 'nebenraum', 'erschliessung'] },
        },
        required: ['model', 'kind'],
      },
      handler: async (args) => inventory(resolve(args.model), args.kind as 'aufenthaltsraum' | 'nebenraum' | 'erschliessung'),
    },
  ]
}

/**
 * How long a model download may take, in ms.
 *
 * 120 s, the same figure as `_DOWNLOAD_TIMEOUT_SECONDS` in the Python client —
 * a presigned URL for a 200 MB export is a slow read, not a hung one. What this
 * replaces is not a longer timeout but NO timeout: `fetch` without a signal
 * waits on an unreachable host until the socket layer gives up, and a tool call
 * that never returns is indistinguishable to an agent from one that failed.
 */
const FETCH_TIMEOUT_MS = 120_000

/**
 * The largest model accepted from a URL, in bytes.
 *
 * 512 MB is the Python client's `_MAX_MODEL_BYTES_CAP`. That client derives its
 * actual limit from the container's memory, because a parse costs roughly 20x
 * the file (`PARSE_FOOTPRINT_RATIO`) and a fixed ceiling guarantees the OOM it
 * was meant to prevent. There is no equivalent derivation here — this package
 * is a reference implementation with no deployment to size against — so it
 * takes the cap and refuses above it, which is at least a stated refusal rather
 * than an allocation that fails somewhere else.
 */
const MAX_MODEL_BYTES = 512 * 1024 * 1024

/** How many redirects a download may follow before it is refused. */
const MAX_REDIRECTS = 5

/**
 * The URL an agent asked us to fetch, or a refusal saying which rule it broke.
 *
 * `args.url` is written by a model, so this is a server-side request whose
 * destination is chosen by untrusted input. Two rules, both narrow on purpose:
 *
 *  - **http and https only.** The same refusal `_download` makes in the Python
 *    client. Node's `fetch` already rejects `file:`, but `data:` would let a
 *    model smuggle bytes past the `base64` argument's own handling, and a
 *    future runtime adding a scheme should not silently widen this.
 *  - **no literal internal address.** A tool that fetches `169.254.169.254`
 *    on an agent's say-so is a cloud-credential read; loopback reaches whatever
 *    else this process is running.
 *
 * ## What this does NOT stop, and must be read as
 *
 * The check is on the literal in the URL. A hostname that RESOLVES to an
 * internal address passes it, because Node's `fetch` offers no hook to pin the
 * address it dials, and re-resolving here would only add a DNS-rebinding window
 * between our lookup and its. Nothing below is a substitute for running this
 * server where it cannot reach anything worth reaching — a deployment that
 * needs internal hosts should pass an explicit allowlist rather than delete the
 * check, and one that does not should be on an egress-restricted network.
 */
export function assertFetchable(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`url ist keine gültige URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`url-Schema "${url.protocol}" ist nicht erlaubt — nur http und https`)
  }
  // Strip the brackets an IPv6 authority carries; `hostname` keeps them.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isInternalHost(host)) {
    throw new Error(`url zeigt auf eine interne Adresse (${host}) — nicht erlaubt`)
  }
  return url
}

/**
 * The IPv4 address inside an IPv4-mapped IPv6 host, or `null`.
 *
 * `::ffff:127.0.0.1` is 127.0.0.1 wearing a hat, and a check that reads only
 * the dotted form misses it — because `new URL()` does not preserve that form.
 * WHATWG parsing normalises the authority to hex, so by the time `hostname` is
 * read the literal is `::ffff:7f00:1` and a `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/`
 * never matches. Both spellings are decoded here for that reason.
 */
function mappedIPv4(host: string): string | null {
  const rest = /^::ffff:(.+)$/.exec(host)?.[1]
  if (rest === undefined) return null
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest
  const groups = rest.split(':')
  if (groups.length > 2 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null
  const high = groups.length === 2 ? Number.parseInt(groups[0]!, 16) : 0
  const low = Number.parseInt(groups[groups.length - 1]!, 16)
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
}

function isInternalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  // Resolves to the metadata service on GCE regardless of what DNS says today.
  if (host === 'metadata' || host === 'metadata.google.internal') return true
  const candidate = mappedIPv4(host) ?? host
  if (
    /^127\./.test(candidate) || // loopback
    /^10\./.test(candidate) || // RFC 1918
    /^192\.168\./.test(candidate) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(candidate) ||
    /^169\.254\./.test(candidate) || // link-local; the cloud metadata address lives here
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(candidate) || // RFC 6598 CGNAT
    /^0\./.test(candidate)
  ) {
    return true
  }
  return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
}

async function readSource(args: Record<string, unknown>): Promise<Uint8Array> {
  if (typeof args.path === 'string' && args.path) {
    // TRUSTED LOCAL CALLERS ONLY. There is no root to resolve against and no
    // traversal check, because the intended caller is an MCP server on the same
    // machine as the file and a host that pointed this at its own filesystem
    // would be the one choosing the path. A host mounting these handlers on an
    // HTTP route — which the file header contemplates — must drop this source
    // or resolve `path` against a directory it owns; an agent-supplied `path`
    // over HTTP reads any file this process can read.
    return new Uint8Array(await readFile(args.path))
  }
  if (typeof args.url === 'string' && args.url) {
    return await fetchModel(args.url)
  }
  if (typeof args.base64 === 'string' && args.base64) {
    return new Uint8Array(Buffer.from(args.base64, 'base64'))
  }
  throw new Error('Eine Quelle angeben: path, url oder base64')
}

async function fetchModel(raw: string): Promise<Uint8Array> {
  // Redirects are followed by hand rather than by `fetch`, because the
  // allowlist has to apply to every hop. `redirect: 'follow'` would check only
  // the URL the agent wrote and then go wherever that host pointed, which is
  // the whole trick: a public URL answering `302 → http://169.254.169.254/`
  // defeats a check made once at the start. Refusing redirects outright would
  // also work and would break the presigned URLs that legitimately use them, so
  // each hop is re-validated instead.
  let url = assertFetchable(raw)
  for (let hop = 0; ; hop++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) throw new Error(`Modell konnte nicht geladen werden: HTTP ${response.status} ohne Location`)
      if (hop >= MAX_REDIRECTS) throw new Error(`Modell konnte nicht geladen werden: mehr als ${MAX_REDIRECTS} Weiterleitungen`)
      // Resolved against the current URL, so a relative Location works and
      // cannot escape the scheme check below.
      url = assertFetchable(new URL(location, url).href)
      continue
    }
    if (!response.ok) throw new Error(`Modell konnte nicht geladen werden: HTTP ${response.status}`)

    // Refused on the declared length first, before a byte is transferred — the
    // same order as the Python client's HEAD-then-GET.
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > MAX_MODEL_BYTES) {
      throw new Error(`Modell ist zu groß (${declared} Bytes, erlaubt ${MAX_MODEL_BYTES})`)
    }
    const buffer = await response.arrayBuffer()
    // Checked again after the read: a store that sent no Content-Length, or
    // lied about it, is otherwise unbounded.
    if (buffer.byteLength > MAX_MODEL_BYTES) {
      throw new Error(`Modell ist zu groß (${buffer.byteLength} Bytes, erlaubt ${MAX_MODEL_BYTES})`)
    }
    return new Uint8Array(buffer)
  }
}

function short(hash: string): string {
  return hash.slice(0, 12)
}

function lower(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min
}
