/**
 * ReasoningFlow — the Herleitung rendered as a real node graph (@xyflow/react).
 *
 * Framing → the parallel Quellen fan-out → assessment → (live HITL) branches,
 * derived from the SAME streamed props the old ReasoningChain used, so the graph
 * grows as a turn streams in. Each source gets its own handle on the framing/
 * assessment banners, aligned to the card centres, so the connectors run
 * straight and never pile onto one shared point. The canvas is non-interactive
 * (no pan/zoom/drag) and renders at 1:1 — its height comes from the MEASURED
 * node bounds and its nodes are placed from MEASURED heights (no fitView, no
 * hardcoded height guesses), so it sits inline in the chat like any other block.
 *
 * Responsive: a wide-enough container gets the horizontal fan-out; a narrow one
 * (phone) re-lays-out as a single vertical column — SAME nodes, SAME parallel
 * wiring (framing → all sources → converge, never a chain), orientation only.
 */

'use client'

import {
  type FC,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  applyNodeChanges,
  useNodesInitialized,
  useReactFlow,
  type Node,
  type NodeChange,
  type Edge,
  type NodeProps,
} from '@xyflow/react'
import { Sparkles } from 'lucide-react'
import '@xyflow/react/dist/style.css'
import type { Translator } from '@/i18n'
import { useTranslations } from '@/i18n'
import { useLayoutStore } from '@/features/layout/store'
import { TechnicalSteps } from './TechnicalSteps'
import type { ThinkingStep, CitationSource } from '../../types'
import { deriveTraceSourceCards } from '../../lib/trace-lanes'
import type { TraceSourceCard } from '../../lib/trace-lanes'
import { SourceCard } from './SourceCard'
import { BranchOptions } from './BranchOptions'
import { citationChips } from './citations'
import type { ChoicePrompt } from './citations'

/** Hidden connection handle (edges anchor to it; the dot itself is invisible). */
const H = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 'none', background: 'transparent' } as const
/** Spread `n` handles evenly across the banner width (vertical fan-in). */
const spread = (i: number, n: number) => `${((i + 0.5) / n) * 100}%`
const EDGE_STROKE = 'color-mix(in oklch, var(--foreground) 18%, transparent)'

/** One anchor point on a banner edge: a handle id + its x offset within the node. */
type HandleSpec = { id: string; left: string }

const Eyebrow: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{children}</div>
)

// ── node payloads ───────────────────────────────────────────────────────────
type FramingData = {
  label: string
  question: string
  routingLabel?: string
  routing?: string
  escalation?: string
  /** Bottom (source) handles — one per fanned source, or a single centre. */
  sources: HandleSpec[]
}
type SourceData = { card: TraceSourceCard; hitLabel: string; gapLabel: string }
type FindingsData = {
  label: string
  /**
   * Reasoning-specific detail: which lanes actually produced hits for this turn
   * (deduped lane labels). This is NOT the answer's trust verdict — the
   * confidence chip and provenance chips live once, on the answer card.
   */
  hitSummary?: string
  /** Top (target) handles — one per incoming source, or a single centre. */
  targets: HandleSpec[]
  /** Bottom (source) handle — present only when a branches node follows. */
  source?: HandleSpec
}
type BranchesData = { prompt: ChoicePrompt; onRespond: (id: string, choice: string) => void; sub: string; targets: HandleSpec[] }

// ── node components ───────────────────────────────────────────────────────────
const FramingFlowNode: FC<NodeProps<Node<FramingData>>> = ({ data }) => (
  <div className="w-[var(--banner-w)] max-w-full rounded-xl border bg-card px-4 py-3 text-left shadow-xs">
    <Eyebrow>
      <span className="inline-flex items-center gap-1.5">
        <Sparkles className="size-2.5" aria-hidden="true" /> {data.label}
      </span>
    </Eyebrow>
    <p className="mt-1 text-[13px] leading-relaxed text-foreground">{data.question}</p>
    {data.routing && (
      <div className="mt-2 border-t border-base pt-1.5">
        {data.routingLabel && <Eyebrow>{data.routingLabel}</Eyebrow>}
        <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{data.routing}</p>
      </div>
    )}
    {data.escalation && <p className="mt-1.5 text-[12px] leading-relaxed text-warning">{data.escalation}</p>}
    {data.sources.map((h) => (
      <Handle key={h.id} id={h.id} type="source" position={Position.Bottom} style={{ ...H, left: h.left }} />
    ))}
  </div>
)

const SourceFlowNode: FC<NodeProps<Node<SourceData>>> = ({ data }) => (
  <div className="w-[var(--source-w)] max-w-full">
    <Handle id="in" type="target" position={Position.Top} style={{ ...H, left: '50%' }} />
    <SourceCard card={data.card} hitLabel={data.hitLabel} gapLabel={data.gapLabel} />
    <Handle id="out" type="source" position={Position.Bottom} style={{ ...H, left: '50%' }} />
  </div>
)

