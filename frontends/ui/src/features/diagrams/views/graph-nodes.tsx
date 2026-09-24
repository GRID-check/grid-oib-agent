'use client'

/**
 * The nodes a diagram is drawn with — the card style, not mermaid's boxes.
 *
 * Handles are invisible and structural (one pair per node, fixed by the
 * graph's direction), exactly as in the Herleitung: React Flow measures a
 * node's handles once, and an edge needs one at each end to be drawn at all.
 * The route itself comes from dagre (`graph-canvas.tsx`), not from the handles.
 */

import type { FC } from 'react'
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { Split } from 'lucide-react'

import { cn } from '@/lib/utils'

const HIDDEN = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 'none', background: 'transparent' } as const

type Direction = 'TB' | 'LR'
export type GraphNodeData = { label: string; direction?: Direction; level?: number }

const Handles: FC<{ direction?: Direction }> = ({ direction = 'TB' }) => (
  <>
    <Handle type="target" position={direction === 'LR' ? Position.Left : Position.Top} style={HIDDEN} />
    <Handle type="source" position={direction === 'LR' ? Position.Right : Position.Bottom} style={HIDDEN} />
  </>
)

/** A step: what happens. */
export const StepNode: FC<NodeProps<Node<GraphNodeData>>> = ({ data }) => (
  <div className="border-border bg-card text-foreground rounded-lg border px-3 py-2 text-center text-[13px] leading-snug text-pretty hyphens-auto break-words shadow-xs">
    {data.label}
    <Handles direction={data.direction} />
  </div>
)

/** A decision: the question a path forks on. */
export const DecisionNode: FC<NodeProps<Node<GraphNodeData>>> = ({ data }) => (
  <div className="border-[color-mix(in_oklch,var(--border-color-feedback-warning)_45%,transparent)] bg-warning-subtle text-foreground flex items-start justify-center gap-1.5 rounded-lg border px-3 py-2 text-center text-[13px] leading-snug font-medium text-pretty shadow-xs">
    <Split aria-hidden="true" className="text-warning mt-0.5 size-3.5 shrink-0" />
    <span className="hyphens-auto break-words">{data.label}</span>
    <Handles direction={data.direction} />
  </div>
)

/** Where a path ends: an outcome. */
export const EndNode: FC<NodeProps<Node<GraphNodeData>>> = ({ data }) => (
  <div className="border-border bg-muted text-foreground rounded-full border px-3 py-1.5 text-center text-[13px] leading-snug font-medium text-pretty hyphens-auto break-words">
    {data.label}
    <Handles direction={data.direction} />
  </div>
)

/** A state diagram's start or end. */
export const PointNode: FC<NodeProps<Node<GraphNodeData>>> = ({ data }) => (
  <div className="flex h-3 w-3 items-center justify-center">
    <span className="bg-muted-foreground block size-2.5 rounded-full" />
    <Handles direction={data.direction} />
  </div>
)

/** A node of a map: the root is the Regelwerk, level 1 its parts, deeper levels what they cover. */
export const MapNode: FC<NodeProps<Node<GraphNodeData>>> = ({ data }) => {
  const level = data.level ?? 0
  return (
    <div
      className={cn(
        'text-foreground leading-snug text-pretty',
        level === 0 && 'bg-muted border-border rounded-xl border px-3 py-2 text-sm font-semibold shadow-xs',
        level === 1 && 'border-border bg-card rounded-lg border px-3 py-2 text-[13px] font-medium shadow-xs',
        level >= 2 && 'text-muted-foreground px-1 py-0.5 text-[12.5px]'
      )}
    >
      {data.label}
      <Handles direction={data.direction} />
    </div>
  )
}

export const FLOW_NODE_TYPES = { step: StepNode, decision: DecisionNode, end: EndNode, point: PointNode }
export const MAP_NODE_TYPES = { map: MapNode }
