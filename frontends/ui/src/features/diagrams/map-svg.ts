/**
 * A map (mindmap) drawn as a file: the tree the answer shows, left to right,
 * on paper.
 *
 * A filed diagram used to be mermaid's render of the source, whatever view the
 * answer showed. For a mindmap that was a different picture from the one on
 * screen, and a worse one: mermaid draws a bare quoted branch WITH its quotes,
 * clips a circle root's label to the circle ("OIB-Rich"), and colours every
 * branch from its own rainbow. The model the view draws (`MapModel`) already
 * has the labels unquoted and the tree in order, so the file is drawn from it.
 *
 * The layout is a tidy tree, which needs no library: leaves are stacked top to
 * bottom in the order the answer wrote them, every parent sits at the middle of
 * its children, and a column per level is as wide as its widest label. The
 * connectors are brackets — out of the parent, down a spine, into each child —
 * so no line crosses a box.
 *
 * Only what `lib/diagrams/svg.ts` keeps is written (`svg`, `g`, `rect`, `path`,
 * `text`, `tspan`, presentation attributes), because the server re-serialises
 * the file through that allow-list and anything else would be refused or lost.
 */

import type { MapModel, MapNode } from './model'

/** The colours a filed drawing is inked in: the paper roles of `diagram-palette.ts`. */
export interface MapInk {
  ink: string
  line: string
  fill: string
}

/** Width of `text` at `size` px and `weight`, in px. */
export type MeasureText = (text: string, size: number, weight: number) => number

const FONT_FAMILY = 'Helvetica, Arial, sans-serif'
const PAD = 16
const COLUMN_GAP = 36
const ROW_GAP = 8
/** Extra room between the root's branches, so each reads as a group. */
const GROUP_GAP = 10
/** Where a connector stops short of a label that has no box. */
const TEXT_GAP = 5
const LINE_HEIGHT = 1.3

/** How each level is set: root, parts, and everything a part covers. */
const LEVELS = [
  { size: 15, weight: 700, maxWidth: 200, boxed: true, padX: 12, padY: 9 },
  { size: 13, weight: 600, maxWidth: 220, boxed: true, padX: 10, padY: 7 },
  { size: 12.5, weight: 400, maxWidth: 240, boxed: false, padX: 0, padY: 3 },
] as const

const levelStyle = (depth: number) => LEVELS[Math.min(depth, LEVELS.length - 1)]!

/** A rough Helvetica width, for where there is no canvas to ask (specs, a server). */
export const estimateTextWidth: MeasureText = (text, size, weight) =>
  text.length * size * (weight >= 600 ? 0.58 : 0.53)

/** The browser's own measurement, through a canvas; the estimate where there is none. */
export function canvasTextMeasure(): MeasureText {
  if (typeof document === 'undefined') return estimateTextWidth
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return estimateTextWidth
  return (text, size, weight) => {
    context.font = `${weight} ${size}px ${FONT_FAMILY}`
    return context.measureText(text).width
  }
}

/** `text` broken into lines no wider than `maxWidth`, at word boundaries. */
function wrap(text: string, maxWidth: number, width: (s: string) => number): string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word
    if (current && width(candidate) > maxWidth) {
      lines.push(current)
      current = word
    } else {
      current = candidate
    }
  }
  if (current) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

interface Placed {
  node: MapNode
  depth: number
  lines: string[]
  width: number
  height: number
  /** Top edge and left edge of the node's box. */
  x: number
  y: number
  children: Placed[]
}

function measureTree(node: MapNode, depth: number, measure: MeasureText): Placed {
  const style = levelStyle(depth)
  const textWidth = (s: string) => measure(s, style.size, style.weight)
  const lines = wrap(node.label, style.maxWidth, textWidth)
  const width = Math.ceil(Math.max(...lines.map(textWidth))) + style.padX * 2
  const height = Math.ceil(lines.length * style.size * LINE_HEIGHT) + style.padY * 2
  const children = node.children.map((child) => measureTree(child, depth + 1, measure))
  return { node, depth, lines, width, height, x: 0, y: 0, children }
}

