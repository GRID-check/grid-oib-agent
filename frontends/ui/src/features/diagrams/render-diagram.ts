/**
 * Drawing a diagram, in the one place that has a DOM.
 *
 * ## Why this runs in the browser
 *
 * Mermaid and excalidraw both LAY OUT a graph — they measure text, run a
 * layout, and only then emit geometry — and measuring text needs a document.
 * Production has no browser: `playwright-core` is a devDependency, and putting
 * Chromium into the production image is a deployment decision nobody has made.
 * So the layout happens here, in the reader's tab, and the server's job is to
 * validate and file what comes back.
 *
 * ## One render, two uses
 *
 * The SVG this produces is BOTH what the reader sees in the answer and what
 * gets filed into the project. That is not a coincidence to be tidied up later;
 * it is the reason the reader can trust the button. A second render for filing
 * would be a second chance for the file to disagree with the picture, and
 * "what got filed is not what I saw" is not a defect a Ziviltechniker can spot
 * before signing.
 *
 * The theme is the ONE thing that is allowed to differ, and only because it
 * cannot not. The screen and the page are different grounds: a label needs
 * 4.5:1 against whatever it sits on, and no single ink clears that against both
 * white paper and the dark card (`diagram-palette.ts` carries the arithmetic).
 * So a reader in dark mode gets a second render for the FILE — same source,
 * same font family, same font size, same `htmlLabels`, so the layout is
 * identical by construction and only the palette moves. Everything that could
 * make the file disagree with the picture is held fixed; see the header of
 * `use-rendered-diagram.ts`.
 *
 * ## What is rendered, and what is not
 *
 * The doctrine from `lib/diagrams/diagram-sources.ts` applies here unchanged:
 * these sources are for diagrams that make **no dimensional claim** — process
 * flows, sequences, decision trees, org and relationship maps. Anything
 * dimensional (a section, a stair, an escape route, a fire compartment) belongs
 * to the schematic renderers in `features/grid-cards/schematics/`, where the
 * model emits parameters and the RENDERER does the geometry, so that a card
 * cannot show a diagram that disagrees with its own numbers. Mermaid text IS
 * the geometry, so that guarantee does not exist here and no amount of care in
 * this file can create it.
 */

import {
  DIAGRAM_SOURCE_KINDS,
  type DiagramSourceKind,
} from '@/lib/diagrams/diagram-sources'
import { parseDiagramSvg, serializeDiagramSvg } from '@/lib/diagrams/svg'
import { diagramThemeVariables } from './diagram-palette'

export type DiagramTheme = 'light' | 'dark'

export interface DiagramRenderRequest {
  source: string
  /** Unique per render; mermaid uses it for the ids it mints inside the SVG. */
  id: string
  theme: DiagramTheme
}

export type DiagramRenderer = (request: DiagramRenderRequest) => Promise<string>

/**
 * The properties copied from the cascade onto the elements themselves.
 *
 * **Why flatten at all.** Mermaid styles its output with a `<style>` block full
 * of class selectors. `lib/diagrams/svg.ts` refuses that element — a CSS parser
 * on the server would be a second place external references can hide, and
 * `@react-pdf/renderer` cannot apply CSS at any price, so a filed diagram with
 * a stylesheet previews correctly and prints blank. The browser already has the
 * cascade resolved, so it is the cheapest and the only honest place to do this.
 *
 * The list is exactly what the server's allow-list keeps. A property added here
 * without being added there is bytes nobody reads; the reverse is paint that
 * silently disappears between the answer and the file.
 */
const FLATTENED_PROPERTIES = [
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
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
] as const

/** Properties whose computed `none` is a real instruction rather than "unset". */
const NONE_IS_MEANINGFUL: ReadonlySet<string> = new Set(['fill', 'stroke'])

