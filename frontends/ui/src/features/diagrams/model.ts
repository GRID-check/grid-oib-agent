/**
 * What a diagram SAYS, independent of how mermaid would draw it.
 *
 * The model writes a ```mermaid fence; mermaid's parser reads it
 * (`parse-mermaid.ts`); the functions here turn the parser's database into one
 * of five typed models, and each model is drawn by a component in this
 * product's design (`docs/design/answer-visuals.md`). Pure: no mermaid import,
 * no DOM — the parser's output arrives as plain data and is read defensively,
 * because it is an internal shape of a dependency, not a public contract.
 */

/** A Verfahren, a decision path, a chain of instruments, the stages of a state. */
export interface FlowModel {
  kind: 'flow'
  direction: 'down' | 'right'
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export interface FlowNode {
  id: string
  label: string
  /** step: a box. decision: a question that forks. end: where a path stops. point: a state diagram's start or end. */
  shape: 'step' | 'decision' | 'end' | 'point'
}

export interface FlowEdge {
  id: string
  from: string
  to: string
  label?: string
  /** A dotted line: a relation that does not carry the flow („erläutert", „verweist"). */
  dashed?: boolean
}

/** A Regelwerk and its parts: a tree, read from the root. */
export interface MapModel {
  kind: 'map'
  root: MapNode
}

export interface MapNode {
  id: string
  label: string
  children: MapNode[]
}

/** Parties handing things to each other, in order. */
export interface HandoffModel {
  kind: 'handoff'
  parties: { id: string; label: string }[]
  steps: { from: string; to: string; label: string; reply: boolean }[]
}

/** Phases on dates a document states. */
export interface ScheduleModel {
  kind: 'schedule'
  sections: { label: string; tasks: ScheduleTask[] }[]
}

export interface ScheduleTask {
  label: string
  /**
   * ISO calendar dates, as the source wrote them. `end` is EXCLUSIVE, as in
   * mermaid: `2026-10-01, 14d` ends on `2026-10-15` and the last day worked is
   * the 14th. A milestone has start === end.
   */
  start: string
  end: string
  milestone: boolean
}

/** Shares of one whole. */
export interface SharesModel {
  kind: 'shares'
  title?: string
  items: { label: string; value: number }[]
}

export type DiagramModel = FlowModel | MapModel | HandoffModel | ScheduleModel | SharesModel

type Parsed = { type: string; db: Record<string, unknown> }

const call = (db: Record<string, unknown>, name: string): unknown => {
  const fn = db[name]
  return typeof fn === 'function' ? (fn as () => unknown).call(db) : undefined
}

const entries = (value: unknown): unknown[] =>
  value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : []

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {})

/** One entry of a keyed collection the parser keeps as a `Map` or a plain object. */
const lookup = (collection: unknown, key: string): unknown =>
  collection instanceof Map ? collection.get(key) : record(collection)[key]

/**
 * Past this many nodes a graph goes to mermaid's SVG instead.
 *
 * Every node graph here runs dagre in the reader's tab, and dagre is not
 * linear: measured at ~200 ms for 100 nodes and ~520 ms for 300, per layout,
 * on the main thread. A diagram that large is also no longer one a reader
 * follows node by node, which is what these views are for.
 */
export const MAX_GRAPH_NODES = 80

/** `<br>`, `<br/>`, `<br />` in any case: mermaid's line break inside a label. */
const LINE_BREAK = /<br\s*\/?>/gi
/** Inline formatting a label may carry; dropped, its text kept. */
const FORMATTING_TAG = /<\/?(?:b|i|em|strong|u|s|small|sub|sup|span)(?:\s[^<>]*)?>/gi
/** The entities a label may still hold after the parser's sanitiser, decoded by name. */
const NAMED_ENTITY: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' }

/**
 * A mermaid label as plain text with line breaks, or null when it carries
 * markup this product cannot draw as text.
 *
 * The parser hands a label over the way its SVG renderer wants it: its own
 * `#quot;` entity syntax swapped for placeholders (`ﬂ°quot¶ß`), `<br>` for a
 * line break, and whatever other HTML the sanitiser kept. Printed raw, that was
 * placeholder junk and visible tags inside a node. Anything left that looks like
 * markup after the known forms are read means the label is not plain text, and
 * the caller falls back to mermaid's own drawing rather than guess.
 */
export function plainLabel(raw: string): string | null {
  const withoutTags = raw.replace(LINE_BREAK, '\n').replace(FORMATTING_TAG, '')
  if (/<[a-z/!]/i.test(withoutTags)) return null
  const entities = withoutTags.replace(/ﬂ°°/g, '&#').replace(/ﬂ°/g, '&').replace(/¶ß/g, ';')
  let unknown = false
  const decoded = entities.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code)
    }
    const known = NAMED_ENTITY[name.toLowerCase()]
    if (known === undefined) unknown = true
    return known ?? whole
  })
  if (unknown) return null
  return decoded
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** Mermaid's node shapes, folded into the three this product draws. */
const FLOW_SHAPE: Record<string, FlowNode['shape']> = {
  diamond: 'decision',
  hexagon: 'decision',
  stadium: 'end',
  circle: 'end',
  doublecircle: 'end',
  ellipse: 'end',
}