const FindingsFlowNode: FC<NodeProps<Node<FindingsData>>> = ({ data }) => (
  <div className="w-[var(--banner-w)] max-w-full rounded-xl border bg-card px-4 py-3 text-left shadow-xs">
    {data.targets.map((h) => (
      <Handle key={h.id} id={h.id} type="target" position={Position.Top} style={{ ...H, left: h.left }} />
    ))}
    <Eyebrow>{data.label}</Eyebrow>
    {/* Reasoning-specific detail only — which lanes produced hits. The trust
        verdict (confidence + provenance chips) is NOT restated here; it lives
        once on the answer card, where users act on it. */}
    {data.hitSummary && (
      <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{data.hitSummary}</p>
    )}
    {data.source && <Handle id={data.source.id} type="source" position={Position.Bottom} style={{ ...H, left: data.source.left }} />}
  </div>
)

const BranchesFlowNode: FC<NodeProps<Node<BranchesData>>> = ({ data }) => (
  <div className="w-[var(--banner-w)] max-w-full rounded-xl border border-input bg-card px-4 py-3 text-left shadow-xs">
    {data.targets.map((h) => (
      <Handle key={h.id} id={h.id} type="target" position={Position.Top} style={{ ...H, left: h.left }} />
    ))}
    <div className="text-sm font-semibold text-foreground">{data.prompt.text.trim() || data.sub}</div>
    <div className="mb-3 mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{data.sub}</div>
    <BranchOptions
      options={data.prompt.options}
      selected={data.prompt.selected}
      isResponded={data.prompt.isResponded}
      onSelect={(option) => data.onRespond(data.prompt.promptId, option)}
    />
  </div>
)

const nodeTypes = {
  framing: FramingFlowNode,
  source: SourceFlowNode,
  findings: FindingsFlowNode,
  branches: BranchesFlowNode,
}

export interface ReasoningFlowProps {
  steps: ThinkingStep[]
  userQuestion: string
  answerConfidence?: 'low' | 'medium' | 'high'
  citations?: CitationSource[]
  choicePrompt?: ChoicePrompt
  onChoiceRespond?: (promptId: string, choice: string) => void
  routingDecision?: 'meta' | 'shallow' | 'deep' | 'error'
  routingReason?: string
  escalationReason?: string
}

// Horizontal layout constants (node widths + inter-row gaps).
const SOURCE_W = 158
const SOURCE_GAP = 14
const BANNER_W = 460
const H_GAP_Y = 40 // vertical gap between rows in the horizontal fan-out
const V_GAP = 20 // vertical gap between stacked nodes on mobile
const PAD = 8 // container bottom padding below the last row
/** Below this natural width the horizontal fan won't fit → lay out vertically. */
const FIT_PAD = 24

