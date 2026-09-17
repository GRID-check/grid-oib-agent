/**
 * What a diagram is written IN — the vocabulary, with nothing attached.
 *
 * ## The doctrine this module sits next to, and the line it must not cross
 *
 * This repository already renders fifteen technical diagrams
 * (`src/features/grid-cards/schematics/`) and it renders them a very particular
 * way: **the model emits parameters only and the renderer does every piece of
 * geometry**. `docs/architecture/cards.md` states the guarantee that buys —
 * *"a card cannot show a diagram that disagrees with its own numbers"* — and it
 * exists because the card is what gets screenshotted into an Einreichung. A
 * `building_section` cannot draw a storey at the wrong height, because the
 * model never gets to say where the line goes.
 *
 * **A model writing raw mermaid or excalidraw loses that guarantee entirely.**
 * The source below IS the geometry: whatever the model writes is what is drawn.
 * There is no arithmetic between the claim and the picture, so there is nothing
 * to disagree with and nothing to catch a disagreement.
 *
 * So the rule for this vocabulary is a rule about SUBJECT, not about quality:
 *
 *   - **Allowed** — diagrams that make no dimensional claim: process flows,
 *     sequences, decision trees, state machines, org and relationship maps,
 *     Zuständigkeiten, Verfahrensschritte. Nothing on such a diagram is a
 *     measurement, so nothing on it can be measurably wrong.
 *   - **Not allowed, and deliberately not built here** — anything dimensional:
 *     a section, a stair, an escape route, a fire compartment, a setback, a
 *     daylight angle. Those belong to the schematic renderers, whose geometry
 *     is COMPUTED from parameters, and that seam stays where it is.
 *
 * The seam between the two is named rather than implemented: a schematic card
 * that wants to become a filed file needs a renderer that serialises the card's
 * own computed SVG — the same `fileDiagramDocuments` call with the card's
 * geometry instead of a model's text. That is a new caller, not a new pipeline,
 * and it is not in this change. Until it exists, **nothing dimensional may be
 * filed through here**, and the reason is not taste: a filed file outlives the
 * chat turn that made it, is downloaded, and is attached to a submission that a
 * Ziviltechniker signs.
 *
 * ## Why a tuple
 *
 * Same reason `DOCUMENT_AUTHORS` and `GENERATED_DOCUMENT_PRODUCERS` are tuples:
 * the set is enumerable at runtime, the type is derived rather than restated,
 * and a route handler can validate a request body against it without importing
 * anything that drags the database into the transport layer.
 */

/**
 * The source languages a diagram may be authored in.
 *
 * `mermaid` is text; `excalidraw` is a JSON scene. Both are declared because
 * both are real answers to "what did the model write", and the vocabulary is
 * the part that is expensive to change later — the row's stored source has to
 * say what it is, forever, and a value invented after the fact is archaeology.
 *
 * **`excalidraw` is declared and, in this vertical, has no client renderer.**
 * That is a measured decision and not an oversight; see
 * `src/features/diagrams/diagram-renderers.ts`, which is the one place the
 * kind-to-renderer map lives and the one place the reason is written down. The
 * server never renders — it validates and files — so it is indifferent to which
 * kinds a client can produce, and declaring the kind now is what makes adding
 * the renderer later a one-file change rather than a vocabulary migration.
 */
export const DIAGRAM_SOURCE_KINDS = ['mermaid', 'excalidraw'] as const
export type DiagramSourceKind = (typeof DIAGRAM_SOURCE_KINDS)[number]

export interface DiagramSourceFacts {
  /** What the source text IS, for anything that ever serves it on its own. */
  readonly contentType: string
  /** The conventional extension, used when naming the source in an archive. */
  readonly extension: string
  /**
   * The cap on the source text, in bytes.
   *
   * Per kind because the two are not the same shape of thing: a mermaid graph
   * is a few lines of text, an excalidraw scene is a JSON document with one
   * object per drawn element and a version stamp on each. A single cap would
   * either be uselessly generous for mermaid or reject ordinary excalidraw.
   */
  readonly maxSourceBytes: number
}

