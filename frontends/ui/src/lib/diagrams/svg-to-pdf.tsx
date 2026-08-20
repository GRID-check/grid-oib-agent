/**
 * The same diagram, as a PDF, with no browser anywhere.
 *
 * ## Why a PDF at all, when the SVG already previews
 *
 * `image/svg+xml` is in `PREVIEW_TYPES`, so the filed SVG shows in the Files
 * pane today. The PDF is not for looking at — it is for **attaching**. An
 * Einreichung is a bundle of PDFs handed to a Behörde, and an architect who has
 * to convert a file before they can submit it will convert it in whatever tool
 * is open, which is where the marking line stops travelling with the drawing.
 *
 * ## Why `@react-pdf/renderer` and not a headless browser
 *
 * There is no browser in production. `playwright-core` is a devDependency;
 * putting Chromium in the production image is a deployment decision nobody has
 * made, and it would be a large one (image size, a second attack surface, a
 * process to supervise). `@react-pdf/renderer` is ALREADY a production
 * dependency and — verified against the installed 4.6.0 types and against a
 * real `renderToBuffer` run in this Node — ships native `Svg`, `G`, `Defs`,
 * `ClipPath`, `Marker`, `LinearGradient`, `RadialGradient`, `Stop`, `Path`,
 * `Rect`, `Circle`, `Ellipse`, `Line`, `Polyline`, `Polygon`, `Text` and
 * `Tspan`. So the drawing crosses into the PDF as VECTOR primitives, not as a
 * raster of a screenshot: it stays selectable, scalable and diffable, and the
 * conversion needs no DOM.
 *
 * The cost of that choice is this file. `@react-pdf/renderer` does not accept
 * SVG markup — it accepts its own components — so the parsed tree has to be
 * walked and mapped. That walk is also the second reason the tree exists: the
 * elements this file can draw are exactly the elements `svg.ts` admits, and
 * when they disagree the disagreement is a missing branch here rather than a
 * silently blank region in a submitted document.
 *
 * ## What is deliberately lost
 *
 *   - **Typefaces.** `@react-pdf/renderer` knows the fourteen standard PDF
 *     fonts and nothing else; registering a webfont means shipping a font file
 *     and a licence with the image. Every `font-family` therefore lands on
 *     Helvetica, varying only weight and slant. A diagram whose meaning depends
 *     on its typeface is not a diagram this pipeline is for.
 *   - **CSS.** There is none to lose: `svg.ts` refuses the `<style>` element
 *     outright and flattens the `style` attribute into presentation attributes,
 *     so everything that paints arrives as an attribute. That is the ONLY
 *     reason this file can be a pure attribute mapper, and it is why the
 *     refusal is in the validator rather than here.
 */

import React from 'react'
import {
  Circle,
  ClipPath,
  Defs,
  Document,
  Ellipse,
  G,
  Line,
  LinearGradient,
  Page,
  Path,
  Polygon,
  Polyline,
  RadialGradient,
  Rect,
  Stop,
  Svg,
  Text,
  Tspan,
  View,
  renderToBuffer,
} from '@react-pdf/renderer'
import { attributeOf, type DiagramSvgViewport, type SvgElement, type SvgNode } from './svg'

/**
 * The presentation props every drawable shares, taken from the component's own
 * type rather than restated. `Pick` on `ComponentProps` means a future
 * `@react-pdf/renderer` that renames one of these breaks the build here instead
 * of silently dropping the paint from a submitted drawing.
 */
type Presentation = Pick<
  React.ComponentProps<typeof Path>,
  | 'fill'
  | 'stroke'
  | 'strokeWidth'
  | 'strokeDasharray'
  | 'strokeLinecap'
  | 'strokeLinejoin'
  | 'strokeOpacity'
  | 'fillOpacity'
  | 'fillRule'
  | 'opacity'
  | 'color'
  | 'visibility'
  | 'transform'
  | 'clipPath'
  | 'markerStart'
  | 'markerMid'
  | 'markerEnd'
  | 'textAnchor'
  | 'dominantBaseline'
