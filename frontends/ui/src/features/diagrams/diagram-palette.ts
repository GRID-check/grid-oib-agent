/**
 * The diagram's colours, read off the product's own tokens.
 *
 * ## Why this file exists at all
 *
 * Mermaid ships a default theme, and a component that does not choose one
 * INHERITS it. That is what happened here: every diagram in the product was
 * drawn with mermaid's `#ECECFF` node fill and `#9370DB` node stroke — lavender
 * — inside an application whose design language says, twice, that there is no
 * brand accent colour, that provenance signals are the ONLY chroma, and that
 * there is no purple/generic-AI aesthetic anywhere
 * (`docs/design/grid-design-language.md`). A drawing Piloti made of an Austrian
 * Verfahrensablauf is not a provenance signal and must not look like one, and
 * it certainly must not look like a different product.
 *
 * ## Why the INK ramp and not `--source-auto`
 *
 * `--source-auto` is the grey the app already uses for „Automatisch / Lücke",
 * and these drawings are machine-authored, so the pairing is tempting. It is
 * wrong for three separate reasons, and the third is disqualifying on its own:
 *
 *   1. **A provenance colour never travels alone.** The design language states
 *      the rule as a rule: a source colour always appears with its icon and its
 *      label. A whole drawing painted `--source-auto` carries neither, so it
 *      would be a signal nobody can read — chroma used decoratively, which is
 *      the exact prohibition.
 *   2. **It would be claiming the wrong thing.** `--source-auto` says where
 *      KNOWLEDGE came from, and its second job is the knowledge GAP. A
 *      Verfahren drawn from cited Baurecht is neither. The machine authorship
 *      is already said in words, twice — „Von Piloti erstellt" on the file and
 *      „Schematisch — ohne Maßangabe." under the drawing — and saying it a
 *      third time in colour would be a second voice, not a reinforcement.
 *   3. **It does not pass.** `--source-auto` is `#83837f` in light. Node labels
 *      at that lightness on white are ~3.2:1 — under AA for text. A drawing
 *      that goes to a Behörde cannot have unreadable labels.
 *
 * So: the ink ramp. `--foreground` for text, `--muted-foreground` for every
 * drawn line, `--muted` for node bodies (one surface step off the plane, the
 * same relationship in both themes), `--accent` for the inset planes
 * (clusters, activations). Monochrome, exactly like the rest of the app.
 *
 * ## Why two palettes are structurally necessary
 *
 * It would be much nicer to have ONE render whose colours work on paper and on
 * charcoal, because then the bytes on screen and the bytes in the file would be
 * the same bytes with no argument to have. That is impossible, and the proof is
 * short: a node label needs 4.5:1 against its own ground. Against white that
 * caps it at roughly L* 46; against the dark card (`#232120`, L* ≈ 13) it
 * requires at least L* 50. The two ranges do not overlap, so no single ink can
 * be a legible label in both themes. Hence `paletteFor('light' | 'dark')`, and
 * hence `useRenderedDiagram` drawing the filing copy separately when the reader
 * is in dark mode. See the header of `use-rendered-diagram.ts` for what that
 * costs and what is held constant so it costs nothing else.
 *
 * ## Why the values are READ rather than written down
 *
 * A hex that happens to match a token today is the bug one release later: the
 * palette retune moves the app and leaves the diagrams behind, and nothing
 * fails. So every value below is `getComputedStyle` on the real token, resolved
 * to hex through a canvas because mermaid hands its colours to khroma, which
 * parses `#rgb`/`rgb()` and does NOT parse the `oklch()` these tokens are
 * authored in.
 */

import type { DiagramTheme } from './render-diagram'

/** Mermaid's `themeVariables` bag — string-valued, plus its one boolean. */
export type DiagramThemeVariables = Record<string, string | boolean>

/**
 * The token behind each role in a drawing. Names only: the VALUES come from the
 * stylesheet at render time, which is the whole point of the module.
 */
const ROLE_TOKENS = {
  /** The plane the drawing sits on — the card. Never painted; see `background`. */
  surface: '--card',
  /** Every label. */
  ink: '--foreground',
  /** Every drawn line: node outlines, edges, arrowheads, note borders. */
  line: '--muted-foreground',
  /** Node bodies — one surface step off the plane, in both themes. */
  fill: '--muted',
  /** Inset planes: subgraph clusters, sequence activations. */
  inset: '--accent',
} as const

type Role = keyof typeof ROLE_TOKENS

/**
 * Two sentinels, because one is not enough: a `fillStyle` assignment the
 * browser REJECTS leaves the previous value in place, and the only way to tell
 * a rejection from a colour that happens to equal the sentinel is to ask twice
 * with different sentinels.
 */
const SENTINELS = ['#010203', '#040506'] as const

function assignFill(context: CanvasRenderingContext2D, value: string): boolean {
  for (const sentinel of SENTINELS) {
    context.fillStyle = sentinel
    context.fillStyle = value
    if (context.fillStyle !== sentinel) return true
  }
  return false
}

/**
 * `oklch(0.244 0.006 271.2)` → `#1f2023`, composited over `over`.
 *
 * The canvas is the converter because it is the only one in a browser that
 * accepts every colour syntax CSS does and answers in bytes. Compositing over
 * the surface is not a nicety either: `--border` and `--ring` are authored as
 * `color-mix(…, transparent)` hairlines, and a flattened SVG has nowhere to put
 * an alpha that `@react-pdf/renderer` will honour, so the alpha has to be
 * resolved against something HERE or it is resolved against black later.
 */
