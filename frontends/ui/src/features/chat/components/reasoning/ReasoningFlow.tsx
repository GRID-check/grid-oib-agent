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
 * ## Handles are structural, never conditional
 *
 * React Flow measures a node's handle positions when the node element is first
 * measured and re-measures them only when that element RESIZES (its
 * ResizeObserver) or when the node's type / sourcePosition / targetPosition
 * changes. Mounting a new `<Handle>` into a node already on screen is invisible
 * to it: the stale `handleBounds` has no entry for the new id, so
 * `getEdgePosition` returns null and every edge on that handle silently fails
 * to render.
 *
 * That is what a conditional handle used to do here. A live turn starts with no
 * sources and no verdict, so the framing card was measured with an EMPTY handle
 * list; the first streamed source then added its bottom anchor without changing
 * the card's height, and the fan-out drew no connectors at all — unless the
 * routing line happened to land in the same tick and resize the card into a
 * re-measure. Hence "sometimes the connectors are mangled".
 *
 * So every node declares its FULL handle set for its whole lifetime, whether or
 * not an edge is currently attached: the anchors are 1×1 and invisible, and one
 * nothing connects to costs nothing. The `handleSigs` effect is the belt to that
 * braces — if a handle set ever becomes conditional again it re-measures the
 * node instead of quietly dropping its edges.
 *
 * ## No flicker
 *
 * Four rules, because this graph re-lays out while a turn streams:
 *  1. Nodes are re-seeded by MERGING into the previous ones — a streamed data
 *     update never resets a measured position back to y=0, and a brand-new node
 *     is seeded at its row's last known y instead of on top of the framing card.
 *  2. Both the re-seed and the measure→place pass are LAYOUT effects, so a
 *     streamed update lands its data, its x and its measured y in one pre-paint
 *     commit. As a passive effect the re-seed painted a frame of the previous
 *     tick's data at the new tick's layout, every tick.
 *  3. The pass measures the node ELEMENTS, and re-runs on every width the fan is
 *     planned against. React Flow's own `measured` is a frame behind across a
 *     reflow, and it emits no dimension change for a node that ends a reflow at
 *     the size it started — a viewport that widens and snaps back (a rotation, a
 *     devtools pane, a full-page screenshot) therefore left the graph placed
 *     from the widths it had MID-reflow, with every row overlapping the next and
 *     nothing left to trigger a correction.
 *  4. The opacity gate lifts once, after the FIRST layout. Reflows (resize,
 *     streaming, column re-packing) keep the graph visible — the old gate was
 *     keyed on orientation and fired a full fade-out/in on every flip.
 *
 * ## Entrances fire once per CARD, not once per mount
 *
 * The source cards animate in. Which column NODE a card lives in is a function
 * of the container width and the card count, so one new source re-packs the fan
 * and moves most cards to a different column — React unmounts them there and
 * mounts them here, and a CSS enter animation replays on mount. The fix is not
 * to fight the re-pack but to key the entrance on card IDENTITY: `ReasoningFlow`
 * remembers which cards have already animated and hands the columns an
 * `enterOrder` holding only the ones that have not. See `animatedRef`.
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
  useUpdateNodeInternals,
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
import { deriveTraceLanes } from '../../lib/trace-lanes'
import { buildCitationModel, totalHits, type CitedDocument } from '../../lib/citations'
import { SourceCard } from './SourceCard'
import { SectionLabel } from '@/components/ui/section-label'
import { BranchOptions } from './BranchOptions'
import { citationChips } from './citations'
import type { ChoicePrompt } from './citations'

/** Hidden connection handle (edges anchor to it; the dot itself is invisible). */
const H = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 'none', background: 'transparent' } as const
const EDGE_STROKE = 'color-mix(in oklch, var(--foreground) 18%, transparent)'

/** One anchor point on a banner edge: a handle id + its x offset within the node. */
type HandleSpec = { id: string; left: string }

/**
 * The centred anchors every banner carries for its whole lifetime. Declared here
 * rather than inline so they read as what they are: a fixed part of each node's
 * shape, not something a turn's state switches on. See the module header — a
 * handle that appears after its node was measured never gets measured, and the
 * edges on it disappear.
 */
const CENTRE_BOTTOM: HandleSpec = { id: 'c-bottom', left: '50%' }
const CENTRE_TOP: HandleSpec = { id: 'c-top', left: '50%' }
const CENTRE_OUT: HandleSpec = { id: 'out', left: '50%' }