/** Stack the leaves top to bottom and centre each parent on its children; returns the next free y. */
function placeRows(placed: Placed, top: number): number {
  if (placed.children.length === 0) {
    placed.y = top
    return top + placed.height + ROW_GAP
  }
  let next = top
  for (const [index, child] of placed.children.entries()) {
    if (placed.depth === 0 && index > 0) next += GROUP_GAP
    next = placeRows(child, next)
  }
  const first = placed.children[0]!
  const last = placed.children[placed.children.length - 1]!
  const middle = (first.y + first.height / 2 + last.y + last.height / 2) / 2
  placed.y = middle - placed.height / 2
  // A parent taller than the span of its children pushes what follows down.
  return Math.max(next, placed.y + placed.height + ROW_GAP)
}

const walk = (placed: Placed, visit: (p: Placed) => void): void => {
  visit(placed)
  for (const child of placed.children) walk(child, visit)
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const n = (value: number): string => String(Math.round(value * 10) / 10)

/**
 * The map as a self-contained SVG on paper. Pure: the same model, ink and
 * measurement give the same bytes.
 */
export function mapSvg(
  model: MapModel,
  ink: MapInk,
  measure: MeasureText = estimateTextWidth
): string {
  const tree = measureTree(model.root, 0, measure)

  // One column per level, as wide as the widest node in it.
  const columnWidths: number[] = []
  walk(tree, (p) => {
    columnWidths[p.depth] = Math.max(columnWidths[p.depth] ?? 0, p.width)
  })
  const columnX: number[] = []
  columnWidths.reduce((x, width, depth) => {
    columnX[depth] = x
    return x + width + COLUMN_GAP
  }, PAD)
  walk(tree, (p) => {
    p.x = columnX[p.depth]!
  })

  placeRows(tree, PAD)
  let top = Infinity
  walk(tree, (p) => {
    top = Math.min(top, p.y)
  })
  // A root taller than its subtree can start above the padding; shift all down.
  const shift = top < PAD ? PAD - top : 0
  let bottom = 0
  walk(tree, (p) => {
    p.y += shift
    bottom = Math.max(bottom, p.y + p.height)
  })

  const width = columnX[columnX.length - 1]! + columnWidths[columnWidths.length - 1]! + PAD
  const height = bottom + PAD

  const connectors: string[] = []
  const nodes: string[] = []
  walk(tree, (p) => {
    const style = levelStyle(p.depth)
    const centreY = p.y + p.height / 2
    if (p.children.length > 0) {
      // Out of the parent, to a spine halfway across the gap, into each child.
      const startX = p.x + p.width
      const spineX = columnX[p.depth + 1]! - COLUMN_GAP / 2
      const d = [`M${n(startX)} ${n(centreY)}H${n(spineX)}`]
      for (const child of p.children) {
        const endX = levelStyle(child.depth).boxed ? child.x : child.x - TEXT_GAP
        d.push(`M${n(spineX)} ${n(centreY)}V${n(child.y + child.height / 2)}H${n(endX)}`)
      }
      connectors.push(
        `<path d="${d.join('')}" fill="none" stroke="${ink.line}" stroke-width="1.25"/>`
      )
    }
    if (style.boxed) {
      nodes.push(
        `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.width)}" height="${n(p.height)}" rx="8" ry="8" ` +
          `fill="${ink.fill}" stroke="${p.depth === 0 ? ink.ink : ink.line}" stroke-width="${p.depth === 0 ? 1.5 : 1}"/>`
      )
    }
    const lineHeight = style.size * LINE_HEIGHT
    const firstBaseline = p.y + style.padY + lineHeight / 2
    const tspans = p.lines
      .map(
        (line, index) =>
          `<tspan x="${n(p.x + style.padX)}" y="${n(firstBaseline + index * lineHeight)}">${escapeXml(line)}</tspan>`
      )
      .join('')
    nodes.push(
      `<text font-family="${FONT_FAMILY}" font-size="${style.size}" font-weight="${style.weight}" ` +
        `fill="${ink.ink}" dominant-baseline="central">${tspans}</text>`
    )
  })

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}" height="${n(height)}">` +
    `<g>${connectors.join('')}</g><g>${nodes.join('')}</g></svg>`
  )
}
