/**
 * ReasoningFlow — the Herleitung rendered as a real node graph (@xyflow/react).
 *
 * Framing → the parallel Quellen fan-out → assessment → (live HITL) branches,
 * derived from the SAME streamed props the old ReasoningChain used, so the graph
 * grows as a turn streams in. Each branch gets its own handle on the framing/
 * assessment banners, so the connectors run parallel and never pile onto one
 * shared point. The canvas is non-interactive (no pan/zoom/drag) and auto-sizes
 * its height to the measured node bounds, so it sits inline in the chat like any
 * other block.
 *
 * Responsive: a wide container gets the horizontal fan-out; a narrow one (phone)
 * re-lays-out as a single vertical column so the graph never shrinks to
 * unreadable — same nodes, same data, orientation only.
 */

'use client'

import { type FC, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  useNodesInitialized,
  useReactFlow,
  getNodesBounds,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react'
import { Sparkles } from 'lucide-react'
import '@xyflow/react/dist/style.css'
import type { Translator } from '@/i18n'
import { useTranslations } from '@/i18n'
import { useLayoutStore } from '@/features/layout/store'
import { sourceSignalStyle } from '@/features/layout/components/SourceSignalChip'
import { TechnicalSteps } from './TechnicalSteps'
import type { ThinkingStep, CitationSource } from '../../types'
import { deriveTraceSourceCards } from '../../lib/trace-lanes'
import type { TraceSourceCard } from '../../lib/trace-lanes'
import { SourceCard } from './SourceCard'
import { BranchOptions } from './BranchOptions'
import { ConfidenceChip } from '../ConfidenceChip'
import { AuthorityTag } from '../AuthorityTag'
import { citationChips } from './nodes'
import type { ChoicePrompt } from './nodes'

/** Hidden connection handle (edges anchor to it; the dot itself is invisible). */
const H = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 'none', background: 'transparent' } as const
const handleLeft = (i: number, n: number) => `${((i + 0.5) / n) * 100}%`
const EDGE_STROKE = 'color-mix(in oklch, var(--foreground) 18%, transparent)'

const Eyebrow: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[10.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">{children}</div>
)

