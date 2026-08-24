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
 * The headline is the one element in the card set above 14px that is not a
 * figure, and §A2 exempts it by name — it is the answer's H1, not a card's
 * answer. The exemption has a price, paid here: when a `verdict_header` is also
 * on screen the headline drops to the Title step, because a 17px headline and a
 * 30px verdict arriving together give the reader two places to start.
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
          'text-foreground',
          hasVerdictHeader ? 'card-title' : 'card-headline',
        )}
      >
        {title}
      </p>

      {content && <p className="card-body text-default">{content}</p>}

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