>

/** A closed set is a closed set: a value outside it is dropped, never coerced. */
function oneOf<T extends string>(allowed: readonly T[], value: string | undefined): T | undefined {
  return allowed.find((member) => member === value)
}

const FILL_RULES = ['nonzero', 'evenodd'] as const
const LINECAPS = ['butt', 'round', 'square'] as const
const LINEJOINS = ['butt', 'round', 'square', 'miter', 'bevel'] as const
const TEXT_ANCHORS = ['start', 'middle', 'end'] as const
const BASELINES = [
  'auto',
  'middle',
  'central',
  'hanging',
  'mathematical',
  'text-after-edge',
  'text-before-edge',
] as const
const VISIBILITIES = ['visible', 'hidden', 'collapse'] as const

/**
 * A dash pattern pdfkit will accept, or nothing.
 *
 * Two shapes reach here from a browser and neither is usable as written.
 * `getComputedStyle` answers in pixels — `stroke-dasharray: 1px, 0px` — and
 * pdfkit parses `1px` to `null` and then throws *"lengths must be numeric and
 * greater than zero"*, which takes the whole PDF down over an edge style. And
 * a pattern containing a zero is how a browser spells "solid" for an element
 * whose dash was never set; drawing it is not merely wrong, it is refused.
 *
 * So: strip units, and treat anything that is not a run of positive lengths as
 * no dash at all. Found against real mermaid output, which emits both.
 */
function dashArrayOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const lengths = raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((part) => Number.parseFloat(part.replace(/px$/i, '')))
  if (lengths.length === 0) return undefined
  if (!lengths.every((length) => Number.isFinite(length) && length > 0)) return undefined
  return lengths.join(' ')
}

function presentationOf(element: SvgElement): Presentation {
  const at = (name: string) => attributeOf(element, name)
  return {
    fill: at('fill'),
    stroke: at('stroke'),
    strokeWidth: at('stroke-width'),
    strokeDasharray: dashArrayOf(at('stroke-dasharray')),
    strokeLinecap: oneOf(LINECAPS, at('stroke-linecap')),
    strokeLinejoin: oneOf(LINEJOINS, at('stroke-linejoin')),
    strokeOpacity: at('stroke-opacity'),
    fillOpacity: at('fill-opacity'),
    fillRule: oneOf(FILL_RULES, at('fill-rule')),
    opacity: at('opacity'),
    color: at('color'),
    visibility: oneOf(VISIBILITIES, at('visibility')),
    transform: at('transform'),
    clipPath: at('clip-path'),
    markerStart: at('marker-start'),
    markerMid: at('marker-mid'),
    markerEnd: at('marker-end'),
    textAnchor: oneOf(TEXT_ANCHORS, at('text-anchor')),
    dominantBaseline: oneOf(BASELINES, at('dominant-baseline')),
  }
}

/**
 * Font facts carried down a `<G style>` rather than set on the `<Text>`.
 *
 * `@react-pdf/renderer` types an SVG `<Text>`'s `style` as
 * `SVGPresentationAttributes`, which has no font properties, while a `<G>`'s
 * `style` is the full `Style` — and the runtime inherits font settings from the
 * group. Verified by rendering both and reading the content stream: a
 * `<G style={{fontSize: 19}}>` around a `<Text>` emits `/F1 19 Tf`.
 *
 * So the wrapper group is not decoration. It is how a per-text font size
 * reaches the PDF WITHOUT a cast — the alternative was one `as unknown as` at
 * this boundary, and a group node costs less than a hole in the types. The
 * style type is taken from `<G>` itself for the same reason `Presentation` is
 * taken from `<Path>`: restating it is how it drifts.
 */
type FontStyle = React.ComponentProps<typeof G>['style']

