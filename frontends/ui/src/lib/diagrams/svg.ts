/**
 * Reading an SVG that arrived from a browser, and writing back one we made.
 *
 * ## Why bytes from a client are parsed rather than trusted
 *
 * Diagrams are laid out in the BROWSER and filed by the BFF. That split is
 * forced: mermaid and excalidraw both need a DOM to lay out a graph, and there
 * is no browser in this deployment — `playwright-core` is a devDependency and
 * putting Chromium into the production image is a deployment decision nobody
 * has made. So the client produces the SVG and the server admits it.
 *
 * The trust posture is the same one every upload already has: an authenticated
 * user's browser sent bytes, and the server stores them under that user's
 * authority. Saying so explicitly matters because it is easy to read "the
 * client rendered it" as "the server rendered it", and they are not the same
 * claim — nothing here can assert the SVG is a faithful drawing of the source
 * text beside it. What it CAN assert is that the file is inert.
 *
 * That assertion is worth making twice, because a stored SVG is served back to
 * browsers: an unvalidated one is stored XSS with a `documents` row and a
 * preview pane. So this module does both halves:
 *
 *   1. **Reject**, by name, anything a diagram has no business containing —
 *      `<script>`, `<foreignObject>`, `<style>`, `on*` handlers, and any
 *      reference that points outside the file. Named, because a caller and a
 *      test both need to know WHICH rule refused, and because a client that
 *      gets `unsupported-element` back can fix its renderer config.
 *   2. **Re-serialise from the parsed tree**, so what is stored is written by
 *      this file out of an allow-list, not copied from the request. Rule 1 is
 *      a deny-list and deny-lists are only ever as complete as the day they
 *      were written; rule 2 is what holds when rule 1 has a gap. Neither is
 *      redundant: without (1) a broken client fails silently and half-drawn,
 *      without (2) a spelling nobody thought of reaches the file.
 *   3. **Write the marking into what it serialises**, because this module is
 *      the only thing that produces the bytes a `.svg` is stored as, and a
 *      machine-drawn file that leaves the product has to say so in its own
 *      bytes — see {@link withDiagramMarking}.
 *
 * ## Why there is no XML library here
 *
 * There is no DOMParser in the Node runtime this route executes in, and adding
 * a parser dependency to read a file format we are about to narrow to twenty
 * elements is the wrong trade — a general parser's job is to accept, and this
 * one's job is to refuse. The scanner below therefore refuses everything it
 * does not explicitly understand, including DOCTYPE and entity declarations,
 * which is also what makes XXE and billion-laughs unrepresentable rather than
 * mitigated: there is no construct to declare an entity with.
 *
 * ## Why `<style>` is refused rather than sanitised
 *
 * A CSS parser would be a second place external references can hide (`@import`,
 * `url()`, `image-set()`), and the server would have to become a CSS engine to
 * know whether a rule is safe. It also would not help the PDF, which cannot
 * apply CSS at all. So the producer flattens computed styles onto presentation
 * attributes before it posts — `src/features/diagrams/render-mermaid.ts` — and
 * a `<style>` block arriving here means the producer skipped that step. Failing
 * loudly at that point is the whole value: the alternative is a filed diagram
 * that renders correctly in the preview pane and blank in the PDF.
 */

import {
  DIAGRAM_SOURCE_FACTS,
  MAX_DIAGRAM_SVG_BYTES,
  MAX_DIAGRAM_SVG_DEPTH,
  type DiagramSourceKind,
} from './diagram-sources'

/**
 * Every way a submitted diagram can be refused.
 *
 * A tuple for the same reason the vocabularies are: the route maps these to a
 * message in both locales, and a member that exists in one place and not the
 * other is how a user ends up reading `undefined`.
 */
export const DIAGRAM_SVG_REJECTIONS = [
  'empty',
  'too-large',
  'malformed-xml',
  'doctype-or-entity',
  'not-svg',
  'missing-viewport',
  'script-element',
  'foreign-object',
  'style-element',
  'unsupported-element',
  'event-handler-attribute',
  'external-reference',
  'source-too-large',
  'too-deep',
] as const
export type DiagramSvgRejection = (typeof DIAGRAM_SVG_REJECTIONS)[number]

export interface SvgAttribute {
  readonly name: string
  readonly value: string
}

export interface SvgElement {
  readonly kind: 'element'
  readonly name: string
  /** In source order, so serialisation is deterministic and diffable. */
  readonly attributes: readonly SvgAttribute[]
  readonly children: readonly SvgNode[]
}

export interface SvgTextNode {
  readonly kind: 'text'
  readonly text: string
}

export type SvgNode = SvgElement | SvgTextNode

