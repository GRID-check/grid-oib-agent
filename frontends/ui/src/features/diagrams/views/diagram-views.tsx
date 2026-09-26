'use client'

/**
 * The five diagram views — one per reader's job (`docs/design/answer-visuals.md`).
 *
 * Two are node graphs on `@xyflow/react` (`GraphCanvas`): a flow, and a map
 * where the column is wide enough to hold one. The other three are HTML,
 * because their structure is a grid, not a graph: parties in columns, dates on
 * an axis, shares on a scale. None of them is an SVG someone else designed.
 */

import { type ReactNode, type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import dagre from '@dagrejs/dagre'
import { ArrowLeft, ArrowRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import type {
  DiagramModel,
  FlowModel,
  HandoffModel,
  MapModel,
  MapNode as MapTreeNode,
  ScheduleModel,
  ScheduleTask,
  SharesModel,
} from '../model'
import { GraphCanvas, type GraphEdgeSpec, type GraphNodeSpec, type GraphSpec } from './graph-canvas'
import { FLOW_NODE_TYPES, MAP_NODE_TYPES } from './graph-nodes'

// ── flow ─────────────────────────────────────────────────────────────────────

const NODE_GAP = 28

/**
 * A dagre pass is the expensive part of a flow (~200 ms at 100 nodes), and a
 * model is immutable once parsed, so what one pass says about it is kept with
 * it: a resize, a parent re-render or a remount reads it back instead of
 * laying the graph out again.
 */
const PASSES = new WeakMap<FlowModel, Map<string, unknown>>()

function once<T>(model: FlowModel, key: string, compute: () => T): T {
  const passes = PASSES.get(model) ?? new Map<string, unknown>()
  PASSES.set(model, passes)
  if (!passes.has(key)) passes.set(key, compute())
  return passes.get(key) as T
}

/** The most nodes any rank holds, from a layout with nominal sizes. */
function widestRank(model: FlowModel, rankdir: 'TB' | 'LR'): number {
  return once(model, `widest:${rankdir}`, () => countWidestRank(model, rankdir))
}

function countWidestRank(model: FlowModel, rankdir: 'TB' | 'LR'): number {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const node of model.nodes) graph.setNode(node.id, { width: 100, height: 40 })
  for (const edge of model.edges) graph.setEdge(edge.from, edge.to)
  dagre.layout(graph)
  const perRank = new Map<number, number>()
  for (const id of graph.nodes()) {
    const at = Math.round(rankdir === 'TB' ? graph.node(id).y : graph.node(id).x)
    perRank.set(at, (perRank.get(at) ?? 0) + 1)
  }
  return Math.max(1, ...perRank.values())
}

function FlowGraph({ model, label }: { model: FlowModel; label: string }) {
  // A left-to-right flow only while it fits; a phone reads top to bottom.
  const build = useCallback(
    (width: number): GraphSpec => {
      const direction = model.direction === 'right' && width >= 560 ? 'LR' : 'TB'
      const breadth = widestRank(model, direction)
      const across = direction === 'TB' ? breadth : Math.max(2, model.nodes.length / breadth)
      // Never narrower than the longest word needs: a German compound broken
      // mid-word („Verbesserungsauftra-g") reads as a typo. Past 190px the
      // layout scrolls instead, and hyphenation takes what is left.
      const longestWord = Math.max(...model.nodes.flatMap((node) => node.label.split(/\s+/).map((word) => word.length)))
      const floor = Math.min(190, Math.max(132, longestWord * 7.4 + 26))
      const nodeWidth = Math.round(Math.min(230, Math.max(floor, (width - 16 - (across - 1) * NODE_GAP) / across)))
      const nodes: GraphNodeSpec[] = model.nodes.map((node) => ({
        id: node.id,
        type: node.shape,
        data: { label: node.label },
        width: node.shape === 'point' ? 12 : nodeWidth,
      }))
      const edges: GraphEdgeSpec[] = model.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        ...(edge.label ? { label: edge.label } : {}),
        ...(edge.dashed ? { dashed: true } : {}),
      }))
      return { nodes, edges, direction }
    },
    [model]
  )
  return (
    <GraphCanvas build={build} label={label} nodeTypes={FLOW_NODE_TYPES} nodesep={NODE_GAP} ranksep={40} />
  )
}