// ── node payloads ───────────────────────────────────────────────────────────
type FramingData = { label: string; question: string; routingLabel?: string; routing?: string; escalation?: string; sourceIds: string[] }
type SourceData = { card: TraceSourceCard; hitLabel: string; gapLabel: string }
type FindingsData = {
  confidence?: 'low' | 'medium' | 'high'
  chips: ReturnType<typeof citationChips>
  sourceIds: string[]
  label: string
}
type BranchesData = { prompt: ChoicePrompt; onRespond: (id: string, choice: string) => void; sub: string }

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
    {/* per-branch fan handles (horizontal) + a shared center handle (vertical) */}
    {data.sourceIds.map((id, i) => (
      <Handle key={id} id={`to-${id}`} type="source" position={Position.Bottom} style={{ ...H, left: handleLeft(i, data.sourceIds.length) }} />
    ))}
    <Handle id="c-bottom" type="source" position={Position.Bottom} style={{ ...H, left: '50%' }} />
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
    {data.sourceIds.map((id, i) => (
      <Handle key={id} id={`from-${id}`} type="target" position={Position.Top} style={{ ...H, left: handleLeft(i, data.sourceIds.length) }} />
    ))}
    <Handle id="c-top" type="target" position={Position.Top} style={{ ...H, left: '50%' }} />
    <Eyebrow>{data.label}</Eyebrow>
    <div className="mt-2 flex flex-col gap-2">
      {data.confidence && <ConfidenceChip confidence={data.confidence} />}
      {data.chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex h-6 max-w-full items-center gap-1 truncate rounded-md border px-2.5 text-xs font-medium"
              style={sourceSignalStyle(chip.signal)}
            >
              {chip.authority && <AuthorityTag>{chip.authority}</AuthorityTag>}
              <span className="truncate">{chip.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
    <Handle id="out" type="source" position={Position.Bottom} style={{ ...H, left: '50%' }} />
  </div>
)

const BranchesFlowNode: FC<NodeProps<Node<BranchesData>>> = ({ data }) => (
  <div className="w-[var(--banner-w)] max-w-full rounded-xl border border-input bg-card px-4 py-3 text-left shadow-xs">
    <Handle id="in" type="target" position={Position.Top} style={{ ...H, left: '50%' }} />
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

// Horizontal layout constants.
const SOURCE_W = 158
const SOURCE_GAP = 14
const BANNER_W = 460
const H_ROW_Y = { sources: 210, findings: 400, branches: 610 }
// Vertical layout: estimated node heights + gap for the stacked column.
const V_GAP = 26
const V_EST = { framing: 150, source: 96, findings: 118, branches: 150 }
const VERTICAL_MAX_W = 520

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

function buildGraph(props: ReasoningFlowProps, t: Translator, vertical: boolean) {
  const cards = deriveTraceSourceCards(props.steps)
  const hasSources = cards.length > 0
  const hasFindings = Boolean(props.answerConfidence) || (props.citations?.length ?? 0) > 0
  const hasBranches = Boolean(props.choicePrompt && props.choicePrompt.options.length > 0)

  const rowW = hasSources ? cards.length * SOURCE_W + (cards.length - 1) * SOURCE_GAP : BANNER_W
  const contentW = Math.max(rowW, BANNER_W)
  const bannerX = (contentW - BANNER_W) / 2
  const rowX = (contentW - rowW) / 2
  const sourceIds = cards.map((c) => `src-${c.id}`)

  const routing =
    props.routingDecision && props.routingReason?.trim()
      ? t('thinking.routing.line', {
          decision: t(`thinking.routing.decision.${props.routingDecision}`),
          reason: props.routingReason.trim(),
        })
      : undefined
  const routingLabel = routing ? t('thinking.routing.whyLabel') : undefined

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
    sourceIds: hasSources ? sourceIds : [],
  }
  const findingsData: FindingsData | null = hasFindings
    ? {
        confidence: props.answerConfidence,
        chips: props.citations ? citationChips(props.citations) : [],
        sourceIds: hasSources ? sourceIds : [],
        label: t('thinking.node.findingsTab'),
      }
    : null
  const branchesData: BranchesData | null =
    hasBranches && props.choicePrompt
      ? { prompt: props.choicePrompt, onRespond: props.onChoiceRespond ?? (() => {}), sub: t('thinking.node.branchesSub') }
      : null

  const nodes: Node[] = []
  const edges: Edge[] = []
  const convergeTarget = findingsData ? 'findings' : branchesData ? 'branches' : null

  if (vertical) {
    // Single column: framing → each source → converge → branches, straight chain.
    let y = 0
    const push = (id: string, type: string, data: unknown, est: number) => {
      nodes.push({ id, type, position: { x: 0, y }, data: data as Record<string, unknown> })
      y += est + V_GAP
    }
    push('framing', 'framing', framingData, V_EST.framing)
    let prev = { id: 'framing', handle: 'c-bottom' }
    cards.forEach((card, i) => {
      const id = sourceIds[i]
      push(id, 'source', { card, hitLabel: t('thinking.hitCount', { count: card.hitCount }), gapLabel: t('thinking.gapHit') }, V_EST.source)
      edges.push(edge(prev.id, prev.handle, id, 'in'))
      prev = { id, handle: 'out' }
    })
    if (findingsData) {
      push('findings', 'findings', findingsData, V_EST.findings)
      edges.push(edge(prev.id, prev.handle, 'findings', 'c-top'))
      prev = { id: 'findings', handle: 'out' }
    }
    if (branchesData) {
      push('branches', 'branches', branchesData, V_EST.branches)
      edges.push(edge(prev.id, prev.handle, 'branches', 'in'))
    }
    return { nodes, edges }
  }

  // Horizontal fan-out/fan-in.
  nodes.push({ id: 'framing', type: 'framing', position: { x: bannerX, y: 0 }, data: framingData as Record<string, unknown> })
  cards.forEach((card, i) => {
    nodes.push({
      id: sourceIds[i],
      type: 'source',
      position: { x: rowX + i * (SOURCE_W + SOURCE_GAP), y: H_ROW_Y.sources },
      data: { card, hitLabel: t('thinking.hitCount', { count: card.hitCount }), gapLabel: t('thinking.gapHit') } as Record<string, unknown>,
    })
  })
  if (hasSources && convergeTarget) {
    sourceIds.forEach((sid) => {
      edges.push(edge('framing', `to-${sid}`, sid, 'in'))
      edges.push(edge(sid, 'out', convergeTarget, convergeTarget === 'findings' ? `from-${sid}` : 'in'))
    })
  } else if (hasSources) {
    sourceIds.forEach((sid) => edges.push(edge('framing', `to-${sid}`, sid, 'in')))
  } else if (convergeTarget) {
    edges.push(edge('framing', 'c-bottom', convergeTarget, convergeTarget === 'findings' ? 'c-top' : 'in'))
  }
  if (findingsData) {
    nodes.push({ id: 'findings', type: 'findings', position: { x: bannerX, y: hasSources ? H_ROW_Y.findings : H_ROW_Y.sources }, data: findingsData as Record<string, unknown> })
  }
  if (branchesData) {
    nodes.push({
      id: 'branches',
      type: 'branches',
      position: { x: bannerX, y: findingsData ? H_ROW_Y.branches : hasSources ? H_ROW_Y.findings : H_ROW_Y.sources },
      data: branchesData as Record<string, unknown>,
    })
    if (findingsData) edges.push(edge('findings', 'out', 'branches', 'in'))
  }
  return { nodes, edges }
}

const FlowInner: FC<{ nodes: Node[]; edges: Edge[]; vertical: boolean; width: number }> = ({ nodes, edges, vertical, width }) => {
  const initialized = useNodesInitialized()
  const { fitView } = useReactFlow()
  const [height, setHeight] = useState(vertical ? 420 : 340)

  useEffect(() => {
    if (!initialized) return
    const bounds = getNodesBounds(nodes)
    setHeight(Math.max(120, Math.ceil(bounds.height) + 8))
    const raf = requestAnimationFrame(() => fitView({ padding: 0.04, maxZoom: 1, minZoom: 0.5 }))
    return () => cancelAnimationFrame(raf)
  }, [initialized, nodes, fitView])

  // In vertical mode every node spans the container; horizontal uses fixed widths.
  const bannerW = vertical ? `${Math.max(200, width - 4)}px` : `${BANNER_W}px`
  const sourceW = vertical ? `${Math.max(200, width - 4)}px` : `${SOURCE_W}px`

  return (
    <div
      style={{ height, ['--banner-w' as string]: bannerW, ['--source-w' as string]: sourceW }}
      className="w-full"
      data-testid="reasoning-flow"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.04, maxZoom: 1, minZoom: 0.5 }}
        minZoom={0.5}
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

  const vertical = width > 0 && width < VERTICAL_MAX_W
  const { nodes, edges } = useMemo(() => buildGraph(props, t, vertical), [props, t, vertical])

  return (
    <div ref={containerRef} className="flex w-full flex-col gap-3">
      {/* key forces a fresh mount on orientation flip so React Flow re-fits. */}
      <ReactFlowProvider key={vertical ? 'v' : 'h'}>
        <FlowInner nodes={nodes} edges={edges} vertical={vertical} width={width || 720} />
      </ReactFlowProvider>

      {showTechnicalReasoning && props.steps.length > 0 && (
        <div className="border-t border-base pt-2">
          <TechnicalSteps steps={props.steps} t={t} />
        </div>
      )}
    </div>
  )
}