export class DiagramSvgError extends Error {
  constructor(
    readonly rejection: DiagramSvgRejection,
    /** What exactly tripped it — an element or attribute name, never the input. */
    readonly detail: string,
  ) {
    super(`${rejection}: ${detail}`)
    this.name = 'DiagramSvgError'
  }
}

// ---------------------------------------------------------------------------
// What may appear
// ---------------------------------------------------------------------------

/**
 * Elements refused BY NAME, case-insensitively, ahead of the allow-list.
 *
 * They would all fall through to `unsupported-element` anyway — the allow-list
 * is what actually stops them. They are named here so the refusal a client
 * reads says what it found, and so that a test asserting "a `<script>` is
 * rejected" is asserting the rule rather than an accident of the allow-list.
 *
 * Case-insensitive because the XML parser here is case-SENSITIVE (`clipPath`
 * and `clippath` are different elements to XML) while a browser recovering from
 * a content-type sniff is not. Matching loosely here costs nothing and closes
 * the gap between the two readings.
 */
const REFUSED_ELEMENTS: ReadonlyMap<string, DiagramSvgRejection> = new Map([
  ['script', 'script-element'],
  ['foreignobject', 'foreign-object'],
  ['style', 'style-element'],
])

/**
 * What any element may carry: the presentation set, plus `id`.
 *
 * Deliberately the intersection of "SVG paints with it" and "either the preview
 * or `@react-pdf/renderer` can act on it". An attribute nothing downstream
 * reads is bytes in a stored file whose effect no reader will ever see.
 *
 * `id` is in here because it is not decoration in a self-contained file: it is
 * the target of every `url(#…)` a marker, a gradient or a clip path resolves
 * through. Dropping it would strip the arrowheads off a flowchart.
 */
const COMMON_ATTRIBUTES: ReadonlySet<string> = new Set([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'opacity',
  'color',
  'visibility',
  'transform',
  'clip-path',
  'marker-start',
  'marker-mid',
  'marker-end',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'letter-spacing',
  'word-spacing',
  'id',
])

/**
 * The geometry each element is allowed to state, on top of the presentation set.
 *
 * Membership of this map IS the element allow-list: an element with no entry is
 * refused. Keeping the two facts in one table is deliberate — an allow-list and
 * an attribute table that live apart drift, and the drift direction is always
 * "element allowed, attributes forgotten", which silently strips geometry.
 */
const ELEMENT_GEOMETRY: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['svg', new Set(['xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio'])],
  ['g', new Set<string>()],
  ['defs', new Set<string>()],
  ['title', new Set<string>()],
  ['desc', new Set<string>()],
  ['path', new Set(['d'])],
  ['rect', new Set(['x', 'y', 'width', 'height', 'rx', 'ry'])],
  ['circle', new Set(['cx', 'cy', 'r'])],
  ['ellipse', new Set(['cx', 'cy', 'rx', 'ry'])],
  ['line', new Set(['x1', 'y1', 'x2', 'y2'])],
  ['polyline', new Set(['points'])],
  ['polygon', new Set(['points'])],
  ['text', new Set(['x', 'y', 'dx', 'dy'])],
  ['tspan', new Set(['x', 'y', 'dx', 'dy'])],
  ['clipPath', new Set(['clipPathUnits'])],
  [
    'marker',
    new Set([
      'markerWidth',
      'markerHeight',
      'refX',
      'refY',
      'orient',
      'markerUnits',
      'viewBox',
      'preserveAspectRatio',
    ]),
  ],
  ['linearGradient', new Set(['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform'])],
  ['radialGradient', new Set(['cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits', 'gradientTransform'])],
  ['stop', new Set(['offset', 'stop-color', 'stop-opacity'])],
  // Accepted from a client so that a submission carrying one is not REFUSED —
  // it is discarded and replaced by `withDiagramSource`, because the source
  // recorded in a filed diagram must be the one the server validated against
  // its own cap and not a second copy the client could make disagree with it.
  // Its attributes are handled separately in `keptAttributes`.
  //
  // **Only as a direct child of the root**, which is the one position this
  // module ever writes one in — see {@link refuseUnsupportedElements}. Membership
  // of this map alone used to mean "at any depth", and `withDiagramSource`
  // filters only the ROOT's children, so a `<g><metadata
  // data-grid-diagram-source="mermaid">…` carried 200 KiB of client text into a
  // stored file against a 32 KiB source cap the server thought it had enforced.
  ['metadata', new Set<string>()],
])

/**
 * The element that carries the diagram's own source, written by this module
 * and never accepted from a client — see {@link withDiagramSource}.
 */
const METADATA_ELEMENT = 'metadata'
const METADATA_KIND_ATTRIBUTE = 'data-grid-diagram-source'

