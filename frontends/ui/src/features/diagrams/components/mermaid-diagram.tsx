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
 *   - **drawn** — in one of two forms. Where the source parses into a model
 *     this product has a view for (`../use-diagram-model.ts`), that view, on a
 *     soft `bg-muted/40` plane, with no dimensions line (it has no geometry to
 *     claim one with) and the filing button only inside a project. Otherwise
 *     mermaid's SVG in a hairline frame, one line saying it claims no
 *     dimensions, and (only where a surface supplied a filing target) the
 *     button that files it.
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
 * belongs to whatever it is lying on, which here is the card. So mermaid's
 * figure paints no background (the view form's `bg-muted/40` is a plane in
 * the card's own tokens, not a sheet of paper), the SVG carries none (mermaid's is dropped by
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
 * only elements and attributes `lib/diagrams/svg.ts` writes. The copy the
 * filing button sends is drawn the same way on paper (`fileSvg`, or
 * `renderPaperDiagram` when a view is shown).
 */

import { useRef, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { motionBase, motionInstant, useMotionToken } from '@/components/motion'
import { useHeightGlide } from '@/components/motion/height-glide'
import { HorizontalScroll } from '@/components/ui/horizontal-scroll'
import { CodeBlock } from '@/shared/components/CodeBlock'
import { useTranslations } from '@/i18n'
import { diagramFrameStyle } from '../diagram-size'
import { renderPaperDiagram, useRenderedDiagram } from '../use-rendered-diagram'
import { useDiagramModel } from '../use-diagram-model'
import { DiagramView } from '../views/diagram-views'
import { titleFromSource, useDiagramFiling } from '../use-diagram-filing'
import { DiagramFilingControls } from './diagram-filing-controls'
import { DrawingCaption, DrawingReveal } from './drawing-skeleton'

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
  const filing = useDiagramFiling({
    source,
    fileSvg,
    renderFileSvg: model ? () => renderPaperDiagram(source, model) : undefined,
  })

  // Still being written (or parsed, `model === undefined`): the drawing's
  // place, not its source. A code block that turned into a picture when its
  // fence closed was the largest jump a streamed answer made (ADR-0066). The
  // place is held in the frame the drawing will be drawn in, guessed from the
  // fence's first keyword until the parse says, so the skeleton grows into
  // the drawing in one frame and one material (`DrawingReveal`). It used to
  // sit in mermaid's hairline frame whatever came, and a flowchart then
  // swapped it for this product's plane in the same paint as its height.
  const settledForm = isStreaming
    ? undefined
    : model === undefined
      ? undefined
      : model
        ? 'view'
        : 'svg'
  const form = settledForm ?? likelyForm(source)
  const state = isStreaming
    ? 'streaming'
    : model === undefined || (!model && !svg)
      ? 'drawing'
      : 'drawn'

  // A fence that cannot be drawn shows its source instead. The skeleton held
  // a drawing's place until the render said so, and the source is a
  // different height, so the swap goes through the same frame: the frame
  // glides from the height it had to the fallback's (`useHeightGlide`, the
  // product's step for content swapped in place) while the figure fades out
  // over it and the fallback fades in. It used to replace the figure in one
  // paint, and everything below moved by the difference.
  const fellBack = settledForm === 'svg' && failed
  const frameRef = useRef<HTMLDivElement>(null)
  useHeightGlide(frameRef, fellBack)
  const crossfade = useMotionToken(motionBase)

  let body: ReactNode
  if (fellBack) {
    const lineCount = source.split('\n').length
    body = (
      // The code block's own margin is the frame's now, so the fallback stands
      // where the figure stood rather than 12px further down.
      <div data-testid="mermaid-diagram" data-state="failed" className="[&>div:first-child]:my-0">
        <CodeBlock value={source} language="mermaid" collapsible={lineCount > 15} maxLines={15} />
        <p className="text-muted-foreground mt-1 text-xs">{t('fallback')}</p>
      </div>
    )
  } else if (form === 'view') {
    body = (
      <figure
        data-testid="mermaid-diagram"
        data-state={state}
        data-view={model ? model.kind : undefined}
        aria-busy={model ? undefined : true}
      >
        {/* A soft plane, not a frame: the nodes are cards and read on it
            without a box around a box. */}
        <div className="bg-muted/40 @container rounded-xl p-3">
          <DrawingReveal drawn={Boolean(model)}>
            {model && (
              <DiagramView
                model={model}
                label={titleFromSource(source) ?? t(`kind.${model.kind}`)}
              />
            )}
          </DrawingReveal>
        </div>
        {/* No „Schematisch — ohne Maßangabe." here: that line tells a reader a
            DRAWING claims no measurement, and these views have no geometry
            to claim one with. What is left is the filing action, and only
            inside a project (`DiagramFilingControls` renders nothing without
            a target). A filed copy carries the disclaimer in its own text. */}
        <AnimatePresence initial={false}>
          {model && filing.target ? (
            <DrawingCaption
              key="caption"
              className="text-muted-foreground flex flex-wrap items-center gap-x-3 pt-1 text-xs"
            >
              <DiagramFilingControls filing={filing} />
            </DrawingCaption>
          ) : null}
        </AnimatePresence>
      </figure>
    )
  } else {
    body = (
      <figure data-testid="mermaid-diagram" data-state={state} aria-busy={svg ? undefined : true}>
        {/* No background. The drawing is line and text; the paper under it is
          whatever surface it is lying on, which is the card — in both themes.
          A hairline frame is all it needs to read as a figure rather than as
          loose marks in the prose. */}
        <HorizontalScroll
          className="border-border rounded-lg border p-3 [&_svg]:h-auto [&_svg]:max-w-full"
          aria-label={tCommon('markdown.scrollDiagram')}
        >
          <DrawingReveal drawn={Boolean(svg)}>
            {svg && (
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
            )}
          </DrawingReveal>
        </HorizontalScroll>
        <AnimatePresence initial={false}>
          {settledForm === 'svg' && (
            <DrawingCaption
              key="caption"
              className="text-muted-foreground flex flex-wrap items-center gap-x-3 pt-1 text-xs"
            >
              {/* The doctrine, where the reader is. Fifteen schematic cards in this
                product compute their geometry so they cannot disagree with their
                own numbers; a model-authored diagram has no such guarantee, so it
                says out loud that it is not claiming a measurement. */}
              <span>{t('schematicOnly')}</span>
              <DiagramFilingControls filing={filing} />
            </DrawingCaption>
          )}
        </AnimatePresence>
      </figure>
    )
  }

  return (
    // One frame for every state, so the swap to the fallback has a frame to
    // glide. A block formatting context (`flow-root`), so the clip the glide
    // puts on it does not change how a margin inside collapses; `relative`
    // for the figure fading out, which `popLayout` lifts out of the flow.
    <div ref={frameRef} className="relative my-4 flow-root">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={fellBack ? 'fallback' : 'figure'}
          initial={crossfade === motionInstant ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={crossfade}
        >
          {body}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

/**
 * The diagram types this product draws in its own views (`modelFromParsed`):
 * a fence that opens with one of them is held on the view's plane while it is
 * written. A guess, not the parse: a flowchart too large for the view, or one
 * that does not parse, still turns out mermaid's.
 */
const VIEW_KEYWORDS =
  /^(?:flowchart|graph|stateDiagram(?:-v2)?|mindmap|sequenceDiagram|gantt|pie)\b/

/** The frame a fence is most likely drawn in, read off its first keyword. */
export function likelyForm(source: string): 'view' | 'svg' {
  // Front matter (`---` … `---`) and `%%` comments come before the keyword.
  const lines = source.split('\n').map((line) => line.trim())
  let at = 0
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1)
    at = close < 0 ? lines.length : close + 1
  }
  for (; at < lines.length; at++) {
    const line = lines[at]
    if (!line || line.startsWith('%%')) continue
    return VIEW_KEYWORDS.test(line) ? 'view' : 'svg'
  }
  return 'svg'
}