/**
 * Elements the pipeline cannot file, removed here by the producer.
 *
 * Both are things mermaid emits and neither carries GEOMETRY, which is the
 * distinction `lib/diagrams/svg.ts` draws when it decides what to refuse and
 * what to drop: an element with geometry is refused, because a diagram missing
 * part of its picture must not be filed silently. These two are effects.
 *
 *   - `<style>` — the cascade, which is flattened onto the elements below. The
 *     server will not parse CSS (a second place external references can hide)
 *     and `@react-pdf/renderer` cannot apply it at any price.
 *   - `<filter>` — mermaid's drop shadows. `@react-pdf/renderer` has no filter
 *     primitive, so a filed diagram would keep a shadow the PDF silently drops.
 *   - `<use>` and `<symbol>` — mermaid emits an actor-icon library (computer,
 *     database, clock) into the `<defs>` of EVERY sequence diagram, used or
 *     not, and there is no `Use`/`Symbol` primitive in `@react-pdf/renderer`
 *     either. `<use>` goes first so a reference is removed before the thing it
 *     referenced. What is lost when a participant did declare an icon is the
 *     icon; the participant's NAME, which is the content, is a `<text>` and
 *     stays.
 *
 * The common thread is that the answer, the stored SVG and the PDF must show
 * the SAME drawing. An element that survives into the file and then disappears
 * in the PDF means the reader is not looking at what gets attached to the
 * Einreichung — which is the one thing this feature cannot afford.
 *
 * The server still refuses all of these by name. That is not redundant: this is
 * the PRODUCER cleaning up after itself, and the refusal is what happens when
 * some other producer does not.
 */
const UNFILEABLE_ELEMENTS = ['style', 'filter', 'use', 'symbol'] as const

/**
 * `rgb(0, 0, 0)` → `#000000`, `rgba(0, 0, 0, 0.5)` → `#000000` plus an alpha.
 *
 * `getComputedStyle` always answers in `rgb()`/`rgba()` form, and while SVG
 * understands both, `@react-pdf/renderer`'s colour parsing is happier with hex
 * and cannot express the alpha inside `rgba()` at all — it would silently paint
 * a half-transparent fill solid. Splitting the alpha out into `fill-opacity` /
 * `stroke-opacity` is what keeps the PDF looking like the answer did.
 */
function normalizeColor(value: string): { color: string; alpha: number | null } | null {
  const match = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.%]+)\s*)?\)$/i)
  if (!match) return null
  const channel = (raw: string) => Math.max(0, Math.min(255, Math.round(Number.parseFloat(raw))))
  const hex = `#${[match[1], match[2], match[3]]
    .map((raw) => channel(raw).toString(16).padStart(2, '0'))
    .join('')}`
  if (match[4] === undefined) return { color: hex, alpha: null }
  const raw = match[4].endsWith('%')
    ? Number.parseFloat(match[4]) / 100
    : Number.parseFloat(match[4])
  return { color: hex, alpha: Number.isFinite(raw) && raw < 1 ? raw : null }
}

/**
 * Copy the resolved cascade onto every element, then throw away what cannot be
 * filed.
 *
 * `host` must be IN the document and laid out — `display: none` makes several of
 * these properties resolve to their initial value rather than to what the
 * reader is looking at, so the caller parks it off-screen instead of hiding it.
 */