/**
 * Every `font-family` becomes Helvetica; weight and slant pick the face.
 *
 * The fourteen standard PDF fonts are the only ones available without shipping
 * a font file (see the header). Mermaid asks for `"trebuchet ms", verdana,
 * arial, sans-serif`, and asking `@react-pdf/renderer` for any of those throws
 * at render time — so a diagram would fail to become a PDF over a typeface.
 * Choosing the face here rather than failing is the right trade for a drawing
 * whose meaning is in its geometry.
 */
function fontStyleOf(element: SvgElement): FontStyle {
  const weight = (attributeOf(element, 'font-weight') ?? '').toLowerCase()
  const slant = (attributeOf(element, 'font-style') ?? '').toLowerCase()
  const bold = weight === 'bold' || weight === 'bolder' || Number.parseInt(weight, 10) >= 600
  const italic = slant === 'italic' || slant === 'oblique'
  const family = bold
    ? italic
      ? 'Helvetica-BoldOblique'
      : 'Helvetica-Bold'
    : italic
      ? 'Helvetica-Oblique'
      : 'Helvetica'
  const size = Number.parseFloat((attributeOf(element, 'font-size') ?? '').replace(/px$/i, ''))
  return { fontFamily: family, fontSize: Number.isFinite(size) && size > 0 ? size : undefined }
}

/** The text a `<text>`/`<tspan>` prints, with element children flattened out. */
function textOf(node: SvgNode): string {
  if (node.kind === 'text') return node.text
  return node.children.map(textOf).join('')
}

function numeric(element: SvgElement, name: string): number | undefined {
  const raw = attributeOf(element, name)
  if (raw === undefined) return undefined
  const value = Number.parseFloat(raw.replace(/px$/i, ''))
  return Number.isFinite(value) ? value : undefined
}

/**
 * The arrowheads, drawn here because the library will not draw them.
 *
 * A process flow without arrowheads is not a smaller drawing, it is a different
 * claim: „A → B" and „A — B" say different things, and the PDF is the artifact
 * that gets attached to an Einreichung. So the head is computed from the edge
 * itself rather than left to a `<marker>` reference nothing resolves.
 *
 * The tangent is exact for the two commands that matter. The last coordinate
 * pair of a `d` is the endpoint, and the pair before it is either the previous
 * `L` vertex or a cubic's second control point — and the tangent of a cubic at
 * its end IS the direction from that control point to the endpoint. A path
 * using any other command bails and gets no head, because a head pointing the
 * wrong way is worse than none on a drawing somebody signs.
 */
const SUPPORTED_PATH_COMMANDS = /^[MLCmlc0-9.,\s+-]*$/
const ARROW_LENGTH = 9
const ARROW_HALF_WIDTH = 4

interface Point {
  x: number
  y: number
}

function coordinatePairs(numbers: number[]): Point[] {
  const points: Point[] = []
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index], y: numbers[index + 1] })
  }
  return points
}

function edgePoints(element: SvgElement): Point[] | null {
  const numbersIn = (raw: string) => (raw.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) ?? []).map(Number)
  if (element.name === 'path') {
    const d = attributeOf(element, 'd')
    if (!d || !SUPPORTED_PATH_COMMANDS.test(d)) return null
    return coordinatePairs(numbersIn(d))
  }
  if (element.name === 'line') {
    const values = ['x1', 'y1', 'x2', 'y2'].map((name) => numeric(element, name))
    if (values.some((value) => value === undefined)) return null
    return coordinatePairs(values as number[])
  }
  if (element.name === 'polyline') {
    const points = attributeOf(element, 'points')
    return points ? coordinatePairs(numbersIn(points)) : null
  }
  return null
}

/**
 * A filled triangle at the end (or the start) of an edge, or `null`.
 *
 * Sized in user units rather than in stroke widths: mermaid's own arrowheads
 * declare `markerUnits="userSpaceOnUse"`, so a hairline edge still gets a head
 * a reader can see on paper.
 */