/**
 * The two elements that carry the AI marking — see {@link withDiagramMarking}.
 *
 * They are already in {@link ELEMENT_GEOMETRY} with no attributes of their own,
 * which is the whole reason they were chosen: the marking survives the
 * re-serialisation without widening the allow-list by one element or one
 * attribute, on a file this product serves back to browsers.
 */
const MARKING_TITLE_ELEMENT = 'title'
const MARKING_DESC_ELEMENT = 'desc'

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_.:-]/

class Scanner {
  private index = 0

  constructor(private readonly input: string) {}

  get done(): boolean {
    return this.index >= this.input.length
  }

  peek(offset = 0): string {
    return this.input[this.index + offset] ?? ''
  }

  startsWith(text: string): boolean {
    return this.input.startsWith(text, this.index)
  }

  take(count: number): string {
    const slice = this.input.slice(this.index, this.index + count)
    this.index += count
    return slice
  }

  expect(text: string, detail: string): void {
    if (!this.startsWith(text)) throw new DiagramSvgError('malformed-xml', detail)
    this.index += text.length
  }

  skipWhitespace(): void {
    while (!this.done && /\s/.test(this.peek())) this.index += 1
  }

  /** Read up to (not past) `terminator`; throws rather than running off the end. */
  readUntil(terminator: string, detail: string): string {
    const at = this.input.indexOf(terminator, this.index)
    if (at === -1) throw new DiagramSvgError('malformed-xml', detail)
    const slice = this.input.slice(this.index, at)
    this.index = at
    return slice
  }

  readName(detail: string): string {
    if (!NAME_START.test(this.peek())) throw new DiagramSvgError('malformed-xml', detail)
    let name = ''
    while (!this.done && NAME_CHAR.test(this.peek())) name += this.take(1)
    return name
  }
}

/**
 * The five named entities XML defines, plus numeric references.
 *
 * Nothing else resolves, and there is no way to declare anything else, because
 * `<!` is refused wherever it can appear. An unknown `&name;` is therefore not
 * a lookup failure — it is a document this parser cannot claim to understand,
 * and claiming to understand it is how a sanitiser gets bypassed.
 */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
])

function decodeEntities(raw: string, detail: string): string {
  return raw.replace(/&([^;\s]*);?/g, (match, body: string) => {
    if (!match.endsWith(';')) throw new DiagramSvgError('malformed-xml', `${detail}: bare ampersand`)
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const digits = isHex ? body.slice(2) : body.slice(1)
      if (!digits || !/^[0-9a-fA-F]+$/.test(digits)) {
        throw new DiagramSvgError('malformed-xml', `${detail}: bad numeric reference`)
      }
      const code = Number.parseInt(digits, isHex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
        throw new DiagramSvgError('malformed-xml', `${detail}: numeric reference out of range`)
      }
      return String.fromCodePoint(code)
    }
    const named = NAMED_ENTITIES.get(body)
    if (named === undefined) throw new DiagramSvgError('malformed-xml', `${detail}: unknown entity &${body};`)
    return named
  })
}

/** `<!-- … -->` is skipped; every other `<!` construct is refused. */
function skipTrivia(scanner: Scanner): void {
  for (;;) {
    scanner.skipWhitespace()
    if (scanner.startsWith('<!--')) {
      scanner.take(4)
      scanner.readUntil('-->', 'unterminated comment')
      scanner.take(3)
      continue
    }
    if (scanner.startsWith('<!')) {
      // `<!DOCTYPE`, `<!ENTITY`, `<![CDATA[` — the first two are how an XML
      // document declares its own expansions, which is the whole of XXE and
      // billion-laughs. CDATA is refused with them rather than supported,
      // because a renderer that emits CDATA is emitting something this
      // pipeline has no element for anyway.
      throw new DiagramSvgError('doctype-or-entity', scanner.take(10))
    }
    if (scanner.startsWith('<?')) {
      // The XML declaration is legal only at the very start, which
      // `parseDiagramSvg` handles; anywhere else a processing instruction is
      // an instruction to a processor we do not have.
      throw new DiagramSvgError('malformed-xml', 'processing instruction')
    }
    return
  }
}

function parseAttributeValue(scanner: Scanner, elementName: string, attributeName: string): string {
  const quote = scanner.peek()
  if (quote !== '"' && quote !== "'") {
    throw new DiagramSvgError('malformed-xml', `${elementName}/@${attributeName}: unquoted value`)
  }
  scanner.take(1)
  const raw = scanner.readUntil(quote, `${elementName}/@${attributeName}: unterminated value`)
  scanner.take(1)
  if (raw.includes('<')) {
    throw new DiagramSvgError('malformed-xml', `${elementName}/@${attributeName}: '<' in value`)
  }
  return decodeEntities(raw, `${elementName}/@${attributeName}`)
}

