/**
 * ReasoningFlow — the Herleitung rendered as a real node graph (@xyflow/react).
 *
 * Framing → the parallel Quellen fan-out → assessment → (live HITL) branches,
 * derived from the SAME streamed props the old ReasoningChain used, so the graph
 * grows as a turn streams in. The canvas is non-interactive (no pan/zoom/drag)
 * and renders at 1:1 — its height comes from MEASURED node heights (no fitView,
 * no hardcoded guesses), so it sits inline in the chat like any other block.
 *
 * ## Layout: columns, not an orientation flip
 *
 * The sources always fan out into COLUMNS across the full container width. How
 * many columns is purely a function of the width: as many as fit at
 * `MIN_COL_W`, capped at one column per card. Cards that don't fit in the row
 * stack INSIDE a column rather than pushing the graph into a single vertical
 * chain — so a desktop turn with eight sources still reads as a parallel
 * fan-out (4 columns × 2), and only a genuinely phone-width container collapses
 * to the one-column grouped "Quellen" container.
 *
 * The banners span the full content width, so every handle sits INSIDE its node
 * (the old fixed 460px banner left the outer columns' edges dangling in empty
 * space beside it).
 *
 * ## Wiring: one trunk that splits and merges
 *
 * Both banners expose a SINGLE centred handle, so the connectors share their
 * first and last segment: one line leaves the framing card, splits across the
 * columns, and merges back into one line entering the assessment. The old
 * per-column handles landed N separate drops side by side on the banner edges,
 * which read as parallel arrows rather than a fan.
 *
 * Getting the bar to be one line rather than a staircase is entirely
 * @xyflow/react's own `getSmoothStepPath` — it takes `centerX`/`centerY` (the
 * bend location) and `offset` (the minimum straight run out of a handle), none
 * of which the built-in `SmoothStepEdge` forwards through `pathOptions`. Pin
 * all three to the shared end and every edge bends on the same line; leave them
 * to their defaults and each edge bends at its own midpoint, which with columns
 * of unequal height scatters the merge and draws a doubled hairline. See
 * `trunkEdge`.
 *
 * ## No flicker
 *
 * Three rules, because this graph re-lays out while a turn streams:
 *  1. Nodes are re-seeded by MERGING into the previous ones — a streamed data
 *     update never resets a measured position back to y=0, and a brand-new node
 *     is seeded at its row's last known y instead of on top of the framing card.
 *  2. The measure→place pass is a layout effect and both it and the re-seed
 *     bail out when nothing actually moved, so the browser never paints a
 *     provisional frame and repeated passes converge instead of oscillating.
 *  3. The opacity gate lifts once, after the FIRST layout. Reflows (resize,
 *     streaming, column re-packing) keep the graph visible — the old gate was
 *     keyed on orientation and fired a full fade-out/in on every flip.
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
  BaseEdge,
  Handle,
  Position,
  applyNodeChanges,
  getSmoothStepPath,
  useNodesInitialized,
  useReactFlow,
  type Node,
  type NodeChange,
  type Edge,
  type EdgeProps,
  type NodeProps,
} from '@xyflow/react'
import { Sparkles } from 'lucide-react'
import '@xyflow/react/dist/style.css'
import type { Translator } from '@/i18n'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { useLayoutStore } from '@/features/layout/store'
import { TechnicalSteps } from './TechnicalSteps'
import type { ThinkingStep, CitationSource } from '../../types'
import { deriveTraceSourceCards, totalSourceCardHits } from '../../lib/trace-lanes'
import type { TraceSourceCard } from '../../lib/trace-lanes'
import { SourceCard } from './SourceCard'
import { BranchOptions } from './BranchOptions'
import { citationChips } from './citations'
import type { ChoicePrompt } from './citations'

/** Hidden connection handle (edges anchor to it; the dot itself is invisible). */
const H = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 'none', background: 'transparent' } as const
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
  /** Bottom (source) handles — one per column, or a single centre. */
  sources: HandleSpec[]
}
/**
 * One column of the fan-out. Usually a single card; on a container too narrow
 * for one column per source the extra cards stack inside the column instead of
 * collapsing the whole graph into a vertical chain.
 */