export const DIAGRAM_SOURCE_FACTS = {
  mermaid: {
    contentType: 'text/vnd.mermaid',
    extension: 'mmd',
    // 32 KiB is roughly a thousand-node flowchart. A model that writes more
    // than that has not written a diagram anybody will read.
    maxSourceBytes: 32 * 1024,
  },
  excalidraw: {
    contentType: 'application/json',
    extension: 'excalidraw',
    // A scene serialises every element with its own id, version, seed and
    // bound-element list, so the JSON is an order of magnitude larger than the
    // drawing it describes.
    maxSourceBytes: 512 * 1024,
  },
} as const satisfies Record<DiagramSourceKind, DiagramSourceFacts>

export function isDiagramSourceKind(value: unknown): value is DiagramSourceKind {
  return typeof value === 'string' && (DIAGRAM_SOURCE_KINDS as readonly string[]).includes(value)
}

/**
 * The cap on a rendered diagram SVG, in bytes.
 *
 * The number is a REFUSAL BUDGET, not a guess at what diagrams weigh: these
 * bytes arrive from a browser, are held in memory while they are parsed into a
 * tree, and are then walked twice (once to serialise, once to convert to PDF).
 * An unbounded input is an unbounded parse, and the parse happens before any
 * authorization decision has been re-checked.
 *
 * 1 MiB is ~20x a large mermaid flowchart with styles flattened onto every
 * node. A diagram that does not fit is one nobody can read on a page anyway,
 * so the cap is generous in the direction that matters and finite in the
 * direction that matters more.
 */
export const MAX_DIAGRAM_SVG_BYTES = 1024 * 1024

/**
 * The largest byte cap any source kind states, for a caller that has to bound a
 * transport before it knows which kind is inside it.
 *
 * Derived rather than written down, because a third kind with a larger cap must
 * raise this with it — and a route that hard-coded `512 * 1024` would start
 * refusing that kind's legitimate sources at the transport layer, before the
 * per-kind cap that is supposed to judge them ever ran.
 */
export const MAX_DIAGRAM_SOURCE_BYTES = Math.max(
  ...DIAGRAM_SOURCE_KINDS.map((kind) => DIAGRAM_SOURCE_FACTS[kind].maxSourceBytes),
)

/**
 * The deepest element nesting a submitted diagram may have.
 *
 * **A byte budget is not a depth budget, and this is the measurement that says
 * so.** Four separate walks recurse once per level — `parseElement`,
 * `refuseUnsupportedElements` and `serializeNode` here, `toPdfNode` in
 * `svg-to-pdf.tsx`, plus `@react-pdf/renderer`'s own layout inside the last one
 * — so nesting, not size, is what exhausts the stack. Measured in this
 * repository on Node 22:
 *
 *   - `parseDiagramSvg` accepts depth 5000 (~35 KB, 3% of the 1 MiB cap) and
 *     throws a bare `RangeError: Maximum call stack size exceeded` at 6000;
 *   - the whole route — parse, then `renderDiagramPdf` — survives depth 1500
 *     and dies at 1600 in a fresh process, and the exact number moves with how
 *     much stack the caller already used, which is precisely why it cannot be
 *     the bound.
 *
 * A `RangeError` is not a `DiagramSvgError`, so it left the route answering
 * `Internal server error` (500, untranslated) to a request the module's own
 * comments promise is refused with a named 400 — and it did so from any
 * authenticated session, since the parse runs before the project permission
 * check.
 *
 * 64 is ~6x the deepest real diagram measured here (a checked-in mermaid
 * flowchart nests 11 elements) and ~1/23 of the lowest observed crash point, so
 * the margin absorbs both a deeper diagram than any mermaid release has emitted
 * and a stack that is already partly spent. The limit is deliberately a
 * REFUSAL and not a truncation: dropping the tail of a tree files a diagram
 * missing part of its picture, which is the same argument that makes an
 * unsupported element a refusal rather than a drop.
 */
export const MAX_DIAGRAM_SVG_DEPTH = 64