export function flattenComputedStyles(root: SVGElement): void {
  // Everything that is not the stylesheet goes first. `<style>` has to survive
  // until the cascade has been READ off every element — removing it first makes
  // `getComputedStyle` answer with initial values, which paints every mermaid
  // node black and left-aligns every label out of its own box.
  for (const name of UNFILEABLE_ELEMENTS) {
    if (name === 'style') continue
    for (const element of Array.from(root.querySelectorAll(name))) element.remove()
  }

  const elements: Element[] = [root, ...Array.from(root.querySelectorAll('*'))]

  // TWO PASSES, and the reason is a bug that only a screenshot could find.
  //
  // Mermaid styles its output with DESCENDANT selectors — `#id .node rect { fill }`
  // — so stripping the `class` off a group in the same pass that reads it
  // changes the computed style of every element visited afterwards. The first
  // version of this function did exactly that: it read a `<g class="node">`,
  // dropped its class, and then read the `<rect>` inside, which by then matched
  // no rule at all and answered with the inherited fill. Every node came out
  // filled black with its label sitting outside the box.
  //
  // So: read everything, then write everything. Nothing that can affect the
  // cascade is touched until the last value has been taken off it.
  const resolved = new Map<Element, Map<string, string>>()
  for (const element of elements) {
    const computed = window.getComputedStyle(element)
    const values = new Map<string, string>()
    for (const property of FLATTENED_PROPERTIES) {
      const raw = computed.getPropertyValue(property).trim()
      if (!raw) continue
      if (raw === 'none' && !NONE_IS_MEANINGFUL.has(property)) continue
      values.set(property, raw)
    }
    resolved.set(element, values)
  }

  for (const element of elements) {
    for (const [property, raw] of resolved.get(element) ?? []) {
      if (property === 'fill' || property === 'stroke') {
        const normalized = normalizeColor(raw)
        if (normalized) {
          element.setAttribute(property, normalized.color)
          if (normalized.alpha !== null) {
            element.setAttribute(`${property}-opacity`, String(normalized.alpha))
          }
          continue
        }
      }
      element.setAttribute(property, raw)
    }
    // The cascade is now on the attributes. Leaving either of these behind would
    // let a rule or a declaration win over what was just written, and the server
    // would then flatten a value the reader never saw.
    element.removeAttribute('style')
    element.removeAttribute('class')
  }

  // Dead weight now, and the one element the server refuses outright.
  for (const style of Array.from(root.querySelectorAll('style'))) style.remove()
}

/**
 * Mermaid, dynamically imported so a reader who never meets a diagram never
 * downloads one.
 *
 * Measured with esbuild against mermaid 11.17.0: the whole package bundles to
 * 3.45 MB minified / 947 KB gzipped, but it code-splits — the module this
 * `import()` pulls first is 28.6 KB min / 11.1 KB gzip, and rendering a
 * flowchart pulls a closure of 801 KB min / **214 KB gzip**. A static import
 * would put all of it in the chat bundle; this puts **zero** bytes there and
 * the 214 KB on the first answer that actually contains a diagram.
 */
const renderMermaid: DiagramRenderer = async ({ source, id, theme }) => {
  const mermaid = (await import('mermaid')).default
  const variables = diagramThemeVariables(theme)

  mermaid.initialize({
    startOnLoad: false,
    // The source is written by a language model from a user's question. Mermaid
    // has a history of label-based XSS, and `strict` is what makes it run its
    // labels through DOMPurify and refuse click bindings. This is the same
    // attack surface `lib/diagrams/svg.ts` guards, one layer earlier — and one
    // layer earlier is where the answer is DISPLAYED, before anything is filed.
    securityLevel: 'strict',
    // The product's own tokens, not mermaid's default theme.
    //
    // `base` is the only mermaid theme that honours `themeVariables` in full,
    // and honouring them in full is the requirement: with `default` every
    // diagram in this application was drawn in mermaid's lavender
    // (`#ECECFF` fill, `#9370DB` stroke), which is a brand accent colour in a
    // product whose design language says it has none. `null` means the tokens
    // could not be read — no stylesheet, no DOM — and then mermaid's own theme
    // is the honest fallback, because the alternative is a palette of hexes
    // written down here that stops matching the app on its next retune.
    ...(variables
      ? { theme: 'base' as const, themeVariables: variables }
      : { theme: theme === 'dark' ? ('dark' as const) : ('default' as const) }),
    // No HTML labels, anywhere. `<foreignObject>` is refused by the server (it
    // is arbitrary HTML inside a file that is served back to browsers) and
    // `@react-pdf/renderer` cannot draw it, so a diagram with HTML labels would
    // render in the answer and then be unfileable and unprintable. Turning it
    // off here is what keeps those three surfaces showing the same picture.
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
    fontFamily: 'Helvetica, Arial, sans-serif',
    // Mermaid's own failure handling APPENDS a "Syntax error in text" graphic
    // to the document and leaves it there. The model writes broken mermaid
    // regularly, so without this every bad diagram deposits a bomb icon at the
    // bottom of the page — outside React's tree, so nothing ever removes it.
    // The throw is what this component wants; the graphic is not.
    suppressErrorRendering: true,
  })

  // Throws on a parse error, which is the common case: the model writes broken
  // mermaid regularly. The caller degrades to the source text.
  const { svg } = await mermaid.render(id, source)

  // Off-screen but LAID OUT (see `flattenComputedStyles`). `position: fixed`
  // keeps it out of the document flow so nothing below it moves while it is
  // there, and the whole host is removed in a `finally` so a throw between here
  // and the end cannot leave a stray node in the body.
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:-99999px;top:0;width:2000px;pointer-events:none'
  host.innerHTML = svg
  document.body.appendChild(host)
  try {
    const element = host.querySelector('svg')
    if (!element) throw new Error('mermaid returned no <svg> element')
    flattenComputedStyles(element)
    const serialized = new XMLSerializer().serializeToString(element)
    // Through the SERVER'S validator, in the browser, before it is shown. Two
    // things fall out of that: the reader is looking at exactly the bytes the
    // filing button will send, and a mermaid release that starts emitting
    // something the server refuses fails here — visibly, on the developer's
    // screen — instead of as a 400 on somebody's finished diagram.
    return serializeDiagramSvg(parseDiagramSvg(serialized).root)
  } finally {
    host.remove()
  }
}