export function flowFromFlowchart(db: Record<string, unknown>): FlowModel | null {
  // A subgraph is a group drawn around its nodes; these views have no group,
  // and drawing it as one more step labelled by its id says something else.
  if (entries(call(db, 'getSubGraphs')).length > 0) return null
  const vertices = entries(call(db, 'getVertices')).map(record)
  if (vertices.length === 0 || vertices.length > MAX_GRAPH_NODES) return null
  const nodes: FlowNode[] = []
  for (const v of vertices) {
    const id = text(v.id)
    // A markdown string (`"`**fett**`"`) is formatting this view would print as asterisks.
    const label = v.labelType === 'markdown' ? null : plainLabel(text(v.text))
    if (label === null) return null
    nodes.push({ id, label: label || id, shape: FLOW_SHAPE[text(v.type)] ?? 'step' })
  }
  const edges: FlowEdge[] = []
  for (const [index, edge] of entries(call(db, 'getEdges')).map(record).entries()) {
    // `A ~~~ B` only places B near A; drawn, it would be a relation nobody wrote.
    if (text(edge.stroke) === 'invisible') continue
    // Every edge here is drawn as one arrowhead at `to`. A line without one
    // (`---`, `-.-`), a two-way arrow (`<-->`) or a cross or circle head says
    // something else, and mermaid draws it as written.
    if (text(edge.type) !== 'arrow_point') return null
    const label = edge.labelType === 'markdown' ? null : plainLabel(text(edge.text))
    if (label === null) return null
    edges.push({
      id: text(edge.id) || `e${index}`,
      from: text(edge.start),
      to: text(edge.end),
      ...(label ? { label } : {}),
      ...(text(edge.stroke) === 'dotted' ? { dashed: true } : {}),
    })
  }
  // The parser's direction, not the source's first line: frontmatter, an
  // `%%{init}%%` directive or a comment can come before the header.
  const direction = /^(LR|RL)$/.test(text(call(db, 'getDirection'))) ? 'right' : 'down'
  return { kind: 'flow', direction, nodes, edges: edges.filter((e) => e.from && e.to) }
}

/** The ids mermaid gives a top-level `[*]`: a start where it leads out, an end where it is reached. */
const STATE_POINTS = new Set(['root_start', 'root_end'])

export function flowFromState(db: Record<string, unknown>): FlowModel | null {
  const relations = entries(call(db, 'getRelations')).map(record)
  if (relations.length === 0) return null
  const states = call(db, 'getStates')
  // A composite state holds a diagram of its own (`doc`); flattening it lost
  // every state inside, and a note is text beside a state these views have no
  // place for. Either way the diagram is mermaid's to draw.
  if (entries(states).some((state) => Array.isArray(record(state).doc) || record(state).note !== undefined)) return null
  const ids = new Set<string>()
  const edges: FlowEdge[] = []
  for (const [index, relation] of relations.entries()) {
    const from = text(relation.id1)
    const to = text(relation.id2)
    ids.add(from)
    ids.add(to)
    const label = plainLabel(text(relation.relationTitle))
    if (label === null) return null
    edges.push({ id: `s${index}`, from, to, ...(label ? { label } : {}) })
  }
  // A state declared and never entered or left is still one of the states.
  for (const state of entries(states)) ids.add(text(record(state).id))
  ids.delete('')
  if (ids.size > MAX_GRAPH_NODES) return null
  const nodes: FlowNode[] = []
  for (const id of ids) {
    const node = stateNode(id, record(lookup(states, id)))
    if (!node) return null
    nodes.push(node)
  }
  return { kind: 'flow', direction: 'down', nodes, edges }
}

/** One state as a node, or null when its name is markup this product cannot draw. */
function stateNode(id: string, state: Record<string, unknown>): FlowNode | null {
  // By mermaid's own id for `[*]`, never by the name: a state called
  // „start" or „Prüfung_end" is a state like any other.
  if (STATE_POINTS.has(id)) return { id, label: '', shape: 'point' }
  const type = text(state.type)
  if (type === 'start' || type === 'end') return { id, label: '', shape: 'point' }
  // `state "Lange Bezeichnung" as L` keeps the name in `descriptions`.
  const description = plainLabel(entries(state.descriptions).map(text).find(Boolean) ?? '')
  return description === null ? null : { id, label: description || id, shape: 'step' }
}

/** A mindmap node and its subtree, or null when any label in it is markup this product cannot draw. */
function mapNode(node: unknown, path: string): MapNode | null {
  const n = record(node)
  const label = plainLabel(text(n.descr) || text(n.nodeId))
  if (label === null) return null
  const children: MapNode[] = []
  for (const [index, child] of entries(n.children).entries()) {
    const read = mapNode(child, `${path}.${index}`)
    if (!read) return null
    children.push(read)
  }
  return { id: path, label, children }
}