/**
 * Read one element and everything inside it.
 *
 * `depth` is what stops a hostile input here rather than in the runtime: this
 * function recurses once per level of nesting, and so do the three walks after
 * it, so a document that is trivially small in BYTES can still exhaust the
 * stack. Depth 5000 is ~35 KB — 3% of the 1 MiB budget — and threw a bare
 * `RangeError`, which is not a `DiagramSvgError` and therefore reached the route
 * as an untranslated 500 on a request the caller was promised a named 400 for.
 * See {@link MAX_DIAGRAM_SVG_DEPTH} for the measurement behind the number.
 *
 * The check is BEFORE the recursion and before any work on the child, because
 * the point is to not do the work.
 */
function parseElement(scanner: Scanner, depth: number): SvgElement {
  if (depth > MAX_DIAGRAM_SVG_DEPTH) {
    throw new DiagramSvgError('too-deep', `nested deeper than ${MAX_DIAGRAM_SVG_DEPTH}`)
  }
  scanner.expect('<', 'expected an element')
  const name = scanner.readName('expected an element name')

  const refused = REFUSED_ELEMENTS.get(name.toLowerCase())
  if (refused) throw new DiagramSvgError(refused, name)

  const attributes: SvgAttribute[] = []
  const seen = new Set<string>()
  for (;;) {
    scanner.skipWhitespace()
    if (scanner.startsWith('/>')) {
      scanner.take(2)
      return { kind: 'element', name, attributes, children: [] }
    }
    if (scanner.startsWith('>')) {
      scanner.take(1)
      break
    }
    const attributeName = scanner.readName(`${name}: expected an attribute name`)
    if (seen.has(attributeName)) {
      throw new DiagramSvgError('malformed-xml', `${name}/@${attributeName}: duplicate attribute`)
    }
    seen.add(attributeName)
    scanner.skipWhitespace()
    scanner.expect('=', `${name}/@${attributeName}: expected '='`)
    scanner.skipWhitespace()
    const value = parseAttributeValue(scanner, name, attributeName)
    refuseDangerousAttribute(name, attributeName, value)
    if (attributeName === 'style') attributes.push(...flattenStyleAttribute(name, value))
    else attributes.push({ name: attributeName, value })
  }

  const children: SvgNode[] = []
  for (;;) {
    if (scanner.done) throw new DiagramSvgError('malformed-xml', `${name}: unclosed element`)
    if (scanner.startsWith('</')) {
      scanner.take(2)
      const closing = scanner.readName(`${name}: expected a closing tag name`)
      if (closing !== name) {
        throw new DiagramSvgError('malformed-xml', `${name}: closed by </${closing}>`)
      }
      scanner.skipWhitespace()
      scanner.expect('>', `${name}: unterminated closing tag`)
      return { kind: 'element', name, attributes, children }
    }
    if (scanner.startsWith('<!--')) {
      skipTrivia(scanner)
      continue
    }
    if (scanner.startsWith('<!') || scanner.startsWith('<?')) {
      skipTrivia(scanner)
      continue
    }
    if (scanner.startsWith('<')) {
      children.push(parseElement(scanner, depth + 1))
      continue
    }
    const raw = scanner.readUntil('<', `${name}: unclosed element`)
    const text = decodeEntities(raw, `${name}: text`)
    if (text.length > 0) children.push({ kind: 'text', text })
  }
}

/**
 * Turn a `style="fill:#eee;stroke-width:2"` attribute into real attributes.
 *
 * The `<style>` ELEMENT is refused (see the module header: selectors, the
 * cascade and `@import` would make this a CSS engine). A style ATTRIBUTE is a
 * different object — a flat list of declarations on one element, with no
 * selector to resolve and no document to reach out of — so it is read rather
 * than dropped, and the reason is fidelity: mermaid puts real paint in there,
 * and dropping it files a diagram that previews grey and prints blank.
 *
 * Only declarations this module already allows as attributes survive, and each
 * value goes through the same refusal the attribute form does, so `fill:
 * url(https://…)` is refused in both spellings rather than in one.
 *
 * A declaration that collides with a real attribute on the same element wins,
 * because the serialiser keeps the LAST value for a name and these are appended
 * where the `style` attribute stood. That is CSS's own precedence — a style
 * declaration beats a presentation attribute — and it is the only piece of the
 * cascade implemented here, deliberately.
 */
function flattenStyleAttribute(elementName: string, style: string): SvgAttribute[] {
  const attributes: SvgAttribute[] = []
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon === -1) continue
    const name = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).trim()
    if (!value || !COMMON_ATTRIBUTES.has(name) || name === 'id') continue
    refuseDangerousAttribute(elementName, `style/${name}`, value)
    attributes.push({ name, value })
  }
  return attributes
}