/**
 * Which source kinds this client can draw.
 *
 * **`excalidraw` is deliberately absent, and the numbers are the reason.**
 * Measured with esbuild, minified, gzipped, in this repository:
 *
 *   | package                            | min      | gzip     |
 *   |------------------------------------|----------|----------|
 *   | mermaid 11.17.0 (first flowchart)  | 801 KB   | 214 KB   |
 *   | mermaid 11.17.0 (every diagram)    | 3.45 MB  | 947 KB   |
 *   | @excalidraw/excalidraw 0.18.1      | 8.40 MB  | 2.53 MB  |
 *   | @excalidraw/utils 0.1.3-test32     | 19.56 MB | 14.03 MB |
 *   | @excalidraw/utils 0.1.2            | 1.49 MB  | 423 KB   |
 *
 * The editor package costs 11.8× mermaid's first render to obtain one export
 * function. `@excalidraw/utils` — the package that exists to be the cheap path —
 * is measurably WORSE than the editor at its published `latest`, because its
 * prod build inlines assets as base64; and that `latest` is `0.1.3-test32`, a
 * prerelease, last published sixteen months ago, with 32 of 38 published
 * versions carrying a `-test` suffix. The last non-prerelease, `0.1.2`, is a
 * 423 KB UMD bundle that does export `exportToSvg` — but it predates today's
 * scene schema, so a stored `.excalidraw` source would round-trip through a
 * version of the format the app itself no longer writes.
 *
 * None of those is a dependency to put in the write path of an Austrian
 * compliance product for a SECOND way to draw a box and an arrow. Mermaid also
 * now has two consumers — the answer and the file — and excalidraw would have
 * one. So the kind stays in the vocabulary and the renderer does not exist: the
 * server already accepts `excalidraw` as a source kind, so adding it later is
 * one entry in this map, not a vocabulary migration.
 */
export const DIAGRAM_RENDERERS: Readonly<Record<DiagramSourceKind, DiagramRenderer | null>> = {
  mermaid: renderMermaid,
  excalidraw: null,
}

export function diagramRendererFor(kind: DiagramSourceKind): DiagramRenderer | null {
  return DIAGRAM_RENDERERS[kind]
}

/** The kinds a browser can actually draw today — derived, never restated. */
export const RENDERABLE_DIAGRAM_KINDS: readonly DiagramSourceKind[] = DIAGRAM_SOURCE_KINDS.filter(
  (kind) => DIAGRAM_RENDERERS[kind] !== null,
)