function edge(source: string, sourceHandle: string, target: string, targetHandle: string): Edge {
  return {
    id: `${source}:${sourceHandle}->${target}:${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
    type: 'smoothstep',
    style: { stroke: EDGE_STROKE, strokeWidth: 1.5 },
  }
}

/** Natural width the horizontal fan-out needs for the given source count. */
export function naturalWidth(sourceCount: number): number {
  const rowW = sourceCount > 0 ? sourceCount * SOURCE_W + (sourceCount - 1) * SOURCE_GAP : BANNER_W
  return Math.max(rowW, BANNER_W)
}

export interface BuiltGraph {
  nodes: Node[]
  edges: Edge[]
  /** Row groups, top→bottom, for the measured y-stacking pass. */
  rows: string[][]
  /** Content width in the node coordinate space (for centring in wide canvases). */
  contentW: number
}

/**
 * Pure graph builder — exported for structural regression tests. Produces the
 * nodes (with per-orientation handle specs), the parallel wiring, and the row
 * groups for the measured layout pass. See ReasoningFlow.spec.
 */
export function buildGraph(props: ReasoningFlowProps, t: Translator, vertical: boolean, cards: TraceSourceCard[]): BuiltGraph {
  const hasSources = cards.length > 0
  const hasFindings = Boolean(props.answerConfidence) || (props.citations?.length ?? 0) > 0
  const hasBranches = Boolean(props.choicePrompt && props.choicePrompt.options.length > 0)

  const rowW = hasSources ? cards.length * SOURCE_W + (cards.length - 1) * SOURCE_GAP : BANNER_W
  const contentW = Math.max(rowW, BANNER_W)
  const bannerX = (contentW - BANNER_W) / 2
  const rowX = (contentW - rowW) / 2
  const sourceIds = cards.map((c) => `src-${c.id}`)
  // x of source i's centre, expressed as an offset from the banner's left edge —
  // so a banner handle placed here sits directly above/below the card centre and
  // the connector drops straight (no S-bend).
  const handlePx = (i: number) => `${rowX + i * (SOURCE_W + SOURCE_GAP) + SOURCE_W / 2 - bannerX}px`

  const routing =
    props.routingDecision && props.routingReason?.trim()
      ? t('thinking.routing.line', {
          decision: t(`thinking.routing.decision.${props.routingDecision}`),
          reason: props.routingReason.trim(),
        })
      : undefined
  const routingLabel = routing ? t('thinking.routing.whyLabel') : undefined

  const convergeId = hasFindings ? 'findings' : hasBranches ? 'branches' : null

  // Framing's bottom handles: per-source (aligned) when fanning horizontally,
  // else a single centre. Only the handles this orientation uses are rendered.
  const framingSources: HandleSpec[] = hasSources
    ? vertical
      ? [{ id: 'c-bottom', left: '50%' }]
      : sourceIds.map((sid, i) => ({ id: `to-${sid}`, left: handlePx(i) }))
    : convergeId
      ? [{ id: 'c-bottom', left: '50%' }]
      : []

  // Converge target's top handles: one per incoming source (so the fan-in never
  // collapses onto a single point) or a single centre when there are no sources.
  const convergeTargets: HandleSpec[] = hasSources
    ? sourceIds.map((sid, i) => ({ id: `from-${sid}`, left: vertical ? spread(i, sourceIds.length) : handlePx(i) }))
    : [{ id: 'c-top', left: '50%' }]

  const framingData: FramingData = {
    label: t('thinking.node.framingTab'),
    question: props.userQuestion.trim()
      ? t('thinking.node.framingQuestion', { question: props.userQuestion.trim() })
      : t('thinking.node.framingTitle'),
    routingLabel,
    routing,
    escalation: props.escalationReason?.trim()
      ? t('thinking.escalationNarration', { reason: props.escalationReason.trim() })
      : undefined,
    sources: framingSources,
  }
  // Which lanes actually produced hits (deduped) — reasoning detail, not the
  // verdict. citationChips already collapses the flat citation list per lane.
  const hitLanes = props.citations ? citationChips(props.citations).map((c) => c.label) : []
  const findingsData: FindingsData | null = hasFindings
    ? {
        label: t('thinking.node.findingsTab'),
        hitSummary:
          hitLanes.length > 0
            ? t('thinking.node.findingsHits', { lanes: hitLanes.join(', ') })
            : undefined,
        targets: convergeTargets,
        source: hasBranches ? { id: 'out', left: '50%' } : undefined,
      }
    : null
  const branchesData: BranchesData | null =
    hasBranches && props.choicePrompt
      ? {
          prompt: props.choicePrompt,
          onRespond: props.onChoiceRespond ?? (() => {}),
          sub: t('thinking.node.branchesSub'),
          // Branches receives the fan-in only when it IS the converge target
          // (no findings); otherwise it takes a single feed from findings.
          targets: hasFindings ? [{ id: 'c-top', left: '50%' }] : convergeTargets,
        }
      : null

  const nodes: Node[] = []
  const edges: Edge[] = []
  const bx = vertical ? 0 : bannerX

  nodes.push({ id: 'framing', type: 'framing', position: { x: bx, y: 0 }, data: framingData as Record<string, unknown> })
  cards.forEach((card, i) => {
    nodes.push({
      id: sourceIds[i],
      type: 'source',
      position: { x: vertical ? 0 : rowX + i * (SOURCE_W + SOURCE_GAP), y: 0 },
      data: { card, hitLabel: t('thinking.hitCount', { count: card.hitCount }), gapLabel: t('thinking.gapHit') } as Record<string, unknown>,
    })
  })
  if (findingsData) {
    nodes.push({ id: 'findings', type: 'findings', position: { x: bx, y: 0 }, data: findingsData as Record<string, unknown> })
  }
  if (branchesData) {
    nodes.push({ id: 'branches', type: 'branches', position: { x: bx, y: 0 }, data: branchesData as Record<string, unknown> })
  }

  // Wiring — identical parallel semantics in both orientations: framing fans out
  // to every source, every source converges on the assessment/branches node.
  if (hasSources) {
    sourceIds.forEach((sid) => edges.push(edge('framing', vertical ? 'c-bottom' : `to-${sid}`, sid, 'in')))
    if (convergeId) sourceIds.forEach((sid) => edges.push(edge(sid, 'out', convergeId, `from-${sid}`)))
  } else if (convergeId) {
    edges.push(edge('framing', 'c-bottom', convergeId, 'c-top'))
  }
  if (findingsData && branchesData) edges.push(edge('findings', 'out', 'branches', 'c-top'))

  // Row groups for the measured stacking pass. Horizontal: the sources share one
  // row; vertical: every node is its own row (a single readable column).
  const rows: string[][] = [['framing']]
  if (hasSources) {
    if (vertical) sourceIds.forEach((sid) => rows.push([sid]))
    else rows.push(sourceIds)
  }
  if (findingsData) rows.push(['findings'])
  if (branchesData) rows.push(['branches'])

  return { nodes, edges, rows, contentW: vertical ? 0 : contentW }
}

const FlowInner: FC<{ built: BuiltGraph; vertical: boolean; width: number }> = ({ built, vertical, width }) => {
  const { nodes, edges, rows, contentW } = built
  const initialized = useNodesInitialized()
  const { getNodes } = useReactFlow()
  const [rfNodes, setRfNodes] = useState<Node[]>(nodes)
  const [height, setHeight] = useState(vertical ? 480 : 360)
  // Track WHICH orientation the current layout was measured for (not just "have
  // we ever laid out"). On an orientation flip the freshly-seeded nodes sit at
  // provisional y=0 until the measure effect re-stacks them; keying the opacity
  // gate on the orientation hides that one provisional frame during a reflow,
  // while same-orientation prop-stream updates keep the graph visible (no flicker).
  const [laidOutFor, setLaidOutFor] = useState<'v' | 'h' | null>(null)
  const orientation = vertical ? 'v' : 'h'

  const onNodesChange = useCallback((changes: NodeChange[]) => setRfNodes((nds) => applyNodeChanges(changes, nds)), [])

  // Re-seed the controlled nodes when the derived graph changes (props stream in
  // or the orientation flips) — positions are provisional until measured.
  useEffect(() => {
    setRfNodes(nodes)
  }, [nodes])

  // Measure → place: once every node reports a measured size, stack the rows by
  // their REAL heights and size the container to the exact bounds. No fitView,
  // no hardcoded height guesses — the graph renders at 1:1 and never overlaps.
  useEffect(() => {
    if (!initialized) return
    const measured = new Map(getNodes().map((n) => [n.id, n.measured?.height ?? 0]))
    const baseX = new Map(nodes.map((n) => [n.id, n.position.x]))
    const originX = vertical ? 0 : Math.max(0, (width - contentW) / 2)
    const gap = vertical ? V_GAP : H_GAP_Y
    const yById = new Map<string, number>()
    let y = 0
    for (const row of rows) {
      let rowH = 0
      for (const id of row) {
        yById.set(id, y)
        rowH = Math.max(rowH, measured.get(id) ?? 0)
      }
      y += rowH + gap
    }
    setRfNodes((nds) =>
      nds.map((n) => ({
        ...n,
        position: { x: (baseX.get(n.id) ?? n.position.x) + originX, y: yById.get(n.id) ?? n.position.y },
      }))
    )
    setHeight(Math.max(120, Math.ceil(y - gap) + PAD))
    setLaidOutFor(vertical ? 'v' : 'h')
    // getNodes is stable; rfNodes intentionally excluded to avoid a re-layout loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, nodes, rows, contentW, vertical, width])

  // In vertical mode every node spans the container; horizontal uses fixed widths.
  const bannerW = vertical ? `${Math.max(200, width - 4)}px` : `${BANNER_W}px`
  const sourceW = vertical ? `${Math.max(200, width - 4)}px` : `${SOURCE_W}px`

  return (
    <div
      style={{
        height,
        opacity: laidOutFor === orientation ? 1 : 0,
        transition: 'opacity 150ms ease-out',
        ['--banner-w' as string]: bannerW,
        ['--source-w' as string]: sourceW,
      }}
      className="w-full"
      data-testid="reasoning-flow"
    >
      <ReactFlow
        nodes={rfNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        minZoom={1}
        maxZoom={1}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        panOnDrag={false}
        panOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
      />
    </div>
  )
}

export const ReasoningFlow: FC<ReasoningFlowProps> = (props) => {
  const t = useTranslations('chat')
  const showTechnicalReasoning = useLayoutStore((s) => s.showTechnicalReasoning)
  const containerRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cards = useMemo(() => deriveTraceSourceCards(props.steps), [props.steps])
  // Go vertical only when the horizontal fan genuinely won't fit — so the graph
  // never overflows a narrow chat column and never floats tiny in a wide one.
  const vertical = width > 0 && width < naturalWidth(cards.length) + FIT_PAD
  const built = useMemo(() => buildGraph(props, t, vertical, cards), [props, t, vertical, cards])

  return (
    <div ref={containerRef} className="flex w-full flex-col gap-3">
      <ReactFlowProvider>
        <FlowInner built={built} vertical={vertical} width={width || 720} />
      </ReactFlowProvider>

      {showTechnicalReasoning && props.steps.length > 0 && (
        <div className="border-t border-base pt-2">
          <TechnicalSteps steps={props.steps} t={t} />
        </div>
      )}
    </div>
  )
}
