'use client'

/**
 * A read-only node graph, laid out by dagre, drawn by @xyflow/react.
 *
 * The same canvas conventions as the Herleitung (`ReasoningFlow`): HTML nodes
 * in the card style, 1:1, no pan, no zoom, nothing focusable but real buttons,
 * and a height taken from MEASURED nodes rather than guessed. Two passes: the
 * nodes mount invisible, React Flow measures them, dagre lays them out with
 * those sizes, and only then does the canvas fade in at its final height.
 *
 * Edges follow dagre's own route (`data.points`), not a straight or
 * smooth-step path between handles: dagre routes around the nodes it placed,
 * so a return loop ("Verbesserung → Einreichung") does not cut through the
 * step it skips. Labels sit where dagre reserved room for them.
 *
 * A layout wider than the column scrolls sideways inside `HorizontalScroll`
 * rather than shrinking: labels stay at reading size.
 */

import {
  type FC,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesInitialized,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from '@dagrejs/dagre'

import { HorizontalScroll } from '@/components/ui/horizontal-scroll'

/** Same ink as the Herleitung's edges: foreground at 18%, on any surface. */
export const EDGE_STROKE = 'color-mix(in oklch, var(--foreground) 30%, transparent)'

export interface GraphNodeSpec {
  id: string
  type: string
  data: Record<string, unknown>
  width: number
}

export interface GraphEdgeSpec {
  id: string
  source: string
  target: string
  label?: string
  dashed?: boolean
}

export interface GraphSpec {
  nodes: GraphNodeSpec[]
  edges: GraphEdgeSpec[]
  /** Chosen by the builder for the width it was given; top to bottom by default. */
  direction?: 'TB' | 'LR'
}

export interface GraphCanvasProps extends GraphSpec {
  direction: 'TB' | 'LR'
  nodeTypes: NodeTypes
  label: string
  nodesep?: number
  ranksep?: number
  /** The column's width; the layout centres in it and scrolls past it. */
  width: number
  /** Arrowheads: a flow has a direction, a tree does not. */
  arrows?: boolean
}

const PAD = 8

/** Room dagre reserves for an edge label, before the label is measured. */
const labelBox = (label: string) => ({ width: Math.min(160, label.length * 6.4 + 14), height: 20 })

type Point = { x: number; y: number }

/** A smooth path through dagre's points: straight ends, quadratic joints. */
function routedPath(points: Point[]): string {
  if (points.length < 2) return ''
  let path = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 }
    path += ` Q ${points[i].x} ${points[i].y} ${mid.x} ${mid.y}`
  }
  const last = points[points.length - 1]
  return `${path} L ${last.x} ${last.y}`
}

type RoutedEdgeData = { points: Point[]; label?: string; labelAt?: Point; dashed?: boolean }

