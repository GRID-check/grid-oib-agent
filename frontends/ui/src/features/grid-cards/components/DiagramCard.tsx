'use client'

/**
 * DiagramCard — the one drawing in the catalogue the renderer did not compute.
 *
 * Fifteen schematic cards take PARAMETERS and draw the geometry themselves, so
 * a card cannot show a picture that disagrees with its own numbers. Here the
 * mermaid source IS the geometry: nothing stands between what the model typed
 * and what is drawn. That guarantee is not weakened, it is simply unavailable —
 * so the boundary is drawn around the SUBJECT instead (`cards/models.py`, and
 * docs/architecture/cards.md §"The `diagram` card"). A Verfahren that forks and
 * rejoins, an ordered exchange between Stellen, a dependency: none of them
 * claims a measurement, so none of them can be measurably wrong.
 *
 * The reader is told that rather than left to work it out. „Schematisch — ohne
 * Maßangabe." sits under every drawing, and it is the same sentence, from the
 * same key, that a mermaid FENCE prints — because it is the same claim about
 * the same picture, and two wordings of it would be two claims.
 *
 * ## The three states, and why the failed one is not an error
 *
 *   - **drawing** — mermaid is laying the graph out. The first diagram in a
 *     session also pulls ~214 KB of mermaid, so this is a real moment rather
 *     than a theoretical one, and it holds the drawing's own space so nothing
 *     below it jumps when the picture lands.
 *   - **drawn** — the SVG, on paper (see below), then the caption, then the
 *     doctrine line, then the Fundstelle.
 *   - **failed** — the model writes invalid mermaid regularly. That must cost
 *     the reader nothing they did not already have, so the card degrades to the
 *     SOURCE in a code block plus one quiet line, exactly as the fence does.
 *     Never a red box, never an error inside an answer: the failure is the
 *     product's, and the reader is holding a Verfahren they asked about.
 *
 * The title, the caption and the Fundstelle are drawn in ALL three states. They
 * are the card's own words about what the drawing shows and what it rests on,
 * and they are just as true when the picture could not be laid out — a
 * procedure whose Fundstelle vanished because mermaid choked on a bracket is a
 * procedure from nowhere.
 *
 * ## Why the drawing has no ground of its own
 *
 * A flowchart is line and text; the surface under it belongs to whatever it is
 * lying on, which here is the card. So the plate paints no background and the
 * card shows through in both themes, while the drawing's INK comes from the
 * product's tokens per theme (`features/diagrams/diagram-palette.ts`) — the
 * white plate this replaced was a slab punched into the charcoal page, and what
 * sat on it was mermaid's inherited lavender. Still a plate rather than a
 * second card: hairline, no shadow, no elevation, so it frames the drawing
 * without becoming a card inside a card.
 *
 * The document argument survives where it is true — the bytes that get FILED
 * are always drawn on paper, whatever theme the reader is in. This card files,
 * so it needs that second render exactly as the fence does: `useRenderedDiagram`
 * hands back `svg` for the screen and `fileSvg` for the file, and the filing
 * hook is given the second one. What was dropped is the claim that the SCREEN
 * copy has to look like paper too — a preview of a document is not the same
 * argument as the document.
 *
 * ## It files, and it is still `presentational`
 *
 * „Im Projekt ablegen" sits under the drawing, through the same
 * `useDiagramFiling` the mermaid FENCE uses. It has to: which of the two
 * surfaces a reader gets is not their choice and not a property of the drawing
 * — it is whichever shape the model emitted — so an affordance on one and not
 * the other made the same Verfahrensablauf saveable by accident.
 *
 * That does not make the card interactive in ADR-0030's sense, because that
 * classification governs whether a decision is PERSISTED and this one is not.
 * A `CardInteraction` is a `CardDecision` plus a timestamp and nothing else, so
 * storing `filed` would record that it happened and lose the document id. It
 * does not need storing: filing keys on (answer, source hash, producer), so a
 * reader who reloads presses the same button and gets the same document back.
 * The reasoning lives at the `diagram` entry in `../card-decision.ts`.
 *
 * The card passes its own `title` — the one the model wrote for THIS drawing —
 * which is strictly better provenance than the front matter a bare source may
 * carry, and it is what names the file in the Files pane.
 */