type SourceColumnData = {
  cards: TraceSourceCard[]
  hitLabel: (count: number) => string
  gapLabel: string
  /** Enter-animation offset so the row cascades left→right. */
  index: number
  /** Single-column (phone) layout — the cards get the grouped container. */
  grouped: boolean
  groupLabel: string
}
type FindingsData = {
  label: string
  /**
   * Reasoning-specific detail: which lanes actually produced hits for this turn
   * (deduped lane labels). This is NOT the answer's trust verdict — the
   * confidence chip and provenance chips live once, on the answer card.
   */
  hitSummary?: string
  /** "9 hits across 5 documents" — the tally, stated before the strata. */
  tally?: string
  /** Streaming: the verdict has not landed, so the node reads as in-flight. */
  pending?: boolean
  /** Top (target) handles — one per incoming column, or a single centre. */
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

/**
 * One fan-out column. Exactly two edges touch it — framing → column and
 * column → assessment — both centred, so the connector is always a straight
 * drop no matter how many cards the column carries. Stacked cards are joined by
 * a short hairline in the same ink as the edges, so the stack reads as "these
 * were searched together", not as a sequence of steps.
 */
const SourceColumnFlowNode: FC<NodeProps<Node<SourceColumnData>>> = ({ data }) => {
  const stack = (
    <div role="list" aria-label={data.groupLabel} className="flex w-full flex-col">
      {data.cards.map((card, i) => (
        <div key={card.id} className="flex flex-col">
          {i > 0 && (
            <span
              aria-hidden="true"
              className="mx-auto h-2.5 w-px shrink-0"
              style={{ backgroundColor: EDGE_STROKE }}
            />
          )}
          <div
            className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300"
            style={{ animationDelay: `${(data.index + i) * 60}ms`, animationFillMode: 'backwards' }}
          >
            <SourceCard card={card} hitLabel={data.hitLabel(card.hitCount)} gapLabel={data.gapLabel} />
          </div>
        </div>
      ))}
    </div>
  )

  return (
    <div className="w-[var(--source-w)] max-w-full">
      <Handle id="in" type="target" position={Position.Top} style={{ ...H, left: '50%' }} />
      {data.grouped ? (
        <div className="animate-in fade-in-0 duration-300 rounded-xl border bg-muted/40 px-3 py-3">
          <Eyebrow>{data.groupLabel}</Eyebrow>
          <div className="mt-2">{stack}</div>
        </div>
      ) : (
        stack
      )}
      <Handle id="out" type="source" position={Position.Bottom} style={{ ...H, left: '50%' }} />
    </div>
  )
}

const FindingsFlowNode: FC<NodeProps<Node<FindingsData>>> = ({ data }) => (
  <div
    className={cn(
      'w-[var(--banner-w)] max-w-full rounded-xl border bg-card px-4 py-3 text-left shadow-xs',
      // Pending reads as in-flight rather than as an empty result: dashed
      // hairline, no fill — the same visual grammar the gap source cards use.
      data.pending && 'border-dashed bg-transparent shadow-none'
    )}
  >
    {data.targets.map((h) => (
      <Handle key={h.id} id={h.id} type="target" position={Position.Top} style={{ ...H, left: h.left }} />
    ))}
    <Eyebrow>
      <span className="inline-flex items-center gap-1.5">
        {data.pending && (
          <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-brand" />
        )}
        {data.label}
      </span>
    </Eyebrow>
    {/* The tally leads: what was read is the checkable claim. The strata line
        follows as "from where". The trust verdict (confidence + provenance
        chips) is NOT restated here — it lives once on the answer card. */}
    {data.tally && (
      <p className="mt-1 text-[13px] font-semibold leading-snug tabular-nums text-foreground">
        {data.tally}
      </p>
    )}
    {data.hitSummary && (
      <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{data.hitSummary}</p>
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
  sourceColumn: SourceColumnFlowNode,
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
  /** Turn is still streaming — edges animate and the graph keeps growing. */
  live?: boolean
}

// ── layout constants ──────────────────────────────────────────────────────────
/** Narrowest a source card may get before we stack instead of adding a column. */
const MIN_COL_W = 146
/** Widest a single column grows to, so 2 sources don't become two half-pages. */
const MAX_COL_W = 236
/**
 * At or below this content width the fan always collapses to ONE grouped
 * column. A phone would arithmetically fit two ~160px columns, but a source
 * card's name is a two-line clamp — side-by-side at that width it turns into
 * two columns of ellipses. This is a readability floor, not a fitting rule.
 */
const GROUPED_MAX_W = 420
const COL_GAP = 14
/** Vertical gap between graph rows (framing / sources / assessment / branches). */
const ROW_GAP = 40
/**
 * Container bottom padding below the last row.
 *
 * Must clear what renders OUTSIDE a node's border box, because React Flow's
 * pane clips: the card enter animation starts 8px lower (`slide-in-from-bottom-2`)
 * and `shadow-xs` bleeds a few px further. Sized to the content alone, the
 * bottom row visibly clipped for the whole animation — most obvious while a
 * turn streams, when cards enter continuously.
 */
const PAD = 24
/** Floor for the content width, so a not-yet-measured container still builds. */
const MIN_CONTENT_W = 220
/**
 * Width assumed when the container reports none — a typical desktop chat
 * column. `clientWidth` is 0 in jsdom and in any display:none ancestor, and the
 * graph must still render there; the ResizeObserver corrects it on the first
 * real measurement (before paint, since it runs in a layout effect).
 */
const FALLBACK_W = 680

/** How the sources are packed into columns for a given container width. */
export interface FanLayout {
  /** Card indices per column, left→right. Empty when the turn has no sources. */
  columns: number[][]
  colW: number
  gap: number
  /** x of the first column (the fan is centred in the content width). */
  fanX: number
  contentW: number
  /**
   * Narrow container → the single column wears the grouped "Quellen"
   * container. Note this is about the WIDTH, not the column count: one source
   * on a desktop is a single normal card, not a full-width box.
   */
  grouped: boolean
}

/**
 * Pack `cardCount` source cards into as many columns as `width` affords.
 *
 * Exported for tests: this is the whole responsive story, and the property that
 * matters is that the desktop chat column NEVER degrades to a single column
 * just because a turn touched a lot of documents — it packs wider instead.
 */
export function planFan(width: number, cardCount: number): FanLayout {
  const contentW = Math.max(MIN_CONTENT_W, Math.floor(width) || MIN_CONTENT_W)
  const grouped = contentW <= GROUPED_MAX_W
  if (cardCount <= 0) {
    return { columns: [], colW: contentW, gap: COL_GAP, fanX: 0, contentW, grouped: false }
  }
  const capacity = grouped ? 1 : Math.max(1, Math.floor((contentW + COL_GAP) / (MIN_COL_W + COL_GAP)))
  const count = Math.min(cardCount, capacity)
  const colW = grouped
    ? contentW
    : Math.min(MAX_COL_W, Math.floor((contentW - (count - 1) * COL_GAP) / count))
  const fanW = count * colW + (count - 1) * COL_GAP
  const fanX = Math.max(0, Math.round((contentW - fanW) / 2))

  // Balanced, reading-order distribution: the remainder lands on the LEFT
  // columns so the row is never one lone tall column at the end.
  const base = Math.floor(cardCount / count)
  const remainder = cardCount % count
  const columns: number[][] = []
  let next = 0
  for (let c = 0; c < count; c++) {
    const size = base + (c < remainder ? 1 : 0)
    columns.push(Array.from({ length: size }, () => next++))
  }
  return { columns, colW, gap: COL_GAP, fanX, contentW, grouped }
}

/** Corner rounding on every connector. */
const EDGE_RADIUS = 12
/**
 * Where the shared elbow sits, as a distance from the banner the edges leave
 * (split) or enter (merge) — i.e. the middle of ROW_GAP. Keep it at least
 * EDGE_RADIUS away from BOTH rows: the tallest column ends exactly ROW_GAP
 * above the assessment, so an elbow closer than one corner radius leaves
 * getSmoothStepPath no room and it degenerates into a doubled, kinked line.
 */
const TRUNK_ELBOW = ROW_GAP / 2

/**
 * A connector whose bend is pinned to a SHARED height instead of its own
 * midpoint.
 *
 * `getSmoothStepPath` takes a `centerY` — the y of the horizontal segment — but
 * React Flow's built-in `SmoothStepEdge` only forwards `borderRadius`/`offset`
 * from `pathOptions`, so the bend defaults to each edge's own midpoint. With
 * columns of unequal height that scatters the merge into a staircase: every
 * edge turns at a different height on its way into the assessment.
 *
 * Pinning `centerY` to a fixed offset from the banner all these edges share
 * puts every bend on ONE line, so the fan reads as a single trunk that splits
 * and then merges — which is the whole point of the shape.
 */
function trunkEdge(anchor: 'source' | 'target'): FC<EdgeProps> {
  const TrunkEdge: FC<EdgeProps> = ({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    markerEnd,
    style,
  }) => {
    const [path] = getSmoothStepPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      borderRadius: EDGE_RADIUS,
      // Split: pinned just below the framing card, which every edge leaves.
      // Merge: pinned just above the assessment, which every edge enters.
      centerY: anchor === 'source' ? sourceY + TRUNK_ELBOW : targetY - TRUNK_ELBOW,
      // Pin the x bend to the SHARED end too. Left to compute its own centerX,
      // the path takes a second bend at the horizontal midpoint — a sub-pixel
      // jog that renders as a doubled hairline along the trunk.
      centerX: anchor === 'source' ? sourceX : targetX,
      // `offset` is the minimum straight run out of a handle, and it OVERRIDES
      // centerY when the two disagree. The default (20) is the full elbow
      // distance, so the tallest column — which ends exactly ROW_GAP above the
      // assessment — got pushed off the shared bar by a pixel or two, drawing
      // the trunk as two near-parallel lines. Keep it well under TRUNK_ELBOW.
      offset: TRUNK_ELBOW / 2,
    })
    return <BaseEdge path={path} markerEnd={markerEnd} style={style} />
  }
  TrunkEdge.displayName = anchor === 'source' ? 'SplitEdge' : 'MergeEdge'
  return TrunkEdge
}

const edgeTypes = {
  split: trunkEdge('source'),
  merge: trunkEdge('target'),
}

/** One connector. `type` picks which end its shared elbow is pinned to. */
function edge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  type: 'split' | 'merge' = 'merge'
): Edge {
  return {
    id: `${source}:${sourceHandle}->${target}:${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
    type,
    style: { stroke: EDGE_STROKE, strokeWidth: 1.5 },
  }
}

export interface BuiltGraph {
  nodes: Node[]
  edges: Edge[]
  /** Row groups, top→bottom, for the measured y-stacking pass. */
  rows: string[][]
}

/**
 * Pure graph builder — exported for structural regression tests. Produces the
 * nodes (with per-column handle specs), the parallel wiring, and the row groups
 * for the measured layout pass. See ReasoningFlow.spec.
 */
export function buildGraph(
  props: ReasoningFlowProps,
  t: Translator,
  layout: FanLayout,
  cards: TraceSourceCard[]
): BuiltGraph {
  const { columns, colW, gap, fanX, grouped } = layout
  const hasSources = cards.length > 0 && columns.length > 0
  const hasBranches = Boolean(props.choicePrompt && props.choicePrompt.options.length > 0)
  const hasVerdict = Boolean(props.answerConfidence) || (props.citations?.length ?? 0) > 0
  /**
   * While the turn streams there is no verdict yet, but the graph still gets
   * its converge node — in a pending state. Without it the source columns end
   * in mid-air (no merge trunk, no common point) and the whole shape jumps the
   * instant the answer lands. A proof of work should look like work in
   * progress, not like a broken diagram.
   */
  const pendingFindings = !hasVerdict && !hasBranches && Boolean(props.live) && hasSources
  const hasFindings = hasVerdict || pendingFindings

  const columnIds = columns.map((_, i) => `col-${i}`)
  const columnX = (i: number) => fanX + i * (colW + gap)

  const routing =
    props.routingDecision && props.routingReason?.trim()
      ? t('thinking.routing.line', {
          decision: t(`thinking.routing.decision.${props.routingDecision}`),
          reason: props.routingReason.trim(),
        })
      : undefined
  const routingLabel = routing ? t('thinking.routing.whyLabel') : undefined

  const convergeId = hasFindings ? 'findings' : hasBranches ? 'branches' : null

  // ONE centred anchor on each banner, both directions. Every column edge
  // leaves the framing card from the same point and lands on the assessment at
  // the same point, so the fan reads as a single line that SPLITS into the
  // sources and MERGES back out of them — the connectors share their first and
  // last segment instead of arriving as N separate parallel drops.
  const centre: HandleSpec[] = hasSources || convergeId ? [{ id: 'c-bottom', left: '50%' }] : []
  const framingSources: HandleSpec[] = centre
  const convergeTargets: HandleSpec[] = [{ id: 'c-top', left: '50%' }]

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
  // The proof-of-work tally: what was actually read. Stated where the fan
  // converges, ahead of the lane list, because "9 hits across 5 documents" is
  // the claim a reader checks first — the strata answer "from where", not
  // "how much". Gap cards contribute documents but no hits, so they are counted
  // as sources and excluded from the hit total (totalSourceCardHits).
  const hitTotal = totalSourceCardHits(cards)
  const tally =
    hasSources && hitTotal > 0
      ? t(cards.length === 1 ? 'thinking.node.findingsTallyOne' : 'thinking.node.findingsTally', {
          hits: hitTotal,
          docs: cards.length,
        })
      : undefined
  const findingsData: FindingsData | null = hasFindings
    ? {
        label: pendingFindings ? t('thinking.node.findingsPendingTab') : t('thinking.node.findingsTab'),
        pending: pendingFindings,
        tally,
        hitSummary: pendingFindings
          ? t('thinking.node.findingsPending')
          : hitLanes.length > 0
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

  nodes.push({ id: 'framing', type: 'framing', position: { x: 0, y: 0 }, data: framingData as Record<string, unknown> })
  columns.forEach((indices, i) => {
    const columnData: SourceColumnData = {
      cards: indices.map((idx) => cards[idx]!),
      // "1 hits" on a card that is meant to prove rigour undercuts it; the
      // translator has no plural support, so the singular is its own key.
      hitLabel: (count: number) =>
        count === 1 ? t('thinking.hitCountOne') : t('thinking.hitCount', { count }),
      gapLabel: t('thinking.gapHit'),
      index: indices[0] ?? i,
      grouped,
      groupLabel: t('thinking.sourcesFanOut'),
    }
    nodes.push({
      id: columnIds[i]!,
      type: 'sourceColumn',
      position: { x: columnX(i), y: 0 },
      data: columnData as unknown as Record<string, unknown>,
    })
  })
  if (findingsData) {
    nodes.push({ id: 'findings', type: 'findings', position: { x: 0, y: 0 }, data: findingsData as Record<string, unknown> })
  }
  if (branchesData) {
    nodes.push({ id: 'branches', type: 'branches', position: { x: 0, y: 0 }, data: branchesData as Record<string, unknown> })
  }

  // Wiring: framing fans out to every column, every column converges on the
  // assessment/branches node (parallel, never a chain). All of it through the
  // single centred anchor on each banner, so the split and the merge are real.
  if (hasSources) {
    columnIds.forEach((cid) => edges.push(edge('framing', 'c-bottom', cid, 'in', 'split')))
    if (convergeId) columnIds.forEach((cid) => edges.push(edge(cid, 'out', convergeId, 'c-top', 'merge')))
  } else if (convergeId) {
    edges.push(edge('framing', 'c-bottom', convergeId, 'c-top'))
  }
  if (findingsData && branchesData) edges.push(edge('findings', 'out', 'branches', 'c-top'))

  // Row groups for the measured stacking pass — every column shares one row, so
  // the assessment clears the TALLEST column.
  const rows: string[][] = [['framing']]
  if (hasSources) rows.push(columnIds)
  if (findingsData) rows.push(['findings'])
  if (branchesData) rows.push(['branches'])

  return { nodes, edges, rows }
}

const FlowInner: FC<{ built: BuiltGraph; layout: FanLayout; live: boolean }> = ({ built, layout, live }) => {
  const t = useTranslations('chat')
  const { nodes, edges, rows } = built
  const initialized = useNodesInitialized()
  const { getNodes } = useReactFlow()
  const [rfNodes, setRfNodes] = useState<Node[]>(nodes)
  const [height, setHeight] = useState<number | null>(null)
  // Lifts once, after the first measured layout. Reflows afterwards (resize,
  // streaming, column re-packing) keep the graph visible — fading on every
  // relayout is exactly the flicker this replaced.
  const [laidOut, setLaidOut] = useState(false)
  /** Last measured y per row index — seeds nodes that appear mid-stream. */
  const rowYRef = useRef<number[]>([])

  const onNodesChange = useCallback((changes: NodeChange[]) => setRfNodes((nds) => applyNodeChanges(changes, nds)), [])

  /** Row index a node belongs to, for seeding a newly-streamed node's y. */
  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>()
    rows.forEach((row, i) => row.forEach((id) => map.set(id, i)))
    return map
  }, [rows])

  // Sync the derived graph into the controlled node list. Data (streamed text,
  // new source cards) and x always come from the fresh build; y and the measured
  // size are carried over from the node we already have, so an update never
  // resets the layout to the provisional y=0 stack.
  useEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      const next = nodes.map((n) => {
        const old = prevById.get(n.id)
        if (!old) {
          const rowY = rowYRef.current[rowIndexById.get(n.id) ?? -1]
          return { ...n, position: { x: n.position.x, y: rowY ?? 0 } }
        }
        return { ...old, ...n, position: { x: n.position.x, y: old.position.y } }
      })
      return next
    })
  }, [nodes, rowIndexById])

  // While the turn streams, the connectors march (React Flow's built-in
  // animated dashes); a finished turn freezes them solid.
  const renderedEdges = useMemo(
    () => (live ? edges.map((e) => ({ ...e, animated: true })) : edges),
    [edges, live]
  )

  const rowsKey = useMemo(() => rows.map((r) => r.join('|')).join('/'), [rows])

  // Measure → place: once every node reports a measured size, stack the rows by
  // their REAL heights and size the container to the exact content. A layout
  // effect so the provisional positions are never painted, and both updates bail
  // out when nothing moved — that bail-out is what lets this depend on `rfNodes`
  // (re-running as heights settle) without oscillating.
  useLayoutEffect(() => {
    if (!initialized) return
    const measured = new Map(getNodes().map((n) => [n.id, n.measured?.height ?? 0]))
    const yById = new Map<string, number>()
    const rowY: number[] = []
    let y = 0
    rows.forEach((row, i) => {
      rowY[i] = y
      let rowH = 0
      for (const id of row) {
        yById.set(id, y)
        rowH = Math.max(rowH, measured.get(id) ?? 0)
      }
      y += rowH + ROW_GAP
    })
    rowYRef.current = rowY

    setRfNodes((prev) => {
      let moved = false
      const next = prev.map((n) => {
        const ny = yById.get(n.id)
        if (ny === undefined || n.position.y === ny) return n
        moved = true
        return { ...n, position: { ...n.position, y: ny } }
      })
      return moved ? next : prev
    })
    setHeight(Math.max(120, Math.ceil(Math.max(0, y - ROW_GAP)) + PAD))
    setLaidOut(true)
    // rows is covered by rowsKey (stable string); getNodes is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, rowsKey, rfNodes])

  return (
    <div
      style={{
        height: height ?? undefined,
        minHeight: height ? undefined : 160,
        opacity: laidOut ? 1 : 0,
        transition: 'opacity 150ms ease-out',
        ['--banner-w' as string]: `${layout.contentW}px`,
        ['--source-w' as string]: `${layout.colW}px`,
      }}
      className="w-full"
      data-testid="reasoning-flow"
      role="group"
      aria-label={t('thinking.reasoningGraphLabel')}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={renderedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        minZoom={1}
        maxZoom={1}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // This is a read-only display graph — nothing is selectable, draggable,
        // or deletable. Leaving nodes/edges focusable makes every node an inert
        // keyboard tab stop and has the screen reader announce "press enter to
        // select / delete to remove" on content where those keys do nothing. The
        // real interactive content (branch-option buttons) are native <button>s
        // and stay reachable regardless.
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
  )
}

export const ReasoningFlow: FC<ReasoningFlowProps> = (props) => {
  const {
    steps,
    userQuestion,
    answerConfidence,
    citations,
    choicePrompt,
    onChoiceRespond,
    routingDecision,
    routingReason,
    escalationReason,
    live,
  } = props
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

  const cards = useMemo(() => deriveTraceSourceCards(steps), [steps])
  const layout = useMemo(() => planFan(width || FALLBACK_W, cards.length), [width, cards.length])
  // Memoised on the fields that actually shape the graph — NOT on the props
  // object, whose identity changes on every parent render and would rebuild
  // (and re-measure) the whole graph each time.
  const built = useMemo(
    () =>
      buildGraph(
        {
          steps,
          userQuestion,
          answerConfidence,
          citations,
          choicePrompt,
          onChoiceRespond,
          routingDecision,
          routingReason,
          escalationReason,
          // Drives the pending converge node: while the turn streams the graph
          // still needs its merge point, or the source columns end in mid-air.
          live,
        },
        t,
        layout,
        cards
      ),
    [
      steps,
      userQuestion,
      answerConfidence,
      citations,
      choicePrompt,
      onChoiceRespond,
      routingDecision,
      routingReason,
      escalationReason,
      live,
      t,
      layout,
      cards,
    ]
  )

  return (
    <div ref={containerRef} className="flex w-full flex-col gap-3">
      <ReactFlowProvider>
        <FlowInner built={built} layout={layout} live={live ?? false} />
      </ReactFlowProvider>

      {showTechnicalReasoning && steps.length > 0 && (
        <div className="border-t border-base pt-2">
          <TechnicalSteps steps={steps} t={t} />
        </div>
      )}
    </div>
  )
}