const RoutedEdge: FC<EdgeProps<Edge<RoutedEdgeData>>> = ({ id, data, markerEnd }) => {
  if (!data?.points?.length) return null
  return (
    <>
      <BaseEdge
        id={id}
        path={routedPath(data.points)}
        markerEnd={markerEnd}
        style={{ stroke: EDGE_STROKE, strokeWidth: 1.25, strokeDasharray: data.dashed ? '4 4' : undefined }}
      />
      {data.label && data.labelAt ? (
        <EdgeLabelRenderer>
          <div
            className="border-border bg-card text-muted-foreground nodrag nopan pointer-events-none absolute rounded-md border px-1.5 py-0.5 text-[11px] leading-snug whitespace-nowrap"
            style={{ transform: `translate(-50%, -50%) translate(${data.labelAt.x}px, ${data.labelAt.y}px)` }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

const edgeTypes = { routed: RoutedEdge }

interface Layout {
  positions: Map<string, Point>
  edges: Map<string, RoutedEdgeData>
  width: number
  height: number
}

function layoutGraph(
  nodes: GraphNodeSpec[],
  edges: GraphEdgeSpec[],
  sizes: Map<string, { width: number; height: number }>,
  { direction, nodesep, ranksep }: { direction: 'TB' | 'LR'; nodesep: number; ranksep: number }
): Layout {
  const graph = new dagre.graphlib.Graph({ multigraph: true })
  graph.setGraph({ rankdir: direction, nodesep, ranksep, edgesep: 12, marginx: PAD, marginy: PAD })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const node of nodes) {
    const size = sizes.get(node.id) ?? { width: node.width, height: 40 }
    graph.setNode(node.id, { width: size.width, height: size.height })
  }
  for (const edge of edges) {
    graph.setEdge(edge.source, edge.target, edge.label ? { ...labelBox(edge.label), labelpos: 'c' } : {}, edge.id)
  }
  dagre.layout(graph)

  const positions = new Map<string, Point>()
  for (const node of nodes) {
    const placed = graph.node(node.id)
    const size = sizes.get(node.id) ?? { width: node.width, height: 40 }
    positions.set(node.id, { x: placed.x - size.width / 2, y: placed.y - size.height / 2 })
  }
  const routed = new Map<string, RoutedEdgeData>()
  for (const edge of edges) {
    const placed = graph.edge({ v: edge.source, w: edge.target, name: edge.id }) as
      | { points?: Point[]; x?: number; y?: number }
      | undefined
    routed.set(edge.id, {
      points: placed?.points ?? [],
      ...(edge.label ? { label: edge.label, labelAt: { x: placed?.x ?? 0, y: placed?.y ?? 0 } } : {}),
      ...(edge.dashed ? { dashed: true } : {}),
    })
  }
  const { width = 0, height = 0 } = graph.graph() as { width?: number; height?: number }
  return { positions, edges: routed, width, height }
}

function Canvas({
  nodes,
  edges,
  direction,
  nodeTypes,
  label,
  nodesep = 28,
  ranksep = 44,
  width,
  arrows = true,
}: GraphCanvasProps) {
  const initial = useMemo<Node[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: node.type,
        data: { ...node.data, direction },
        position: { x: 0, y: 0 },
        style: { width: node.width },
      })),
    [nodes, direction]
  )
  const [rfNodes, setRfNodes] = useState<Node[]>(initial)
  const [layout, setLayout] = useState<Layout | null>(null)
  const initialized = useNodesInitialized()
  const onNodesChange = useCallback((changes: NodeChange[]) => setRfNodes((prev) => applyNodeChanges(changes, prev)), [])

  const laidOutFor = useRef('')
  // A new graph starts measuring again.
  const last = useRef(initial)
  if (last.current !== initial) {
    last.current = initial
    laidOutFor.current = ''
    // Keep the previous layout on screen while the new one is measured: a
    // resize rebuilds the graph for the new width, and blanking it here made
    // every diagram blink out and fade back in on each resize.
    setRfNodes((prev) => {
      const at = new Map(prev.map((node) => [node.id, node.position]))
      return initial.map((node) => ({ ...node, position: at.get(node.id) ?? node.position }))
    })
  }

  useLayoutEffect(() => {
    if (!initialized) return
    const sizes = new Map<string, { width: number; height: number }>()
    for (const node of rfNodes) {
      if (!node.measured?.width || !node.measured?.height) return
      sizes.set(node.id, { width: node.measured.width, height: node.measured.height })
    }
    // Once per set of measured sizes: `rfNodes` also changes when the layout
    // below is applied, and that must not lay out again.
    const key = `${width}|${[...sizes].map(([id, size]) => `${id}:${size.width}x${size.height}`).join(',')}`
    if (laidOutFor.current === key) return
    laidOutFor.current = key
    const next = layoutGraph(nodes, edges, sizes, { direction, nodesep, ranksep })
    const offset = Math.max(0, (width - next.width) / 2)
    setLayout({
      ...next,
      positions: new Map([...next.positions].map(([id, p]) => [id, { x: p.x + offset, y: p.y }])),
      edges: new Map(
        [...next.edges].map(([id, e]) => [
          id,
          {
            ...e,
            points: e.points.map((p) => ({ x: p.x + offset, y: p.y })),
            ...(e.labelAt ? { labelAt: { x: e.labelAt.x + offset, y: e.labelAt.y } } : {}),
          },
        ])
      ),
    })
  }, [initialized, rfNodes, width, nodes, edges, direction, nodesep, ranksep])

  const shown = useMemo<Node[]>(
    () => (layout ? rfNodes.map((node) => ({ ...node, position: layout.positions.get(node.id) ?? node.position })) : rfNodes),
    [rfNodes, layout]
  )
  const rfEdges = useMemo<Edge[]>(
    () =>
      layout
        ? edges.map((edge) => ({
            id: edge.id,
            source: edge.source,
            target: edge.target,
            type: 'routed',
            data: layout.edges.get(edge.id),
            ...(arrows ? { markerEnd: { type: 'arrowclosed' as const, color: EDGE_STROKE, width: 16, height: 16 } } : {}),
          }))
        : [],
    [edges, layout, arrows]
  )

  const canvasWidth = Math.max(width, layout ? Math.ceil(layout.width) : width)
  const height = layout ? Math.ceil(layout.height) : 160
  return (
    <HorizontalScroll className="w-full" aria-label={label}>
      <div
        role="img"
        aria-label={label}
        className="reasoning-flow-scrollable"
        style={{ width: canvasWidth, height, opacity: layout ? 1 : 0, transition: 'opacity 150ms ease-out' }}
      >
        <ReactFlow
          nodes={shown}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          minZoom={1}
          maxZoom={1}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          disableKeyboardA11y
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          panOnDrag={false}
          panOnScroll={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        />
      </div>
    </HorizontalScroll>
  )
}

function BuiltCanvas({
  build,
  width,
  ...props
}: Omit<GraphCanvasProps, 'nodes' | 'edges' | 'direction'> & { build: (width: number) => GraphSpec }) {
  const graph = useMemo(() => build(width), [build, width])
  return (
    <Canvas {...props} nodes={graph.nodes} edges={graph.edges} direction={graph.direction ?? 'TB'} width={width} />
  )
}

/**
 * Measures its column and draws the graph in it. `build` makes the graph for a
 * column width, so a node can be as wide as the column allows (memoise it).
 */
export function GraphCanvas({
  build,
  ...props
}: Omit<GraphCanvasProps, 'width' | 'nodes' | 'edges' | 'direction'> & { build: (width: number) => GraphSpec }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setWidth(element.clientWidth)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={ref} className="w-full">
      {width > 0 ? (
        <ReactFlowProvider>
          <BuiltCanvas {...props} build={build} width={width} />
        </ReactFlowProvider>
      ) : null}
    </div>
  )
}