function arrowheadFor(element: SvgElement, at: 'start' | 'end', key: number): React.ReactNode {
  if (!attributeOf(element, at === 'end' ? 'marker-end' : 'marker-start')) return null
  const points = edgePoints(element)
  if (!points || points.length < 2) return null

  const tip = at === 'end' ? points[points.length - 1] : points[0]
  const from = at === 'end' ? points[points.length - 2] : points[1]
  const dx = tip.x - from.x
  const dy = tip.y - from.y
  const length = Math.hypot(dx, dy)
  // Two coincident points carry no direction; a head would be a dot.
  if (!Number.isFinite(length) || length < 0.01) return null

  const ux = dx / length
  const uy = dy / length
  const baseX = tip.x - ux * ARROW_LENGTH
  const baseY = tip.y - uy * ARROW_LENGTH
  const points2 = [
    `${tip.x},${tip.y}`,
    `${baseX - uy * ARROW_HALF_WIDTH},${baseY + ux * ARROW_HALF_WIDTH}`,
    `${baseX + uy * ARROW_HALF_WIDTH},${baseY - ux * ARROW_HALF_WIDTH}`,
  ].join(' ')

  // The head is the LINE's colour, not its fill: an edge is stroked and
  // unfilled, so reading `fill` here would paint every arrowhead invisible.
  return <Polygon key={`${key}-${at}`} points={points2} fill={attributeOf(element, 'stroke') ?? '#000'} />
}

/**
 * Map one node, or `null` when it cannot be drawn.
 *
 * Returning `null` — rather than throwing — for an element missing the geometry
 * its component requires is deliberate: `<rect>` with no width is a rectangle
 * with no area, and refusing the whole PDF over one is worse than a drawing
 * that is missing something that was never visible. `<title>`, `<desc>` and
 * `<metadata>` return `null` for the same reason from the other direction: they
 * carry no paint, and `<metadata>` in particular carries the diagram source,
 * which belongs in the SVG and not printed across the page.
 */
