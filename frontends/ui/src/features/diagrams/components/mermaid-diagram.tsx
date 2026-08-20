'use client'

/**
 * A mermaid fence in an answer, drawn.
 *
 * ## The three states, and why the fallback is the source
 *
 *   - **streaming** — the fence is still arriving, so nothing is drawn. The
 *     stabiliser in `MarkdownRenderer` appends a synthetic closing fence to
 *     half-arrived markdown, which means an in-flight mermaid block LOOKS
 *     complete on every token. Handing that to mermaid renders a parse error
 *     per token, so the rule is simply: while the answer is streaming, a
 *     mermaid fence is a code block. It becomes a diagram once, when the answer
 *     is finished and the text has stopped changing.
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

import { CodeBlock } from '@/shared/components/CodeBlock'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { useRenderedDiagram } from '../use-rendered-diagram'
import { useDiagramFiling } from '../use-diagram-filing'
import { DiagramFilingControls } from './diagram-filing-controls'

export interface MermaidDiagramProps {
  source: string
  /** True while the answer is still arriving; see the header. */
  isStreaming?: boolean
}

/**
 * The drawing's space while mermaid lays the graph out.
 *
 * Three bars and not a spinner, and not the source either. The shape the reader
 * is waiting for is a graph, so a single grey block reads as an image that
 * failed; and swapping a fifteen-line code block for a picture is a bigger jump
 * than growing a placeholder. It is the same skeleton the `diagram` CARD holds
 * (`features/grid-cards/components/DiagramCard.tsx`) — Jakob's law inside one
 * product: the two surfaces that draw the same mermaid must wait the same way.
 *
 * The height is representative, not a reservation: a mermaid drawing's height
 * is unknown until the graph is laid out, so the figure does resize when the
 * SVG lands. Nothing animates it — the design language forbids animating
 * height, and this changes in one paint.
 */
function DrawingSkeleton() {
  return (
    <div className="flex h-[132px] flex-col justify-center gap-3" aria-hidden="true">
      <Skeleton className="h-4 w-2/5 rounded-md" />
      <Skeleton className="h-4 w-3/5 rounded-md" />
      <Skeleton className="h-4 w-1/3 rounded-md" />
    </div>
  )
}

export function MermaidDiagram({ source, isStreaming = false }: MermaidDiagramProps) {
  const t = useTranslations('diagrams')
  // The render itself is `useRenderedDiagram` — shared with the `diagram` card,
  // which draws the same sources through the same renderer. One drive, so the
  // fresh id, the cancellation and the "a failure is not a throw" rule cannot
  // come out different on the two surfaces.
  const { svg, fileSvg, failed } = useRenderedDiagram(source, !isStreaming)
  // And one WRITE, shared with the card for the same reason. `fileSvg` and not
  // `svg`: the bytes that go into the project are always the paper ones.
  const filing = useDiagramFiling({ source, fileSvg })

  // Streaming, or refused to draw: the source, which is what the reader saw
  // before this component existed. NOT the "still drawing" case — that one gets
  // the skeleton below, because replacing a code block with a picture a second
  // later is a bigger jump than growing a placeholder into one.
  if (isStreaming || failed) {
    const lineCount = source.split('\n').length
    return (
      <div data-testid="mermaid-diagram" data-state={failed ? 'failed' : 'streaming'}>
        <CodeBlock value={source} language="mermaid" collapsible={lineCount > 15} maxLines={15} />
        {failed ? <p className="mt-1 text-xs text-muted-foreground">{t('fallback')}</p> : null}
      </div>
    )
  }

  return (
    <figure data-testid="mermaid-diagram" data-state={svg ? 'drawn' : 'drawing'} className="my-4">
      {/* No background. The drawing is line and text; the paper under it is
          whatever surface it is lying on, which is the card — in both themes.
          A hairline frame is all it needs to read as a figure rather than as
          loose marks in the prose. */}
      <div className="overflow-x-auto rounded-lg border border-border p-3 [&_svg]:h-auto [&_svg]:max-w-full">
        {svg ? (
          <div
            // Safe because of what produced the string, not because of where it is
            // used: `renderMermaid` re-serialises mermaid's output through
            // `lib/diagrams/svg.ts`, so only allow-listed elements and attributes
            // survive — no script, no foreignObject, no external reference.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <DrawingSkeleton />
        )}
      </div>
      <figcaption className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
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