/**
 * The two attribute rules that REFUSE rather than drop.
 *
 * Everything else unrecognised is dropped by the serialiser, because an unknown
 * attribute is decoration this pipeline cannot act on. These two are different:
 * they are the ones whose presence says the file is trying to reach outside
 * itself or to run, and a diagram that does either is not a diagram this
 * product will file, whatever else is in it.
 */
function refuseDangerousAttribute(elementName: string, attributeName: string, value: string): void {
  const lower = attributeName.toLowerCase()

  // `onload`, `onclick`, `onmouseover`, … — inert in an <img> but not in an
  // <object>, an <iframe>, or a direct navigation to the stored object, and
  // the storage layer cannot promise which of those a future surface uses.
  if (lower.startsWith('on')) {
    throw new DiagramSvgError('event-handler-attribute', `${elementName}/@${attributeName}`)
  }

  // Any namespace prefix: `href`, `xlink:href`, `xhtml:href`. A fragment is the
  // only reference a self-contained file can make; everything else is a fetch
  // performed by whoever opens the file, in their session, from a host this
  // product did not choose.
  if (lower === 'href' || lower.endsWith(':href')) {
    if (!value.startsWith('#')) {
      throw new DiagramSvgError('external-reference', `${elementName}/@${attributeName}`)
    }
    return
  }

  // `fill="url(https://…)"`, `clip-path="url(//evil)"`, `filter="url(data:…)"`.
  // The functional-IRI form is how a reference hides in a value rather than in
  // a name, so the check is on the VALUE and applies to every attribute.
  for (const match of value.matchAll(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi)) {
    const target = match[2].trim()
    if (!target.startsWith('#')) {
      throw new DiagramSvgError('external-reference', `${elementName}/@${attributeName}: url(${target})`)
    }
  }

  // A scheme in a value that is not a functional IRI — `javascript:`, `data:`.
  // Presentation attributes never legitimately carry one.
  if (/^\s*(javascript|data|vbscript)\s*:/i.test(value)) {
    throw new DiagramSvgError('external-reference', `${elementName}/@${attributeName}: scheme`)
  }
}

/**
 * Walk the tree and refuse any element outside {@link ELEMENT_GEOMETRY}.
 *
 * Refused rather than dropped, and that asymmetry with attributes is the point:
 * an element carries geometry, so dropping one files a diagram that is missing
 * part of the picture and says nothing about it. An office cannot audit what it
 * cannot see is absent.
 */
function refuseUnsupportedElements(node: SvgNode, depth: number): void {
  if (node.kind === 'text') return
  if (!ELEMENT_GEOMETRY.has(node.name)) {
    throw new DiagramSvgError('unsupported-element', node.name)
  }
  // `<metadata>` is allow-listed for ONE position: the one this module writes it
  // in, as a direct child of the root, where `withDiagramSource` can throw the
  // client's copy away and put the server-validated source there instead. Deeper
  // than that it is refused rather than dropped, because a nested one is not a
  // decoration this pipeline can ignore — `keptAttributes` carries
  // `data-grid-diagram-source` wherever it appears, so a `<g><metadata
  // data-grid-diagram-source="mermaid">…` was serialised into the stored file
  // with 200 KiB of text the 32 KiB per-kind source cap never saw. A file
  // claiming two sources is a file whose reader cannot tell which one the server
  // stood behind.
  if (node.name === METADATA_ELEMENT && depth !== 1) {
    throw new DiagramSvgError('unsupported-element', `${METADATA_ELEMENT} below the root`)
  }
  for (const child of node.children) refuseUnsupportedElements(child, depth + 1)
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

export interface DiagramSvgViewport {
  readonly width: number
  readonly height: number
  /** The `viewBox` as authored, forwarded to the PDF unchanged. */
  readonly viewBox: string
}

export interface ParsedDiagramSvg {
  readonly root: SvgElement
  readonly viewport: DiagramSvgViewport
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

function toLength(raw: string | undefined): number | null {
  if (raw === undefined) return null
  // `width="640px"` and `width="640"` are the same drawing; a percentage is not
  // a length this pipeline can resolve, because there is no containing block.
  const trimmed = raw.trim().replace(/px$/i, '')
  if (!NUMBER.test(trimmed)) return null
  const value = Number.parseFloat(trimmed)
  return Number.isFinite(value) && value > 0 ? value : null
}

export function attributeOf(element: SvgElement, name: string): string | undefined {
  return element.attributes.find((attribute) => attribute.name === name)?.value
}

/**
 * Read the drawing's own coordinate system.
 *
 * A viewport is REQUIRED, and not because SVG requires one — a browser will
 * happily render a `<svg>` with neither `viewBox` nor size by inventing 300×150.
 * The PDF cannot: `@react-pdf/renderer` needs a box to fit the drawing into, and
 * a guessed one crops the diagram in the artifact that gets attached to a
 * submission while the preview looks right. Refusing here is the only place the
 * two can be made to agree.
 */
function readViewport(root: SvgElement): DiagramSvgViewport {
  const viewBox = attributeOf(root, 'viewBox')?.trim()
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).filter(Boolean)
    if (parts.length === 4 && parts.every((part) => NUMBER.test(part))) {
      const width = Number.parseFloat(parts[2])
      const height = Number.parseFloat(parts[3])
      if (width > 0 && height > 0) return { width, height, viewBox }
    }
    throw new DiagramSvgError('missing-viewport', `viewBox="${viewBox}"`)
  }
  const width = toLength(attributeOf(root, 'width'))
  const height = toLength(attributeOf(root, 'height'))
  if (width === null || height === null) throw new DiagramSvgError('missing-viewport', 'no viewBox and no size')
  return { width, height, viewBox: `0 0 ${width} ${height}` }
}