/**
 * The card entrance, in ms. Kept in code because `animatedRef` has to know when
 * the animation it started is over, and the animation itself is pure CSS
 * (`duration-base` plus an inline per-card delay) — so this constant must stay
 * equal to `--motion-base`.
 */
const ENTER_MS = 240
const ENTER_STAGGER_MS = 60

const Eyebrow: FC<{ children: React.ReactNode }> = ({ children }) => (
  <SectionLabel as="div">{children}</SectionLabel>
)

// ── node payloads ───────────────────────────────────────────────────────────
type FramingData = {
  label: string
  question: string
  routingLabel?: string
  routing?: string
  escalation?: string
  /**
   * Bottom (source) handles. Always populated — even on a turn that has not
   * streamed a single source yet. See the module header on structural handles.
   */
  sources: HandleSpec[]
}
/**
 * One column of the fan-out. Usually a single card; on a container too narrow
 * for one column per source the extra cards stack inside the column instead of
 * collapsing the whole graph into a vertical chain.
 */
type SourceColumnData = {
  cards: CitedDocument[]
  hitLabel: (count: number) => string
  gapLabel: string
  /**
   * Cascade slot per card id, for the cards that have NOT played their entrance
   * yet. A card missing from the map has already animated — in this column, or
   * in whichever one it sat in before the fan re-packed — and renders with no
   * enter animation at all.
   */
  enterOrder: ReadonlyMap<string, number>
  /** Single-column (phone) layout — the cards get the grouped container. */
  grouped: boolean
  groupLabel: string
  /**
   * The turn is still running.
   *
   * "gelesen, nicht verwendet" is a claim about the FINISHED answer, and while
   * the turn streams there is no answer to make it about — so every retrieved
   * document briefly reads as discarded, including the ones the answer is about
   * to cite. The card withholds the verdict until the turn lands.
   */
  live: boolean
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
  /**
   * Bottom (source) handle. Rendered whether or not a branches node follows: a
   * live turn grows the branches prompt UNDER an assessment that is already
   * measured, and a handle added at that point gets no handle bounds — the
   * findings→branches connector would simply not draw.
   */
  source: HandleSpec
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
    <p className="mt-1 text-sm leading-relaxed text-foreground">{data.question}</p>
    {data.routing && (
      <div className="mt-2 border-t border-base pt-1.5">
        {data.routingLabel && <Eyebrow>{data.routingLabel}</Eyebrow>}
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{data.routing}</p>
      </div>
    )}
    {data.escalation && <p className="mt-1.5 text-xs leading-relaxed text-warning">{data.escalation}</p>}
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
      {data.cards.map((card, i) => {
        // Only a card that has never animated gets the entrance. Everything else
        // is here because the fan re-packed — it was on screen a frame ago, and
        // replaying its entrance is the flash this graph used to be full of.
        const slot = data.enterOrder.get(card.id)
        const entering = slot !== undefined
        return (
          <div key={card.id} className="flex flex-col">
            {i > 0 && (
              <span
                aria-hidden="true"
                className="mx-auto h-2.5 w-px shrink-0"
                style={{ backgroundColor: EDGE_STROKE }}
              />
            )}
            <div
              className={
                entering
                  ? 'animate-in fade-in-0 slide-in-from-bottom-2 duration-base ease-entrance motion-reduce:animate-none'
                  : undefined
              }
              style={
                entering
                  ? { animationDelay: `${slot * ENTER_STAGGER_MS}ms`, animationFillMode: 'backwards' }
                  : undefined
              }
            >
              <SourceCard
                document={card}
                hitLabel={data.hitLabel(card.loci.length)}
                gapLabel={data.gapLabel}
                live={data.live}
              />
            </div>
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="w-[var(--source-w)] max-w-full">
      <Handle id="in" type="target" position={Position.Top} style={{ ...H, left: '50%' }} />
      {data.grouped ? (
        // No entrance on the container itself — the cards inside carry it, and
        // this wrapper re-mounts whenever the width crosses GROUPED_MAX_W, which
        // faded the whole box back in on top of them on every such resize.
        <div className="rounded-xl border bg-muted px-3 py-3">
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
      <p className="mt-1 text-sm font-semibold leading-snug tabular-nums text-foreground">
        {data.tally}
      </p>
    )}
    {data.hitSummary && (
      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{data.hitSummary}</p>
    )}
    <Handle id={data.source.id} type="source" position={Position.Bottom} style={{ ...H, left: data.source.left }} />
  </div>
)

const BranchesFlowNode: FC<NodeProps<Node<BranchesData>>> = ({ data }) => (
  <div className="w-[var(--banner-w)] max-w-full rounded-xl border border-input bg-card px-4 py-3 text-left shadow-xs">
    {data.targets.map((h) => (
      <Handle key={h.id} id={h.id} type="target" position={Position.Top} style={{ ...H, left: h.left }} />
    ))}
    <div className="text-sm font-semibold text-foreground">{data.prompt.text.trim() || data.sub}</div>
    <div className="mb-3 mt-0.5 text-xs leading-relaxed text-muted-foreground">{data.sub}</div>
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
  cards: CitedDocument[],
  /**
   * Cascade slot for each card that has not played its entrance yet. Empty by
   * default: a graph built without it animates nothing, which is the right
   * answer both for a structural test and for a rebuild that added no cards.
   */
  enterOrder: ReadonlyMap<string, number> = new Map()
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
  //
  // Unconditional on purpose: gating these on `hasSources || convergeId` meant
  // the framing card of a just-started turn was measured with no handles, and
  // the anchor the first streamed source needs was then added to a node already
  // on screen — which React Flow never re-measures, so the fan drew no
  // connectors. See the module header.
  const framingSources: HandleSpec[] = [CENTRE_BOTTOM]
  const convergeTargets: HandleSpec[] = [CENTRE_TOP]

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
  // A document read but never cited contributes to the document count and to
  // the hit total alike — it WAS read, which is what the tally claims.
  const hitTotal = totalHits(cards)
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
        source: CENTRE_OUT,
      }
    : null
  const branchesData: BranchesData | null =
    hasBranches && props.choicePrompt
      ? {
          prompt: props.choicePrompt,
          onRespond: props.onChoiceRespond ?? (() => {}),
          sub: t('thinking.node.branchesSub'),
          // Branches receives the fan-in only when it IS the converge target
          // (no findings); otherwise it takes a single feed from findings —
          // either way the same centred anchor, so the node's handle set never
          // depends on which.
          targets: convergeTargets,
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
      enterOrder,
      grouped,
      groupLabel: t('thinking.sourcesFanOut'),
      live: Boolean(props.live),
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
  const paneRef = useRef<HTMLDivElement>(null)
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
  //
  // A LAYOUT effect, not a passive one: the measure→place pass below is one, so
  // as a passive effect this landed a frame later and every stream tick painted
  // the previous tick's node data sitting at the new tick's layout.
  useLayoutEffect(() => {
    setRfNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]))
      const next = nodes.map((n) => {
        const old = prevById.get(n.id)
        if (!old) {
          // A node in a row that has never been measured (the assessment
          // landing, the branches prompt arriving) seeds at the sentinel the
          // place pass leaves one past the last row — BELOW the graph — rather
          // than at y=0 on top of the framing card.
          const rowY = rowYRef.current[rowIndexById.get(n.id) ?? -1]
          return { ...n, position: { x: n.position.x, y: rowY ?? rowYRef.current.at(-1) ?? 0 } }
        }
        return { ...old, ...n, position: { x: n.position.x, y: old.position.y } }
      })
      return next
    })
  }, [nodes, rowIndexById])

  // React Flow gives a node handle bounds when it measures the element and
  // re-measures them only when the element RESIZES, so a handle that appears on
  // a node already on screen never gets bounds and every edge on it stops
  // rendering. The node components declare their handles unconditionally so
  // this cannot happen; this is the guard that keeps it that way, re-measuring
  // any node whose handle set changed under us anyway.
  const updateNodeInternals = useUpdateNodeInternals()
  const handleSigs = useMemo(() => {
    const sigs = new Map<string, string>()
    for (const n of nodes) {
      const d = n.data as { sources?: HandleSpec[]; targets?: HandleSpec[]; source?: HandleSpec }
      const specs = [...(d.sources ?? []), ...(d.targets ?? []), ...(d.source ? [d.source] : [])]
      sigs.set(n.id, specs.map((h) => `${h.id}@${h.left}`).join(','))
    }
    return sigs
  }, [nodes])
  const prevHandleSigs = useRef(handleSigs)
  useEffect(() => {
    const changed: string[] = []
    for (const [id, sig] of handleSigs) {
      // Only an EXISTING node matters; a new one is measured on mount anyway.
      const prev = prevHandleSigs.current.get(id)
      if (prev !== undefined && prev !== sig) changed.push(id)
    }
    prevHandleSigs.current = handleSigs
    if (changed.length > 0) updateNodeInternals(changed)
  }, [handleSigs, updateNodeInternals])

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
  //
  // The heights come off the node ELEMENTS, not off React Flow's `measured`.
  // Its copy is written by a ResizeObserver, so across a reflow it is a frame
  // behind — and for a node that ends a reflow at the size it started at, React
  // Flow emits no dimension change at all. A viewport that widens and snaps back
  // (an orientation change, a devtools pane, a full-page screenshot) therefore
  // used to strand this graph in the heights it had MID-reflow: rows overlapping
  // the next, and nothing left that would ever trigger a correction. Reading the
  // DOM in a layout effect is always current, and `contentW`/`colW` in the deps
  // guarantee a pass on both edges of the reflow, so the second one lands on the
  // real geometry.
  useLayoutEffect(() => {
    if (!initialized) return
    const pane = paneRef.current
    const measured = new Map<string, number>()
    pane?.querySelectorAll<HTMLElement>('.react-flow__node[data-id]').forEach((el) => {
      if (el.dataset.id) measured.set(el.dataset.id, el.offsetHeight)
    })
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
    // One past the last row: where a row that does not exist yet would start.
    // The re-seed above reads it so a node arriving mid-stream never appears on
    // top of the framing card.
    rowY[rows.length] = y
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
    // rows is covered by rowsKey (a stable string). contentW/colW are the widths
    // the nodes are sized against, so both edges of a reflow get a pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, rowsKey, rfNodes, layout.contentW, layout.colW])

  return (
    <div
      ref={paneRef}
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

  /**
   * The turn's documents — retrieval fan-out AND the answer's own citations,
   * folded into one model. Feeding both in is what lets a card in this fan say
   * which `[N]` it became; before, the trace was built from the retrieval half
   * alone and had no way to reach the other.
   */
  const cards = useMemo(
    () => buildCitationModel({ traceLanes: deriveTraceLanes(steps), citations }),
    [steps, citations]
  )
  const layout = useMemo(() => planFan(width || FALLBACK_W, cards.length), [width, cards.length])

  /**
   * Card ids that have already played their enter animation.
   *
   * Which column NODE a card lives in is a function of the container width and
   * the card count, and `buildCitationModel` sorts, so one late source both
   * re-balances the columns and can land anywhere in the list. React tears the
   * card's DOM down in its old column and mounts it in the new one, replaying
   * the CSS entrance — a single new source made the whole fan flash, and every
   * card flashed again on a resize.
   *
   * Keying the entrance on card identity fixes both, and a third thing: the
   * cascade offset used to be the card's index in the WHOLE fan, so the eighth
   * source of a turn sat invisible for 420ms before appearing. A late arrival is
   * now slot 0 of its own batch.
   *
   * A card counts as entered only once its animation has had time to run.
   * Marking it the moment it rendered would be enough to survive a re-pack — but
   * this map has to go stale for a REASON, and "the card list did not change" is
   * not one: a resize alone re-packs the columns, and with the batch still
   * listed here every card would flash again on every resize.
   */
  const animatedRef = useRef<Set<string>>(new Set())
  const [entered, setEntered] = useState(0)
  const enterOrder = useMemo(() => {
    const order = new Map<string, number>()
    let slot = 0
    for (const c of cards) if (!animatedRef.current.has(c.id)) order.set(c.id, slot++)
    return order
    // `entered` is the settle signal, not a value this reads — it invalidates
    // the memo once the batch below has finished playing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, entered])
  useEffect(() => {
    if (enterOrder.size === 0) return
    const settle = Math.max(...enterOrder.values()) * ENTER_STAGGER_MS + ENTER_MS
    const timer = setTimeout(() => {
      for (const id of enterOrder.keys()) animatedRef.current.add(id)
      setEntered((n) => n + 1)
    }, settle)
    // Cards streaming in mid-cascade cancel this and fold into the next batch,
    // so an entrance is never cut short and no card is left unmarked.
    return () => clearTimeout(timer)
  }, [enterOrder])
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
        cards,
        enterOrder
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
      enterOrder,
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
