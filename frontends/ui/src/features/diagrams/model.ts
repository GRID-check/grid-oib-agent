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
  /** ISO dates. A milestone has start === end. */
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

/** Mermaid's node shapes, folded into the three this product draws. */
const FLOW_SHAPE: Record<string, FlowNode['shape']> = {
  diamond: 'decision',
  hexagon: 'decision',
  stadium: 'end',
  circle: 'end',
  doublecircle: 'end',
  ellipse: 'end',
}

export function flowFromFlowchart(db: Record<string, unknown>, source: string): FlowModel | null {
  const nodes = entries(call(db, 'getVertices')).map((vertex): FlowNode => {
    const v = record(vertex)
    const id = text(v.id)
    return { id, label: text(v.text) || id, shape: FLOW_SHAPE[text(v.type)] ?? 'step' }
  })
  const edges = entries(call(db, 'getEdges')).map((edge, index): FlowEdge => {
    const e = record(edge)
    const label = text(e.text)
    return {
      id: text(e.id) || `e${index}`,
      from: text(e.start),
      to: text(e.end),
      ...(label ? { label } : {}),
      ...(text(e.stroke) === 'dotted' ? { dashed: true } : {}),
    }
  })
  if (nodes.length === 0) return null
  const header = source.trim().split('\n')[0] ?? ''
  const direction = /\b(LR|RL)\b/.test(header) ? 'right' : 'down'
  return { kind: 'flow', direction, nodes, edges: edges.filter((e) => e.from && e.to) }
}

export function flowFromState(db: Record<string, unknown>): FlowModel | null {
  const relations = entries(call(db, 'getRelations')).map(record)
  if (relations.length === 0) return null
  const ids = new Set<string>()
  const edges = relations.map((relation, index): FlowEdge => {
    const from = text(relation.id1)
    const to = text(relation.id2)
    ids.add(from)
    ids.add(to)
    const label = text(relation.relationTitle)
    return { id: `s${index}`, from, to, ...(label ? { label } : {}) }
  })
  const states = record(call(db, 'getStates'))
  const nodes = [...ids].map((id): FlowNode => {
    const point = /(^|_)(start|end)$/.test(id)
    const descriptions = entries(record(states[id]).descriptions).map(text).filter(Boolean)
    return { id, label: point ? '' : descriptions[0] || id, shape: point ? 'point' : 'step' }
  })
  return { kind: 'flow', direction: 'down', nodes, edges }
}

export function mapFromMindmap(db: Record<string, unknown>): MapModel | null {
  const walk = (node: unknown, path: string): MapNode => {
    const n = record(node)
    const label = text(n.descr) || text(n.nodeId)
    return { id: path, label, children: entries(n.children).map((child, index) => walk(child, `${path}.${index}`)) }
  }
  const root = call(db, 'getMindmap')
  return root ? { kind: 'map', root: walk(root, 'root') } : null
}

export function handoffFromSequence(db: Record<string, unknown>): HandoffModel | null {
  const parties = entries(call(db, 'getActors')).map((actor) => {
    const a = record(actor)
    return { id: text(a.name), label: text(a.description) || text(a.name) }
  })
  const known = new Set(parties.map((party) => party.id))
  // Mermaid's message types: 0/1 solid and dotted with arrowhead (1 is the
  // dotted "reply"), 3/4 open ends. Notes and loop markers carry no `from`.
  const steps = entries(call(db, 'getMessages'))
    .map(record)
    .filter((m) => known.has(text(m.from)) && known.has(text(m.to)))
    .map((m) => ({ from: text(m.from), to: text(m.to), label: text(m.message), reply: m.type === 1 || m.type === 4 }))
  return parties.length > 1 && steps.length > 0 ? { kind: 'handoff', parties, steps } : null
}

export function scheduleFromGantt(db: Record<string, unknown>): ScheduleModel | null {
  const iso = (value: unknown): string | null => {
    const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
    return date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : null
  }
  const sections = new Map<string, ScheduleTask[]>()
  for (const task of entries(call(db, 'getTasks')).map(record)) {
    const start = iso(task.startTime)
    const end = iso(task.endTime) ?? start
    if (!start || !end) continue
    const section = text(task.section) || ''
    const list = sections.get(section) ?? []
    list.push({ label: text(task.task), start, end, milestone: task.milestone === true || start === end })
    sections.set(section, list)
  }
  if (sections.size === 0) return null
  return { kind: 'schedule', sections: [...sections].map(([label, tasks]) => ({ label, tasks })) }
}

export function sharesFromPie(db: Record<string, unknown>): SharesModel | null {
  const sections = call(db, 'getSections')
  const pairs = sections instanceof Map ? [...sections] : Object.entries(record(sections))
  const items = pairs
    .map(([label, value]) => ({ label: String(label), value: Number(value) }))
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
  if (items.length === 0) return null
  const title = text(call(db, 'getDiagramTitle'))
  return { kind: 'shares', ...(title ? { title } : {}), items }
}

/** The model for a parsed diagram, or null when this product has no view for it. */
export function modelFromParsed({ type, db }: Parsed, source: string): DiagramModel | null {
  if (type === 'flowchart-v2' || type === 'flowchart' || type === 'graph') return flowFromFlowchart(db, source)
  if (type === 'stateDiagram' || type === 'state') return flowFromState(db)
  if (type === 'mindmap') return mapFromMindmap(db)
  if (type === 'sequence') return handoffFromSequence(db)
  if (type === 'gantt') return scheduleFromGantt(db)
  if (type === 'pie') return sharesFromPie(db)
  return null
}