/**
 * A flow on a phone: the steps in order, each decision with its branches
 * written out. Two readable nodes side by side do not fit in ~280px, and a
 * graph that hides its second branch behind a scroll is worse than a list that
 * says where each branch goes.
 */
function FlowOutline({ model }: { model: FlowModel }) {
  const order = flowOrder(model)
  const byId = new Map(model.nodes.map((node) => [node.id, node]))
  const position = new Map(order.map((id, i) => [id, i]))
  return (
    <ol className="flex flex-col gap-1.5">
      {order.map((id, i) => {
        const node = byId.get(id)
        if (!node || node.shape === 'point') return null
        const outgoing = model.edges.filter((edge) => edge.from === id && byId.get(edge.to)?.shape !== 'point')
        // The plain case: one unlabelled step straight to the next one in order.
        const straight =
          outgoing.length === 1 && !outgoing[0].label && !outgoing[0].dashed && position.get(outgoing[0].to) === i + 1
        return (
          <li key={id} className="flex flex-col gap-1">
            <div
              className={cn(
                'text-foreground rounded-lg border px-3 py-2 text-[13px] leading-snug whitespace-pre-line text-pretty hyphens-auto shadow-xs',
                node.shape === 'decision'
                  ? 'bg-warning-subtle border-[color-mix(in_oklch,var(--border-color-feedback-warning)_45%,transparent)] font-medium'
                  : node.shape === 'end'
                    ? 'bg-muted border-border rounded-full font-medium'
                    : 'bg-card border-border'
              )}
            >
              {node.label}
            </div>
            {straight ? (
              <span aria-hidden="true" className="text-muted-foreground pl-4 text-xs leading-none">
                ↓
              </span>
            ) : outgoing.length > 0 ? (
              <ul className="flex flex-col gap-0.5 pl-3">
                {outgoing.map((edge) => (
                  <li key={edge.id} className="text-muted-foreground flex items-baseline gap-1.5 text-[12.5px] leading-snug">
                    <ArrowRight aria-hidden="true" className="size-3 shrink-0 translate-y-0.5" />
                    <span className="min-w-0">
                      {edge.label ? <span className="text-foreground font-medium">{edge.label}: </span> : null}
                      <span className={cn(edge.dashed && 'italic')}>{byId.get(edge.to)?.label || edge.to}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/** The nodes in reading order: by dagre's rank, then left to right. */
function flowOrder(model: FlowModel): string[] {
  return once(model, 'order', () => readingOrder(model))
}

function readingOrder(model: FlowModel): string[] {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: 'TB' })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const node of model.nodes) graph.setNode(node.id, { width: 100, height: 40 })
  for (const edge of model.edges) graph.setEdge(edge.from, edge.to)
  dagre.layout(graph)
  return [...graph.nodes()].sort((a, b) => graph.node(a).y - graph.node(b).y || graph.node(a).x - graph.node(b).x)
}

/** Where a flow is drawn as a graph rather than listed: two readable nodes side by side. */
const FLOW_GRAPH_MIN_REM = 28

/** Below this a map is an outline: root, parts and leaves need three columns. */
const MAP_TREE_MIN_REM = 34

/**
 * The width of the element `ref` is put on, in rem; null until it is measured.
 * Measured before the first paint, so the form chosen from it is the first one
 * seen, and neither form is built for a render nobody sees.
 */
function useWidthRem(): [RefObject<HTMLDivElement | null>, number | null] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      setWidth(element.clientWidth / rem)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/**
 * A graph where the column holds one, the outline where it does not — and only
 * the one that is shown. Both used to mount with a container query hiding one,
 * so every flow paid for the outline's dagre pass on a desktop and for the
 * graph's on a phone.
 */
export function FlowDiagram({ model, label }: { model: FlowModel; label: string }) {
  const [ref, width] = useWidthRem()
  return (
    <div ref={ref}>
      {width === null ? null : width >= FLOW_GRAPH_MIN_REM ? (
        <FlowGraph model={model} label={label} />
      ) : (
        <FlowOutline model={model} />
      )}
    </div>
  )
}

// ── map ──────────────────────────────────────────────────────────────────────

const flatten = (node: MapTreeNode, level: number, into: { node: MapTreeNode; level: number }[]) => {
  into.push({ node, level })
  for (const child of node.children) flatten(child, level + 1, into)
  return into
}

/** A map as an indented outline: the root, its parts as groups, what each covers beneath. */
function MapOutline({ model }: { model: MapModel }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-foreground text-sm font-semibold">{model.root.label}</p>
      <ul className="border-border flex flex-col gap-2.5 border-l pl-3">
        {model.root.children.map((part) => (
          <li key={part.id} className="flex flex-col gap-1">
            <span className="text-foreground text-[13px] font-medium">{part.label}</span>
            {part.children.length > 0 ? (
              <ul className="text-muted-foreground flex flex-col gap-0.5 pl-3 text-[12.5px]">
                {flatten(part, 0, [])
                  .slice(1)
                  .map(({ node, level }) => (
                    <li key={node.id} style={{ paddingLeft: (level - 1) * 12 }} className="before:mr-1.5 before:content-['–']">
                      {node.label}
                    </li>
                  ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function MapDiagram({ model, label }: { model: MapModel; label: string }) {
  // Memoised on the model: a new array per render made `build` new per render,
  // and the canvas rebuilt, re-measured and laid out the whole tree again on
  // every re-render of the answer around it — every streamed token.
  const nodes = useMemo(() => flatten(model.root, 0, []), [model])
  const build = useCallback(
    (width: number): GraphSpec => ({
      direction: 'LR',
      nodes: nodes.map(({ node, level }) => ({
        id: node.id,
        type: 'map',
        data: { label: node.label, level },
        width: level === 0 ? Math.min(180, width * 0.26) : level === 1 ? Math.min(200, width * 0.3) : Math.min(220, width * 0.32),
      })),
      // Children are handed to dagre last-first: in a left-to-right layout it
      // stacks siblings from the bottom, and the parts must read top-down in
      // the order the answer wrote them.
      edges: nodes.flatMap(({ node }) =>
        [...node.children].reverse().map((child) => ({ id: `${node.id}->${child.id}`, source: node.id, target: child.id }))
      ),
    }),
    [nodes]
  )
  // A tree needs three columns of room; below that it is an outline. Only the
  // one that is shown mounts: both used to, with a container query hiding one,
  // so every map on a phone still paid for the tree's dagre pass and canvas.
  const [ref, width] = useWidthRem()
  return (
    <div ref={ref}>
      {width === null ? null : width >= MAP_TREE_MIN_REM ? (
        <GraphCanvas build={build} label={label} nodeTypes={MAP_NODE_TYPES} nodesep={10} ranksep={36} arrows={false} />
      ) : (
        <MapOutline model={model} />
      )}
    </div>
  )
}

// ── handoff ──────────────────────────────────────────────────────────────────

export function HandoffDiagram({ model }: { model: HandoffModel }) {
  const index = new Map(model.parties.map((party, i) => [party.id, i]))
  const name = (id: string) => model.parties[index.get(id) ?? 0]?.label ?? id
  const columns = model.parties.length
  return (
    <div className="@container">
      {/* Wide: one column per party, the arrow drawn between them. */}
      <div className="hidden @[30rem]:block">
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {model.parties.map((party) => (
            <div
              key={party.id}
              className="border-border bg-card text-foreground rounded-lg border px-2 py-1.5 text-center text-[13px] font-medium shadow-xs"
            >
              {party.label}
            </div>
          ))}
        </div>
        <ol className="relative mt-1 flex flex-col">
          {/* The lifelines, one per party. */}
          {model.parties.map((party, i) => (
            <span
              key={party.id}
              aria-hidden="true"
              className="bg-border absolute top-0 bottom-0 w-px"
              style={{ left: `${((i + 0.5) / columns) * 100}%` }}
            />
          ))}
          {model.steps.map((step, i) => {
            const from = index.get(step.from) ?? 0
            const to = index.get(step.to) ?? 0
            const left = (Math.min(from, to) + 0.5) / columns
            const span = Math.max(Math.abs(to - from), 0.001) / columns
            const rightward = to >= from
            return (
              <li key={i} className="relative pt-2 pb-1">
                {/* The label sizes the row: a hand-over that wraps to two
                    lines pushes its arrow down rather than into it. */}
                <div
                  className="text-foreground px-1 text-center text-[12.5px] leading-snug text-pretty"
                  style={{ marginLeft: `${left * 100}%`, width: `${Math.max(span, 1 / columns) * 100}%` }}
                >
                  <span className="text-muted-foreground mr-1 tabular-nums">{i + 1}</span>
                  {step.label}
                </div>
                <div className="relative mt-1 h-3">
                  <span
                    aria-hidden="true"
                    className={cn('absolute top-1/2 border-t', step.reply ? 'border-muted-foreground border-dashed' : 'border-foreground/50')}
                    style={{ left: `${left * 100}%`, width: `${span * 100}%` }}
                  />
                  {(() => {
                    const Arrow = rightward ? ArrowRight : ArrowLeft
                    return (
                      <Arrow
                        aria-hidden="true"
                        className={cn(
                          'absolute top-1/2 size-3.5 -translate-y-1/2',
                          step.reply ? 'text-muted-foreground' : 'text-foreground/70'
                        )}
                        style={rightward ? { left: `calc(${(left + span) * 100}% - 12px)` } : { left: `calc(${left * 100}% - 2px)` }}
                      />
                    )
                  })()}
                </div>
              </li>
            )
          })}
        </ol>
      </div>
      {/* Narrow: the same hand-overs as a numbered list. */}
      <ol className="flex flex-col gap-1.5 @[30rem]:hidden">
        {model.steps.map((step, i) => (
          <li key={i} className="flex items-baseline gap-2 text-[13px] leading-snug">
            <span className="text-muted-foreground w-4 shrink-0 text-right tabular-nums">{i + 1}</span>
            <span className="min-w-0">
              <span className="text-foreground font-medium">{name(step.from)}</span>
              <span className="text-muted-foreground"> → </span>
              <span className="text-foreground font-medium">{name(step.to)}</span>
              <span className="text-muted-foreground">: </span>
              <span className={cn(step.reply && 'text-muted-foreground')}>{step.label}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

// ── schedule ─────────────────────────────────────────────────────────────────

const DAY = 86_400_000
const dayOf = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
const dateLabel = (iso: string) =>
  new Intl.DateTimeFormat('de-AT', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(dayOf(iso)))
/**
 * The last day a task covers, for its label. Mermaid's end is exclusive —
 * `2026-10-01, 14d` ends on the 15th — which is right for the bar's length and
 * one day too many in words: the reader reads „bis 15.10." as including it.
 */
const lastDay = (task: ScheduleTask) =>
  new Date(Math.max(dayOf(task.start), dayOf(task.end) - DAY)).toISOString().slice(0, 10)

/**
 * Up to five dates along the axis, whole days and each one once. Spread by
 * fractions of the span, a schedule of fewer than four days put the same date
 * under several ticks („25.10." four times, and four React keys alike).
 */
function scheduleTicks(start: number, end: number): { iso: string; at: number }[] {
  const days = Math.round((end - start) / DAY)
  const steps = Math.min(4, days)
  return Array.from({ length: steps + 1 }, (_, i) => {
    const day = Math.round((days * i) / steps)
    return { iso: new Date(start + day * DAY).toISOString().slice(0, 10), at: (day / days) * 100 }
  })
}

export function ScheduleDiagram({ model }: { model: ScheduleModel }) {
  const tasks = model.sections.flatMap((section) => section.tasks)
  const start = Math.min(...tasks.map((task) => dayOf(task.start)))
  const end = Math.max(...tasks.map((task) => dayOf(task.end)), start + DAY)
  const at = (iso: string) => ((dayOf(iso) - start) / (end - start)) * 100
  const ticks = scheduleTicks(start, end)
  return (
    <div className="@container flex flex-col gap-1">
      <div className="grid grid-cols-1 gap-x-3 @[30rem]:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
        <span className="hidden @[30rem]:block" />
        <div className="text-muted-foreground relative h-5 text-[11px] tabular-nums">
          {ticks.map((tick, i) => (
            <span
              key={tick.iso}
              data-testid="schedule-tick"
              className={cn('absolute top-0', i === 0 ? '' : i === ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2')}
              style={{ left: `${tick.at}%` }}
            >
              {dateLabel(tick.iso)}
            </span>
          ))}
        </div>
      </div>
      {model.sections.map((section) => (
        <div key={section.label} className="flex flex-col gap-1">
          {section.label ? (
            <p className="text-muted-foreground border-border border-t pt-1.5 text-[11px] font-semibold tracking-wide uppercase">
              {section.label}
            </p>
          ) : null}
          {section.tasks.map((task, index) => (
            <div
              // Two tasks may share a name and a start; the list never reorders.
              key={index}
              className="grid grid-cols-1 items-center gap-x-3 gap-y-0.5 @[30rem]:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]"
            >
              <span className="flex min-w-0 items-baseline justify-between gap-2 @[30rem]:flex-col @[30rem]:items-start @[30rem]:gap-0">
                <span className="text-foreground text-[13px] leading-snug text-pretty">{task.label}</span>
                <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                  {task.milestone ? dateLabel(task.start) : `${dateLabel(task.start)}–${dateLabel(lastDay(task))}`}
                </span>
              </span>
              <div className="bg-muted/60 relative h-5 rounded">
                {task.milestone ? (
                  <span
                    aria-hidden="true"
                    className="bg-foreground absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45"
                    style={{ left: `${at(task.start)}%` }}
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="bg-foreground/25 border-foreground/40 absolute top-1 bottom-1 rounded-sm border"
                    style={{ left: `${at(task.start)}%`, width: `max(3px, ${at(task.end) - at(task.start)}%)` }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ── shares ───────────────────────────────────────────────────────────────────

const percent = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 1 })

export function SharesDiagram({ model }: { model: SharesModel }) {
  const total = model.items.reduce((sum, item) => sum + item.value, 0)
  const largest = Math.max(...model.items.map((item) => item.value))
  return (
    <div className="flex flex-col gap-2">
      {model.title ? <p className="text-foreground text-sm font-medium">{model.title}</p> : null}
      <ul className="flex flex-col gap-1.5">
        {model.items.map((item) => (
          <li key={item.label} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3.5rem] items-center gap-3">
            <span className="text-foreground truncate text-[13px]" title={item.label}>
              {item.label}
            </span>
            <span className="bg-muted/60 h-2.5 overflow-hidden rounded-full">
              <span className="bg-foreground/45 block h-full rounded-full" style={{ width: `${(item.value / largest) * 100}%` }} />
            </span>
            <span className="text-foreground text-right text-[13px] tabular-nums">{percent.format((item.value / total) * 100)} %</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export function DiagramView({ model, label }: { model: DiagramModel; label: string }): ReactNode {
  switch (model.kind) {
    case 'flow':
      return <FlowDiagram model={model} label={label} />
    case 'map':
      return <MapDiagram model={model} label={label} />
    case 'handoff':
      return <HandoffDiagram model={model} />
    case 'schedule':
      return <ScheduleDiagram model={model} />
    case 'shares':
      return <SharesDiagram model={model} />
  }
}