/**
 * Parse a diagram SVG, or throw a {@link DiagramSvgError} naming the rule.
 *
 * Size is checked FIRST and in bytes, because everything after it is work done
 * on the caller's behalf on an input whose length the caller chose.
 */
export function parseDiagramSvg(input: string): ParsedDiagramSvg {
  const bytes = new TextEncoder().encode(input).byteLength
  if (bytes === 0) throw new DiagramSvgError('empty', 'no bytes')
  if (bytes > MAX_DIAGRAM_SVG_BYTES) {
    throw new DiagramSvgError('too-large', `${bytes} > ${MAX_DIAGRAM_SVG_BYTES}`)
  }

  const scanner = new Scanner(input)
  scanner.skipWhitespace()
  if (scanner.startsWith('<?xml')) {
    scanner.take(5)
    scanner.readUntil('?>', 'unterminated XML declaration')
    scanner.take(2)
  }
  skipTrivia(scanner)

  const root = parseElement(scanner, 1)
  if (root.name !== 'svg') throw new DiagramSvgError('not-svg', root.name)

  skipTrivia(scanner)
  if (!scanner.done) throw new DiagramSvgError('malformed-xml', 'trailing content after </svg>')

  refuseUnsupportedElements(root, 0)
  return { root, viewport: readViewport(root) }
}

// ---------------------------------------------------------------------------
// Serialise
// ---------------------------------------------------------------------------

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

function keptAttributes(element: SvgElement): readonly SvgAttribute[] {
  if (element.name === METADATA_ELEMENT) {
    return element.attributes.filter((attribute) => attribute.name === METADATA_KIND_ATTRIBUTE)
  }
  const geometry = ELEMENT_GEOMETRY.get(element.name)
  if (!geometry) return []
  // Last value for a name wins. Two can exist because a `style` attribute is
  // flattened into attributes in place, so `fill="red" style="fill:blue"`
  // arrives here as two `fill`s — and a serialised element with a repeated
  // attribute is not well-formed XML, so this is correctness and not tidiness.
  const byName = new Map<string, SvgAttribute>()
  for (const attribute of element.attributes) {
    if (geometry.has(attribute.name) || COMMON_ATTRIBUTES.has(attribute.name)) {
      byName.set(attribute.name, attribute)
    }
  }
  return [...byName.values()]
}