export function mapFromMindmap(db: Record<string, unknown>): MapModel | null {
  const root = call(db, 'getMindmap')
  if (!root) return null
  const tree = mapNode(root, 'root')
  if (!tree) return null
  const count = (node: MapNode): number => node.children.reduce((sum, child) => sum + count(child), 1)
  return count(tree) > MAX_GRAPH_NODES ? null : { kind: 'map', root: tree }
}

/** Mermaid's LINETYPE for a note: it carries `from` and `to` like a message, and is not one. */
const NOTE_LINE_TYPE = 2

/**
 * Mermaid's LINETYPE (mermaid 11.17, `sequenceDb.ts`) for a ONE-WAY dotted
 * arrow, which is a reply: 1 `-->>`, 4 `--x`, 6 `-->`, 25 `--)`, and the
 * dotted half-arrows 51–58 (`--|\`, `/|--` and kin). The solid ones carry the
 * flow. 34 `<<-->>` is dotted but goes both ways: an exchange, not an answer.
 */
const REPLY_LINE_TYPES = new Set([1, 4, 6, 25, 51, 52, 53, 54, 55, 56, 57, 58])

export function handoffFromSequence(db: Record<string, unknown>): HandoffModel | null {
  const parties: HandoffModel['parties'] = []
  for (const actor of entries(call(db, 'getActors')).map(record)) {
    const label = plainLabel(text(actor.description) || text(actor.name))
    if (label === null) return null
    parties.push({ id: text(actor.name), label: label || text(actor.name) })
  }
  const known = new Set(parties.map((party) => party.id))
  const steps: HandoffModel['steps'] = []
  for (const m of entries(call(db, 'getMessages')).map(record)) {
    // A note (`Note over A,B: Frist 6 Wochen`) sits in the message list with a
    // `from` and a `to`; drawn as a step it was a hand-over nobody made. It is
    // text beside the parties that this view has no place for, so the diagram
    // is mermaid's to draw rather than lose it.
    if (Number(m.type) === NOTE_LINE_TYPE) return null
    // Loop, alt and activation markers carry no `from` or no `to`.
    if (!known.has(text(m.from)) || !known.has(text(m.to))) continue
    const label = plainLabel(text(m.message))
    if (label === null) return null
    steps.push({ from: text(m.from), to: text(m.to), label, reply: REPLY_LINE_TYPES.has(Number(m.type)) })
  }
  return parties.length > 1 && steps.length > 0 ? { kind: 'handoff', parties, steps } : null
}

const asDate = (value: unknown): Date | null => {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date : null
}

const atMidnight = (date: Date): boolean =>
  date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0 && date.getMilliseconds() === 0

/**
 * Mermaid parses `2026-10-01` as LOCAL midnight. `toISOString` reads that back
 * in UTC, which east of Greenwich is the evening before: every date a reader in
 * Vienna saw was a day early. The calendar date is the local one.
 */
const calendarDate = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function scheduleFromGantt(db: Record<string, unknown>): ScheduleModel | null {
  const sections = new Map<string, ScheduleTask[]>()
  for (const task of entries(call(db, 'getTasks')).map(record)) {
    const start = asDate(task.startTime)
    const end = asDate(task.endTime) ?? start
    if (!start || !end) continue
    // This view draws whole days. A task of hours (`4h`, `36h`) or at a time
    // of day read as days was a milestone or a span one day off; mermaid
    // draws it to the hour.
    if (!atMidnight(start) || !atMidnight(end)) return null
    const section = plainLabel(text(task.section))
    const label = plainLabel(text(task.task))
    if (section === null || label === null) return null
    const list = sections.get(section) ?? []
    const milestone = task.milestone === true || end.getTime() <= start.getTime()
    list.push({ label, start: calendarDate(start), end: calendarDate(end), milestone })
    sections.set(section, list)
  }
  if (sections.size === 0) return null
  return { kind: 'schedule', sections: [...sections].map(([label, tasks]) => ({ label, tasks })) }
}

export function sharesFromPie(db: Record<string, unknown>): SharesModel | null {
  const sections = call(db, 'getSections')
  const pairs = sections instanceof Map ? [...sections] : Object.entries(record(sections))
  const items: SharesModel['items'] = []
  for (const [raw, amount] of pairs) {
    const label = plainLabel(String(raw))
    if (label === null) return null
    const value = Number(amount)
    if (Number.isFinite(value) && value > 0) items.push({ label, value })
  }
  if (items.length === 0) return null
  const title = plainLabel(text(call(db, 'getDiagramTitle')))
  if (title === null) return null
  return { kind: 'shares', ...(title ? { title } : {}), items }
}

/** The model for a parsed diagram, or null when this product has no view for it. */
export function modelFromParsed({ type, db }: Parsed): DiagramModel | null {
  if (type === 'flowchart-v2' || type === 'flowchart' || type === 'graph') return flowFromFlowchart(db)
  if (type === 'stateDiagram' || type === 'state') return flowFromState(db)
  if (type === 'mindmap') return mapFromMindmap(db)
  if (type === 'sequence') return handoffFromSequence(db)
  if (type === 'gantt') return scheduleFromGantt(db)
  if (type === 'pie') return sharesFromPie(db)
  return null
}
