'use client'

import { type FC } from 'react'
import { cn } from '@/lib/utils'
import { useCardSet } from '../card-set'
import type { SummaryCardData } from '../types'

/**
 * SummaryCard — the answer headline + intro, rendered flat so it reads as the
 * top of the "Ergebnis" card (click-dummy anatomy). No card chrome — it sits
 * directly on the result surface, which is the FLAT register in
 * `docs/design/grid-card-charter.md` §A1: this block is part of the answer
 * body, not an object you would crop out of it.
 *
 * The title sits at the Value step and the content at Prose — 15px both, one
 * at 600 and one at 400. That pairing is the whole hierarchy this block needs,
 * and it is why the 17px `card-headline` step it used to spend is gone: a
 * headline a step above every other card's title made the answer's first line
 * compete with the answer's actual figure.
 *
 * WITH A `verdict_header` ON SCREEN THE TITLE DEMOTES rather than disappears.
 * It drops to Body/600 in muted ink, so it reads as a lead-in label and no
 * longer offers the reader a second place to start. Demoted and not dropped,
 * because dropping it would silently discard a field the model filled — the
 * same call the charter already made for `follow_ups`' title, and for the same
 * reason: the entry argues about COMPETING FOR THE TOP, never about the field.
 *
 * The key points hang off a rule rather than off `list-disc`. Three discs at
 * body weight read as a paragraph that happens to be indented; the rule binds
 * them into one block the eye can take in without reading it, which is the
 * only reason to lift them out of the intro in the first place. The rule is
 * `--foreground/20` rather than `border-border`, because the hairline every
 * disclosure panel uses says "this is an aside": these are the answer's own
 * emphasis, and they are not an aside from themselves.
 */
export const SummaryCard: FC<SummaryCardData> = ({ title, content, key_points }) => {
  const { hasVerdictHeader } = useCardSet()

  return (
    <div className="flex flex-col gap-3">
      <p
        className={cn(
          hasVerdictHeader
            ? 'card-body font-semibold text-muted-foreground'
            : 'card-value text-foreground',
        )}
      >
        {title}
      </p>

      {content && <p className="card-prose text-default">{content}</p>}

      {key_points && key_points.length > 0 && (
        <ul className="flex flex-col gap-1.5 border-l-2 border-foreground/20 pl-3.5">
          {key_points.map((point, index) => (
            <li key={`${point}-${index}`} className="card-body max-w-prose text-default">
              {point}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