function serializeNode(node: SvgNode, out: string[]): void {
  if (node.kind === 'text') {
    out.push(escapeText(node.text))
    return
  }
  const attributes = keptAttributes(node)
    .map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`)
    .join('')
  if (node.children.length === 0) {
    out.push(`<${node.name}${attributes}/>`)
    return
  }
  out.push(`<${node.name}${attributes}>`)
  for (const child of node.children) serializeNode(child, out)
  out.push(`</${node.name}>`)
}

/**
 * Write the tree back out, from the allow-list.
 *
 * The client's bytes are never what is stored. Anything this file did not
 * recognise is simply not written — so a `style="…"`, a `data-*`, an `aria-*`
 * or an attribute invented after this was written cannot reach the stored
 * object even if the deny-list above never heard of it.
 */
export function serializeDiagramSvg(root: SvgElement): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>']
  serializeNode(withXmlns(root), out)
  return out.join('')
}

/** A standalone `.svg` file that omits the namespace is not an SVG to a parser. */
function withXmlns(root: SvgElement): SvgElement {
  if (attributeOf(root, 'xmlns')) return root
  return {
    ...root,
    attributes: [{ name: 'xmlns', value: 'http://www.w3.org/2000/svg' }, ...root.attributes],
  }
}

/**
 * Put the diagram's own source inside the diagram.
 *
 * **This is where the source lives, and the reason is portability.** The
 * alternatives were a second `documents` row (a `.mmd` file an architect never
 * asked for, with its own quota charge, its own `Zuweisen` and its own deletion
 * — two rows nobody can tell apart six months later), a new column on
 * `documents` (a migration for a value that then does not survive the file being
 * downloaded), and the audit event's metadata (a compliance record is not a
 * store you regenerate artefacts from). The source has to travel WITH the
 * artifact, because the person who needs to regenerate or hand-edit the diagram
 * is the person who has the file — possibly a year later, possibly outside this
 * product entirely.
 *
 * `<metadata>` is the element SVG defines for exactly this, it is not rendered
 * by anything, and excalidraw's own exporter already uses the same trick to make
 * its SVGs re-importable. Any `<metadata>` the client sent is DISCARDED first:
 * the source recorded here is the one the server validated against its own cap,
 * not a second copy the client could have made disagree with it.
 */
export function withDiagramSource(root: SvgElement, kind: DiagramSourceKind, source: string): SvgElement {
  const metadata: SvgElement = {
    kind: 'element',
    name: METADATA_ELEMENT,
    attributes: [{ name: METADATA_KIND_ATTRIBUTE, value: kind }],
    children: [{ kind: 'text', text: source }],
  }
  // Filtering the ROOT's children is enough, and only because
  // `refuseUnsupportedElements` refuses a `<metadata>` anywhere else. When it
  // did not, this filter was the whole of the "discarded" promise above and a
  // nested one walked straight past it into the stored file.
  const rest = root.children.filter((child) => !(child.kind === 'element' && child.name === METADATA_ELEMENT))
  return { ...root, children: [metadata, ...rest] }
}

/**
 * Say, inside the file, that a machine drew it.
 *
 * ## The problem this fixes
 *
 * A filed diagram used to carry NO marking of any kind in its bytes. The grey
 * „Von Piloti erstellt" byline is chrome — it lives in the Files pane and stops
 * at the download button — and the PDF sibling prints a footer line, but the
 * `.svg` a person drags onto their desktop, embeds in a Word document or mails
 * to a colleague said nothing at all about who drew it. That is the exact
 * artifact the marking exists for.
 *
 * ## Why `<title>` and `<desc>`, and not the four other candidates
 *
 * **They survive.** This module stores bytes it writes from an allow-list, so
 * the only markings that count are the ones the serialiser writes back out.
 * `title` and `desc` are already in {@link ELEMENT_GEOMETRY} with an empty
 * attribute set, and text children are serialised verbatim — so the marking
 * round-trips with the allow-list WIDENED BY NOTHING. On a file the product
 * serves back to browsers, a marking that costs no new element and no new
 * attribute is worth more than a more expressive one that costs both.
 *
 * **`<title>` is the accessible name.** The first `<title>` child of the root
 * IS the SVG's name to a browser tooltip, to a screen reader, and to a page
 * embedding it. So the human sentence — the same localized line the PDF prints
 * in its footer, resolved by the route — reaches a person who has only the
 * file.
 *
 * **`<desc>` carries the machine vocabulary.** The same `AIGenerated=true;
 * AIGenerator=Piloti; …` string the PDF puts in `Keywords` and the `.docx` puts
 * in typed custom properties, so ONE detector expression finds a machine-written
 * document in all three formats (`@/lib/ai-provenance`).
 *
 * Rejected, each for a concrete reason rather than a preference:
 *
 *   - **RDF/XMP inside `<metadata>`** — the "correct" answer in the abstract,
 *     and unreachable here. `<rdf:RDF>`, `<cc:Work>`, `<dc:creator>` are all
 *     outside {@link ELEMENT_GEOMETRY}, so `refuseUnsupportedElements` REFUSES
 *     the submission rather than stripping the block; admitting it means
 *     allow-listing a namespaced element tree. And `<metadata>` is already
 *     spoken for: {@link withDiagramSource} reserves it for the one source the
 *     server validated, and `keptAttributes` deliberately drops every attribute
 *     on it but one.
 *   - **A visible `<text>` footer.** It is the marking a sighted person meets
 *     without hovering, and SVG cannot lay it out: `<text>` does not wrap, the
 *     marking sentence is ~180 characters, and mermaid sizes its `viewBox`
 *     tightly to the drawing — so the line either runs off the picture or the
 *     server has to rewrite the viewBox and hand-break the sentence with guessed
 *     glyph widths. It would also reach the PDF, which renders from this same
 *     tree, and print a second marking under the one `renderDiagramPdf` already
 *     draws. The visible half of the marking belongs on the artifact with a page
 *     and a layout engine, and that is the artifact a Behörde receives.
 *   - **A `data-*` attribute on the root.** `keptAttributes` drops it: `svg`'s
 *     geometry set does not list it, which is the serialiser working as designed.
 *   - **The filename.** Renaming a file is one keystroke and a marking that a
 *     rename removes is not a marking.
 *
 * Neither element is paint, so `svg-to-pdf.tsx` maps both to `null` and the PDF
 * is unaffected: it carries its own footer line and its own `Keywords`.
 *
 * ## What is replaced
 *
 * Any `<title>` or `<desc>` the client put at the ROOT, and only at the root —
 * the same rule and the same reason `withDiagramSource` applies to
 * `<metadata>`: what the file says about ITSELF is the server's statement, not
 * a claim the submitting browser gets to make. Titles and descriptions nested
 * inside the drawing are the diagram's own labels and are left alone.
 */
export interface DiagramMarking {
  /**
   * What a person is told, in their locale. Becomes the SVG's accessible name.
   *
   * Resolved by the route, exactly as the PDF's footer line is, because a
   * renderer that reaches for a dictionary renders one language for every
   * office.
   */
  readonly notice: string
  /**
   * The machine-readable marking, in the vocabulary `@/lib/ai-provenance`
   * defines and `fileGeneratedDocument` verifies against the stored bytes.
   */
  readonly provenance: string
}

export function withDiagramMarking(root: SvgElement, marking: DiagramMarking): SvgElement {
  const element = (name: string, text: string): SvgElement => ({
    kind: 'element',
    name,
    attributes: [],
    children: [{ kind: 'text', text }],
  })
  const rest = root.children.filter(
    (child) =>
      !(
        child.kind === 'element' &&
        (child.name === MARKING_TITLE_ELEMENT || child.name === MARKING_DESC_ELEMENT)
      ),
  )
  // `<title>` FIRST: SVG names an element after its first `<title>` child, so a
  // marking that came second would be present in the file and absent from every
  // surface that reads the file's name.
  return {
    ...root,
    children: [
      element(MARKING_TITLE_ELEMENT, marking.notice),
      element(MARKING_DESC_ELEMENT, marking.provenance),
      ...rest,
    ],
  }
}

/** Read a source back out of a filed diagram — the regeneration path. */
export function diagramSourceOf(root: SvgElement): { kind: string; source: string } | null {
  for (const child of root.children) {
    if (child.kind !== 'element' || child.name !== METADATA_ELEMENT) continue
    const kind = child.attributes.find((a) => a.name === METADATA_KIND_ATTRIBUTE)?.value
    if (!kind) continue
    const source = child.children.map((node) => (node.kind === 'text' ? node.text : '')).join('')
    return { kind, source }
  }
  return null
}

// ---------------------------------------------------------------------------
// The one call a route makes
// ---------------------------------------------------------------------------

export interface DiagramSubmission {
  readonly svg: string
  readonly source: string
  readonly sourceKind: DiagramSourceKind
}

export interface AcceptedDiagram {
  /** The bytes to store: written by this module, never copied from the client. */
  readonly svg: string
  /**
   * The drawing, for the PDF sibling to redraw.
   *
   * WITHOUT the marking elements, deliberately. The PDF carries its own footer
   * line and its own `Keywords`, and `<title>`/`<desc>` are not paint — so
   * putting them in the tree the PDF walks would add nothing there and make
   * `svg-to-pdf.tsx` responsible for skipping them.
   */
  readonly root: SvgElement
  readonly viewport: DiagramSvgViewport
}

/**
 * Validate a submitted diagram and produce the SVG that will be stored.
 *
 * Throws {@link DiagramSvgError}; the route turns the rejection into a 400 with
 * a message in the reader's locale. It does not return a result union because
 * every caller here wants the same thing — refuse loudly — and a union would
 * put the burden of remembering that on each of them.
 *
 * The marking is a REQUIRED second argument rather than something a caller may
 * add afterwards: `svg` is the bytes that get stored, and this module is the
 * only thing that writes them, so "the stored bytes say a machine drew this" is
 * true by construction here instead of being one more thing a caller keeps.
 */
export function acceptDiagram(submission: DiagramSubmission, marking: DiagramMarking): AcceptedDiagram {
  const sourceBytes = new TextEncoder().encode(submission.source).byteLength
  const limit = DIAGRAM_SOURCE_FACTS[submission.sourceKind].maxSourceBytes
  if (sourceBytes > limit) {
    throw new DiagramSvgError('source-too-large', `${sourceBytes} > ${limit}`)
  }

  const { root, viewport } = parseDiagramSvg(submission.svg)
  const withSource = withDiagramSource(root, submission.sourceKind, submission.source)
  return {
    svg: serializeDiagramSvg(withDiagramMarking(withSource, marking)),
    root: withSource,
    viewport,
  }
}
