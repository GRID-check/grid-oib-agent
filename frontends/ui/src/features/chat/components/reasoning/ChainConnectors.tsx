/**
 * ChainConnectors — dynamic, measured connectors for the Herleitung node chain.
 *
 * Replaces the old fixed-viewBox `ConnectorSvg` (a static graphic drawn once on
 * a 720-unit grid whose fan arms never actually pointed at the real cards). This
 * measures the LIVE DOM: it reads each node's rect (and, for the sources
 * fan-out/fan-in, each source card's rect) relative to the chain container and
 * draws orthogonal connectors between the real anchor points. It remeasures via
 * a ResizeObserver, so as each node streams in and the chain grows, the
 * connectors re-thread to wherever the nodes actually landed — at any card count
 * or column wrap.
 *
 * Purely decorative (aria-hidden), rendered as an absolute overlay BEHIND the
 * nodes. Degrades to nothing when it cannot measure (SSR / jsdom / zero-size).
 */

'use client'

import { type FC, type RefObject, useLayoutEffect, useState } from 'react'

/** Which connector leads INTO a node (mirrors the old ConnectorVariant). */
export type ChainConnector = 'line' | 'fan-out' | 'fan-in'

interface Edge {
  key: string
  d: string
  /** Arrowhead tip (destination), or null for none. */
  tip: { x: number; y: number } | null
}

interface Box {
  w: number
  h: number
}

// Theme-aware hairline — matches the source/provenance ink used elsewhere.
const STROKE = 'color-mix(in oklch, var(--foreground) 22%, transparent)'
const RING = 'var(--card)'

interface Anchor {
  cx: number
  top: number
  bottom: number
}

const anchor = (el: Element, originLeft: number, originTop: number): Anchor => {
  const r = el.getBoundingClientRect()
  return {
    cx: Math.round(r.left - originLeft + r.width / 2),
    top: Math.round(r.top - originTop),
    bottom: Math.round(r.top - originTop + r.height),
  }
}

const cardsIn = (node: Element): Element[] =>
  Array.from(node.querySelectorAll('[data-source-card]'))

export interface ChainConnectorsProps {
  containerRef: RefObject<HTMLElement | null>
  /** Changes whenever the visible node set changes → forces a remeasure. */
  signature: string
}

export const ChainConnectors: FC<ChainConnectorsProps> = ({ containerRef, signature }) => {
  const [box, setBox] = useState<Box>({ w: 0, h: 0 })
  const [edges, setEdges] = useState<Edge[]>([])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || typeof ResizeObserver === 'undefined') return

    const measure = (): void => {
      const cr = container.getBoundingClientRect()
      if (cr.width === 0 || cr.height === 0) {
        setEdges([])
        return
      }
      const nodes = Array.from(container.querySelectorAll('[data-chain-node]'))
      const next: Edge[] = []

      for (let i = 1; i < nodes.length; i++) {
        const el = nodes[i]
        const variant = (el.getAttribute('data-chain-connector') || 'line') as ChainConnector
        const a = anchor(nodes[i - 1], cr.left, cr.top) // upstream node
        const b = anchor(el, cr.left, cr.top) // this node
        const midY = a.bottom + Math.max(6, Math.round((b.top - a.bottom) * 0.5))

        if (variant === 'fan-out') {
          const cards = cardsIn(el)
          if (cards.length === 0) {
            next.push({ key: `e${i}`, d: `M${a.cx} ${a.bottom} V${b.top}`, tip: { x: b.cx, y: b.top } })
          } else {
            for (const [j, card] of cards.entries()) {
              const c = anchor(card, cr.left, cr.top)
              next.push({
                key: `e${i}-${j}`,
                d: `M${a.cx} ${a.bottom} V${midY} H${c.cx} V${c.top}`,
                tip: { x: c.cx, y: c.top },
              })
            }
          }
        } else if (variant === 'fan-in') {
          const cards = cardsIn(nodes[i - 1])
          if (cards.length === 0) {
            next.push({ key: `e${i}`, d: `M${a.cx} ${a.bottom} V${b.top}`, tip: { x: b.cx, y: b.top } })
          } else {
            for (const [j, card] of cards.entries()) {
              const c = anchor(card, cr.left, cr.top)
              next.push({
                key: `e${i}-${j}`,
                d: `M${c.cx} ${c.bottom} V${midY} H${b.cx} V${b.top}`,
                tip: j === 0 ? { x: b.cx, y: b.top } : null,
              })
            }
          }
        } else {
          next.push({ key: `e${i}`, d: `M${a.cx} ${a.bottom} V${b.top}`, tip: { x: b.cx, y: b.top } })
        }
      }

      setBox({ w: Math.round(cr.width), h: Math.round(cr.height) })
      setEdges(next)
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(container)
    // Node cards can resize without changing the container box (e.g. text wrap);
    // observe the immediate node wrappers too.
    container.querySelectorAll('[data-chain-node]').forEach((n) => ro.observe(n))
    return () => ro.disconnect()
  }, [containerRef, signature])

  if (edges.length === 0 || box.w === 0) return null

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 animate-in fade-in-0 duration-500 motion-reduce:animate-none"
      width={box.w}
      height={box.h}
      viewBox={`0 0 ${box.w} ${box.h}`}
      fill="none"
      preserveAspectRatio="none"
    >
      {edges.map((e) => (
        <path key={e.key} d={e.d} stroke={STROKE} strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {edges.map((e) =>
        e.tip ? (
          <path
            key={`t${e.key}`}
            d={`M${e.tip.x - 3.5} ${e.tip.y - 3.5} ${e.tip.x} ${e.tip.y} ${e.tip.x + 3.5} ${e.tip.y - 3.5}`}
            stroke={STROKE}
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : null
      )}
      {/* origin rings at the top of each connector's upstream node center */}
      {edges.map((e) => {
        const m = /^M([\d.]+) ([\d.]+)/.exec(e.d)
        if (!m) return null
        return <circle key={`o${e.key}`} cx={Number(m[1])} cy={Number(m[2])} r={2.5} fill={RING} stroke={STROKE} strokeWidth={1} />
      })}
    </svg>
  )
}
