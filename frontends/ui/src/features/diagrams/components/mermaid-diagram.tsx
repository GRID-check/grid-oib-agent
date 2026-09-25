'use client'

/**
 * A mermaid fence in an answer, drawn.
 *
 * ## The three states, and why the fallback is the source
 *
 *   - **streaming** — the fence is still arriving, so nothing is drawn.
 *     CommonMark runs an unclosed fence to the end of the text, which means an
 *     in-flight mermaid block LOOKS complete on every token; handing that to
 *     mermaid renders a parse error per token. So the fence still being
 *     written (`isOpenFence` in `MarkdownRenderer`) shows the drawing's
 *     placeholder, not its source, and every fence already closed is drawn
 *     while the rest of the answer streams (ADR-0066).
 *   - **failed** — the model writes broken mermaid regularly, and that must
 *     cost the reader nothing they did not already have. A failure renders the
 *     source, exactly as it rendered before this component existed, plus one
 *     quiet line saying the drawing did not work. Never a red box, never a
 *     thrown error inside somebody's answer.
 *   - **drawn** — the SVG, one line saying it claims no dimensions, and (only
 *     where a surface supplied a filing target) the button that files it.
 *
 * ## The drawing has no ground of its own
 *
 * It used to sit on `bg-white` in both themes, on the argument that it is a
 * preview of a document and documents are printed on paper. The screenshot is
 * what settled that: in dark mode it is a white slab punched into a charcoal
 * page, with mermaid's lavender inside it — an inherited theme, in a product
 * whose design language has no accent colour at all.
 *
 * A drawing is not a page. A flowchart is line and text; the paper under it
 * belongs to whatever it is lying on, which here is the card. So the figure
 * paints no background, the SVG carries none (mermaid's is dropped by
 * `flattenComputedStyles`, which does not copy `background-color`), and the
 * card surface shows through in both themes. What the drawing is MADE of — its
 * ink — comes from the product's tokens, per theme, via
 * `../diagram-palette.ts`.
 *
 * The document argument survives where it is actually true: the bytes that get
 * FILED are always drawn on paper, whatever theme the reader is in. That is
 * `fileSvg`, and the reason it can differ from `svg` without the file
 * disagreeing with the picture is in the header of `../use-rendered-diagram.ts`.
 *
 * ## Why the drawn SVG is injected as markup
 *
 * `mermaid.render` returns a string, and there is no way to mount a string of
 * SVG without setting markup. What makes that safe is not mermaid's
 * `securityLevel: 'strict'` alone — it is that the string was put through the
 * SERVER'S validator and re-serialised from its allow-list before it got here
 * (`renderMermaid` in `../render-diagram.ts`). So the markup below contains
 * only elements and attributes `lib/diagrams/svg.ts` writes, and it is
 * byte-for-byte what the filing button will send.
 */

import { HorizontalScroll } from '@/components/ui/horizontal-scroll'
import { CodeBlock } from '@/shared/components/CodeBlock'
import { useTranslations } from '@/i18n'
import { diagramFrameStyle } from '../diagram-size'
import { renderPaperDiagram, useRenderedDiagram } from '../use-rendered-diagram'
import { useDiagramModel } from '../use-diagram-model'
import { DiagramView } from '../views/diagram-views'
import { titleFromSource, useDiagramFiling } from '../use-diagram-filing'
import { DiagramFilingControls } from './diagram-filing-controls'
import { DrawingSkeleton } from './drawing-skeleton'

export interface MermaidDiagramProps {
  source: string
  /** True while the answer is still arriving; see the header. */
  isStreaming?: boolean
}