function toPdfNode(node: SvgNode, key: number): React.ReactNode {
  if (node.kind === 'text') return null
  const element = node
  const style = presentationOf(element)
  const children = element.children.map((child, index) => toPdfNode(child, index))

  switch (element.name) {
    case 'g':
      return (
        <G key={key} {...style}>
          {children}
        </G>
      )
    case 'defs':
      return <Defs key={key}>{children}</Defs>
    case 'clipPath':
      return (
        <ClipPath key={key} id={attributeOf(element, 'id')}>
          {children}
        </ClipPath>
      )
    case 'marker':
      // NOT rendered, and not an oversight — see `arrowheadFor`.
      // `@react-pdf/renderer` exports a `Marker` component whose renderer wants
      // `markerEnd` to be a marker NODE; an SVG string carries `url(#id)`, and
      // nothing in the library resolves one to the other. A `<Marker>` reaching
      // the tree is therefore drawn as a top-level shape and warns *"SVG node
      // of type MARKER is not currently supported"* twelve times per flowchart.
      return null
    case 'linearGradient': {
      const id = attributeOf(element, 'id')
      if (!id) return null
      return (
        <LinearGradient
          key={key}
          id={id}
          x1={attributeOf(element, 'x1')}
          y1={attributeOf(element, 'y1')}
          x2={attributeOf(element, 'x2')}
          y2={attributeOf(element, 'y2')}
          gradientTransform={attributeOf(element, 'gradientTransform')}
          gradientUnits={oneOf(
            ['userSpaceOnUse', 'objectBoundingBox'] as const,
            attributeOf(element, 'gradientUnits'),
          )}
        >
          {children}
        </LinearGradient>
      )
    }
    case 'radialGradient': {
      const id = attributeOf(element, 'id')
      if (!id) return null
      return (
        <RadialGradient
          key={key}
          id={id}
          cx={attributeOf(element, 'cx')}
          cy={attributeOf(element, 'cy')}
          r={attributeOf(element, 'r')}
          fx={attributeOf(element, 'fx')}
          fy={attributeOf(element, 'fy')}
          gradientTransform={attributeOf(element, 'gradientTransform')}
          gradientUnits={oneOf(
            ['userSpaceOnUse', 'objectBoundingBox'] as const,
            attributeOf(element, 'gradientUnits'),
          )}
        >
          {children}
        </RadialGradient>
      )
    }
    case 'stop': {
      const offset = attributeOf(element, 'offset')
      const stopColor = attributeOf(element, 'stop-color')
      if (offset === undefined || stopColor === undefined) return null
      return (
        <Stop key={key} offset={offset} stopColor={stopColor} stopOpacity={attributeOf(element, 'stop-opacity')} />
      )
    }
    case 'path': {
      const d = attributeOf(element, 'd')
      return d ? withArrowheads(element, key, <Path key={key} {...style} d={d} />) : null
    }
    case 'rect': {
      const width = attributeOf(element, 'width')
      const height = attributeOf(element, 'height')
      if (width === undefined || height === undefined) return null
      return (
        <Rect
          key={key}
          {...style}
          x={attributeOf(element, 'x')}
          y={attributeOf(element, 'y')}
          width={width}
          height={height}
          rx={attributeOf(element, 'rx')}
          ry={attributeOf(element, 'ry')}
        />
      )
    }
    case 'circle': {
      const r = attributeOf(element, 'r')
      if (r === undefined) return null
      return <Circle key={key} {...style} cx={attributeOf(element, 'cx')} cy={attributeOf(element, 'cy')} r={r} />
    }
    case 'ellipse': {
      const rx = attributeOf(element, 'rx')
      const ry = attributeOf(element, 'ry')
      if (rx === undefined || ry === undefined) return null
      return (
        <Ellipse key={key} {...style} cx={attributeOf(element, 'cx')} cy={attributeOf(element, 'cy')} rx={rx} ry={ry} />
      )
    }
    case 'line': {
      const x1 = attributeOf(element, 'x1')
      const y1 = attributeOf(element, 'y1')
      const x2 = attributeOf(element, 'x2')
      const y2 = attributeOf(element, 'y2')
      if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return null
      return withArrowheads(element, key, <Line key={key} {...style} x1={x1} y1={y1} x2={x2} y2={y2} />)
    }
    case 'polyline': {
      const points = attributeOf(element, 'points')
      return points ? withArrowheads(element, key, <Polyline key={key} {...style} points={points} />) : null
    }
    case 'polygon': {
      const points = attributeOf(element, 'points')
      return points ? <Polygon key={key} {...style} points={points} /> : null
    }
    case 'text': {
      // SVG's own default for both is 0, and mermaid relies on it: a node label
      // is a `<text>` with NO x or y inside a `<g transform="translate(...)">`.
      // Requiring them dropped every label in a flowchart and left the boxes
      // empty — a PDF that looks like a diagram and says nothing.
      const x = attributeOf(element, 'x') ?? 0
      const y = attributeOf(element, 'y') ?? 0
      const nested = element.children.filter(
        (child): child is SvgElement => child.kind === 'element' && child.name === 'tspan',
      )
      return (
        <G key={key} style={fontStyleOf(element)}>
          <Text {...style} x={x} y={y}>
            {nested.length > 0 ? nested.map((child, index) => toPdfNode(child, index)) : textOf(element)}
          </Text>
        </G>
      )
    }
    case 'tspan':
      return (
        <Tspan key={key} x={attributeOf(element, 'x')} y={attributeOf(element, 'y')} {...style}>
          {textOf(element)}
        </Tspan>
      )
    default:
      // `svg` (handled by the caller), `title`, `desc`, `metadata` — and any
      // element `svg.ts` starts admitting without a branch here, which is the
      // failure this default is here to keep visible rather than silent.
      return null
  }
}