function toHex(context: CanvasRenderingContext2D, value: string, over: string | null): string | null {
  context.clearRect(0, 0, 1, 1)
  if (over) {
    if (!assignFill(context, over)) return null
    context.fillRect(0, 0, 1, 1)
  }
  if (!assignFill(context, value)) return null
  context.fillRect(0, 0, 1, 1)
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Read the token values for `theme`, whichever theme the reader is actually in.
 *
 * The app's themes are a `.dark` class on `<html>` (`app/providers.tsx`), and
 * custom properties inherit, so there is no element anywhere in the document
 * that resolves the LIGHT palette while the reader is in dark mode. Reading the
 * paper palette therefore means toggling that class off, reading, and toggling
 * it back — all inside one task, so the browser never gets a frame to paint the
 * swapped state and nothing flashes. It costs two forced style recalculations,
 * once per theme per session (the result is cached), and it is the only way to
 * get the paper values without restating them somewhere they can drift.
 */
function readRoles(theme: DiagramTheme): Record<Role, string> | null {
  const root = document.documentElement
  const wasDark = root.classList.contains('dark')
  const swap = wasDark !== (theme === 'dark')
  if (swap) root.classList.toggle('dark', theme === 'dark')
  try {
    const computed = window.getComputedStyle(root)
    const raw: Partial<Record<Role, string>> = {}
    for (const [role, token] of Object.entries(ROLE_TOKENS) as [Role, string][]) {
      const value = computed.getPropertyValue(token).trim()
      if (!value) return null
      raw[role] = value
    }
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    const surface = toHex(context, raw.surface ?? '', null)
    if (!surface) return null
    const resolved: Partial<Record<Role, string>> = { surface }
    for (const role of Object.keys(ROLE_TOKENS) as Role[]) {
      if (role === 'surface') continue
      const hex = toHex(context, raw[role] ?? '', surface)
      if (!hex) return null
      resolved[role] = hex
    }
    return resolved as Record<Role, string>
  } finally {
    if (swap) root.classList.toggle('dark', wasDark)
  }
}

/** One read per theme per session; token values do not move at runtime. */
const cache = new Map<DiagramTheme, DiagramThemeVariables | null>()

/**
 * Mermaid `themeVariables` for `theme`, or `null` when the tokens cannot be
 * read (no DOM, no stylesheet — specs, and any environment that is not the
 * product).
 *
 * `null` rather than a written-down fallback palette: a fallback made of hexes
 * is exactly the drift this module exists to prevent, and the honest answer
 * when the design system is not present is "use mermaid's own theme", which is
 * what `render-diagram.ts` does with this `null`.
 */
export function diagramThemeVariables(theme: DiagramTheme): DiagramThemeVariables | null {
  const cached = cache.get(theme)
  if (cached !== undefined) return cached
  const built = build(theme)
  cache.set(theme, built)
  return built
}

/** Test hook — the cache is module-wide and outlives a component. */
export function resetDiagramPaletteCache(): void {
  cache.clear()
}

function build(theme: DiagramTheme): DiagramThemeVariables | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null
  let roles: Record<Role, string> | null = null
  try {
    roles = readRoles(theme)
  } catch {
    roles = null
  }
  if (!roles) return null
  const { surface, ink, line, fill, inset } = roles

  return {
    darkMode: theme === 'dark',
    /**
     * Mermaid uses this to DERIVE contrasts; it never survives into the file.
     * `flattenComputedStyles` copies a fixed property list onto the elements
     * and `background-color` is not on it, so the SVG that reaches the answer
     * and the SVG that reaches the project both have no ground of their own —
     * which is what lets the card surface show through in either theme, and
     * what keeps a filed drawing from punching a rectangle into a PDF page.
     */
    background: surface,
    /** The body ramp. Mermaid's own default is 16px, a size this app does not have. */
    fontSize: '14px',

    // --- flowchart -------------------------------------------------------
    primaryColor: fill,
    primaryBorderColor: line,
    primaryTextColor: ink,
    secondaryColor: inset,
    secondaryBorderColor: line,
    secondaryTextColor: ink,
    tertiaryColor: inset,
    tertiaryBorderColor: line,
    tertiaryTextColor: ink,
    mainBkg: fill,
    nodeBorder: line,
    nodeTextColor: ink,
    lineColor: line,
    textColor: ink,
    titleColor: ink,
    edgeLabelBackground: surface,
    clusterBkg: inset,
    clusterBorder: line,
    defaultLinkColor: line,
    arrowheadColor: line,

    // --- sequence --------------------------------------------------------
    actorBkg: fill,
    actorBorder: line,
    actorTextColor: ink,
    actorLineColor: line,
    signalColor: line,
    signalTextColor: ink,
    labelBoxBkgColor: fill,
    labelBoxBorderColor: line,
    labelTextColor: ink,
    loopTextColor: ink,
    activationBkgColor: inset,
    activationBorderColor: line,
    sequenceNumberColor: surface,
    noteBkgColor: inset,
    noteBorderColor: line,
    noteTextColor: ink,
    altBackground: inset,
  }
}