import { type FC } from 'react'
import { Workflow } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { CodeBlock } from '@/shared/components/CodeBlock'
import { useTranslations } from '@/i18n'
import { useRenderedDiagram } from '@/features/diagrams/use-rendered-diagram'
import { useDiagramFiling } from '@/features/diagrams/use-diagram-filing'
import { DiagramFilingControls } from '@/features/diagrams/components/diagram-filing-controls'
import { NormRefFooter } from '../schematics/kit'
import type { NormReferenceData } from '../schematics/types'

interface DiagramCardProps {
  title: string
  source: string
  caption?: string | null
  reference?: NormReferenceData | null
}

/** Past this the source is folded, matching the fence. */
const SOURCE_MAX_LINES = 15

/**
 * The drawing's space while it is being laid out.
 *
 * Three bars rather than one block, because the shape a reader is waiting for
 * is a graph and a single grey rectangle reads as an image that failed.
 *
 * The height is a REPRESENTATIVE one, not a reservation, and the difference is
 * worth being honest about: a mermaid drawing's height is not known until the
 * graph has been laid out, so the card does resize when the SVG lands and no
 * skeleton can prevent that. What the fixed height buys is that the card is not
 * a thin sliver first — a 20px placeholder growing to a 600px sequence diagram
 * moves everything below it much further than a 132px one does. Nothing is
 * animated either way; the design language forbids animating height, and this
 * changes it in one paint.
 */
const DrawingSkeleton: FC = () => (
  <div className="flex h-[132px] flex-col justify-center gap-3" aria-hidden="true">
    <Skeleton className="h-4 w-2/5 rounded-md" />
    <Skeleton className="h-4 w-3/5 rounded-md" />
    <Skeleton className="h-4 w-1/3 rounded-md" />
  </div>
)

export const DiagramCard: FC<DiagramCardProps> = ({ title, source, caption, reference }) => {
  const t = useTranslations('chat')
  const tDiagrams = useTranslations('diagrams')
  const { svg, fileSvg, failed } = useRenderedDiagram(source)
  // `fileSvg`, never `svg`: the bytes that go into the project are the paper
  // ones whatever theme the reader is in. The card's own title beats anything
  // the source carries — the model wrote it for this drawing.
  const filing = useDiagramFiling({ source, fileSvg, title })
  const state = failed ? 'failed' : svg ? 'drawn' : 'drawing'

  return (
    <Card data-testid="diagram-card" data-state={state} className="gap-3 p-5 shadow-xs">
      <SectionLabel icon={Workflow}>{t('cards.diagram.eyebrow')}</SectionLabel>
      <p className="card-title text-foreground">{title}</p>

      <figure className="m-0 flex flex-col gap-2">
        {state === 'failed' ? (
          <CodeBlock
            value={source}
            language="mermaid"
            collapsible={source.split('\n').length > SOURCE_MAX_LINES}
            maxLines={SOURCE_MAX_LINES}
          />
        ) : (
          <div className="overflow-x-auto rounded-md border border-border p-3 [&_svg]:h-auto [&_svg]:max-w-full">
            {svg ? (
              <div
                // Safe because of what produced the string, not because of where
                // it is used: `renderMermaid` re-serialises mermaid's output
                // through `lib/diagrams/svg.ts`, so only allow-listed elements
                // and attributes survive — no script, no foreignObject, no
                // external reference.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : (
              <DrawingSkeleton />
            )}
          </div>
        )}

        <figcaption className="flex flex-col gap-1">
          {caption && <p className="card-body max-w-prose text-pretty text-foreground">{caption}</p>}
          {/* The doctrine, where the reader is — and on a failure the line that
              says why they are looking at source instead of a picture. Never
              both: „Schematisch — ohne Maßangabe." is a statement about a
              drawing, and on a failure there is none. */}
          {/* The doctrine and the action on one line, in that order. The
              drawing's claim about itself comes first and the control is a
              quiet ink link beside it — a filled button here would compete with
              the drawing above and with the Fundstelle below, both of which
              outrank "save this". Outside a project the control is absent, not
              disabled: `DiagramFilingControls` renders nothing without a
              target. */}
          <p className="card-caption flex flex-wrap items-center gap-x-3 text-muted-foreground">
            {state === 'failed' ? tDiagrams('fallback') : tDiagrams('schematicOnly')}
            {/* A drawing that could not be laid out has no bytes to file, so
                the control appears only on a real picture — the same rule the
                fence follows by only reaching its figcaption when it drew. */}
            {state === 'failed' ? null : <DiagramFilingControls filing={filing} />}
          </p>
        </figcaption>
      </figure>

      <NormRefFooter reference={reference} />
    </Card>
  )
}