/** The edge, then whichever heads it asked for. */
function withArrowheads(element: SvgElement, key: number, edge: React.ReactNode): React.ReactNode {
  const start = arrowheadFor(element, 'start', key)
  const end = arrowheadFor(element, 'end', key)
  if (!start && !end) return edge
  return (
    <React.Fragment key={key}>
      {edge}
      {start}
      {end}
    </React.Fragment>
  )
}

/** A4 in PostScript points, the unit `@react-pdf/renderer` lays out in. */
const A4_SHORT = 595.28
const A4_LONG = 841.89
const MARGIN = 36
const HEADER_HEIGHT = 54
const FOOTER_HEIGHT = 28

export interface DiagramPdfInput {
  readonly root: SvgElement
  readonly viewport: DiagramSvgViewport
  readonly title: string
  readonly projectName: string
  /**
   * The provenance line, already in the reader's locale.
   *
   * Passed in rather than looked up here for the reason `answer-export` gives
   * about the same problem: this module runs on a request whose locale the
   * caller resolved, and a renderer that reaches for a dictionary is a renderer
   * that renders German for a Viennese office and German for a Brussels one.
   */
  readonly marking: string
  readonly createdAt: Date
}

/**
 * One page, one diagram, fitted.
 *
 * Orientation follows the drawing, because a wide flowchart rotated onto a
 * portrait page is the same drawing at half the size, and the whole reason this
 * artifact exists is that somebody has to read it on paper.
 */
export async function renderDiagramPdf(input: DiagramPdfInput): Promise<Uint8Array> {
  const landscape = input.viewport.width > input.viewport.height
  const pageWidth = landscape ? A4_LONG : A4_SHORT
  const pageHeight = landscape ? A4_SHORT : A4_LONG
  const boxWidth = pageWidth - MARGIN * 2
  const boxHeight = pageHeight - MARGIN * 2 - HEADER_HEIGHT - FOOTER_HEIGHT

  // Fit inside the box, never up-scale past it. `preserveAspectRatio` on the
  // <Svg> would do the fitting, but the box has to be sized for the caption
  // rows either way, so the arithmetic is here where both can see it.
  const scale = Math.min(boxWidth / input.viewport.width, boxHeight / input.viewport.height)
  const drawnWidth = input.viewport.width * scale
  const drawnHeight = input.viewport.height * scale

  const created = input.createdAt.toISOString().slice(0, 10)

  const document = (
    <Document title={input.title} author={input.projectName} creator="Grid" producer="Grid">
      <Page size={landscape ? { width: pageWidth, height: pageHeight } : 'A4'} style={{ padding: MARGIN }}>
        <View style={{ height: HEADER_HEIGHT }}>
          <Text style={{ fontFamily: 'Helvetica-Bold', fontSize: 14 }}>{input.title}</Text>
          <Text style={{ fontFamily: 'Helvetica', fontSize: 9, color: '#4b5563', marginTop: 4 }}>
            {input.projectName} · {created}
          </Text>
        </View>
        <View style={{ height: boxHeight, alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={drawnWidth} height={drawnHeight} viewBox={input.viewport.viewBox}>
            {input.root.children.map((child, index) => toPdfNode(child, index))}
          </Svg>
        </View>
        {/*
          The marking is the artifact, not the chrome. The grey byline in the
          Files pane stays in the app; this line is what reaches the Behörde,
          which is where liability starts — the same argument the `.docx`
          export makes for its first-page block.
        */}
        <View style={{ height: FOOTER_HEIGHT, justifyContent: 'flex-end' }}>
          <Text style={{ fontFamily: 'Helvetica', fontSize: 8, color: '#6b7280' }}>{input.marking}</Text>
        </View>
      </Page>
    </Document>
  )

  return new Uint8Array(await renderToBuffer(document))
}