export function MermaidDiagram({ source, isStreaming = false }: MermaidDiagramProps) {
  const t = useTranslations('diagrams')
  const tCommon = useTranslations('common')
  // The render itself is `useRenderedDiagram` — shared with the `diagram` card,
  // which draws the same sources through the same renderer. One drive, so the
  // fresh id, the cancellation and the "a failure is not a throw" rule cannot
  // come out different on the two surfaces.
  // Drawn by this product's own views when mermaid's parser can read it into
  // a model (`docs/design/answer-visuals.md`); mermaid's SVG is then only the
  // FILE, drawn on paper when the reader files it and not before. Without a
  // model the SVG is the picture, as before.
  const model = useDiagramModel(source, !isStreaming)
  const { svg, fileSvg, failed } = useRenderedDiagram(source, !isStreaming && model === null)
  // And one WRITE, shared with the card for the same reason. `fileSvg` and not
  // `svg`: the bytes that go into the project are always the paper ones.
  const filing = useDiagramFiling({ source, fileSvg, renderFileSvg: model ? () => renderPaperDiagram(source) : undefined })

  // Still being written: the drawing's place, not its source. A code block that
  // turned into a picture when its fence closed was the largest jump a
  // streamed answer made; a placeholder growing into the figure is the small
  // one the drawing state below already makes (ADR-0066). Still being parsed
  // (`model === undefined`) holds the same placeholder: which of the two
  // pictures it becomes is not known yet, and mermaid's frame with its
  // „Schematisch" line flashed before this product's view replaced it.
  if (isStreaming || model === undefined) {
    return (
      <figure data-testid="mermaid-diagram" data-state={isStreaming ? 'streaming' : 'drawing'} className="my-4" aria-busy="true">
        <div className="border-border rounded-lg border p-3">
          <DrawingSkeleton />
        </div>
      </figure>
    )
  }

  if (!model && failed) {
    const lineCount = source.split('\n').length
    return (
      <div data-testid="mermaid-diagram" data-state="failed">
        <CodeBlock value={source} language="mermaid" collapsible={lineCount > 15} maxLines={15} />
        <p className="text-muted-foreground mt-1 text-xs">{t('fallback')}</p>
      </div>
    )
  }

  if (model) {
    return (
      <figure data-testid="mermaid-diagram" data-state="drawn" data-view={model.kind} className="my-4">
        {/* A soft plane, not a frame: the nodes are cards and read on it
            without a box around a box. */}
        <div className="bg-muted/40 rounded-xl p-3 @container">
          <DiagramView model={model} label={titleFromSource(source) ?? t(`kind.${model.kind}`)} />
        </div>
        {/* No „Schematisch — ohne Maßangabe." here: that line tells a reader a
            DRAWING claims no measurement, and these views have no geometry
            to claim one with. What is left is the filing action, and only
            inside a project (`DiagramFilingControls` renders nothing without
            a target). A filed copy carries the disclaimer in its own text. */}
        {filing.target ? (
          <figcaption className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 text-xs">
            <DiagramFilingControls filing={filing} />
          </figcaption>
        ) : null}
      </figure>
    )
  }

  return (
    <figure data-testid="mermaid-diagram" data-state={svg ? 'drawn' : 'drawing'} className="my-4">
      {/* No background. The drawing is line and text; the paper under it is
          whatever surface it is lying on, which is the card — in both themes.
          A hairline frame is all it needs to read as a figure rather than as
          loose marks in the prose. */}
      <HorizontalScroll
        className="border-border rounded-lg border p-3 [&_svg]:h-auto [&_svg]:max-w-full"
        aria-label={tCommon('markdown.scrollDiagram')}
      >
        {svg ? (
          <div
            // Safe because of what produced the string, not because of where it is
            // used: mermaid runs `securityLevel: 'strict'`, and `renderMermaid`
            // re-serialises its output through `lib/diagrams/svg.ts`, so only
            // allow-listed elements and attributes survive — no script, no
            // foreignObject, no external reference. That provenance lives in the
            // producer, which the scanner cannot see — a false positive, argued
            // out the same way as `scripts/release_notes.py`.
            // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml
            // Its own width, not the column's: see `diagram-size.ts`.
            style={diagramFrameStyle(svg)}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <DrawingSkeleton />
        )}
      </HorizontalScroll>
      <figcaption className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 text-xs">
        {/* The doctrine, where the reader is. Fifteen schematic cards in this
            product compute their geometry so they cannot disagree with their
            own numbers; a model-authored diagram has no such guarantee, so it
            says out loud that it is not claiming a measurement. */}
        <span>{t('schematicOnly')}</span>
        <DiagramFilingControls filing={filing} />
      </figcaption>
    </figure>
  )
}
