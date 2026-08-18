import { type FC } from 'react'
import type { SummaryCardData } from '../types'

/**
 * SummaryCard — the answer headline + intro, rendered flat so it reads as the
 * top of the "Ergebnis" card (click-dummy anatomy): a 17px/600 headline, a
 * 14px/1.65 intro, and an optional key-point list. No card chrome — it sits
 * directly on the result surface.
 *
 * The key points hang off a rule rather than off `list-disc`. Three discs at
 * body weight read as a paragraph that happens to be indented; the rule binds
 * them into one block the eye can take in without reading it, which is the
 * only reason to lift them out of the intro in the first place.
 */
export const SummaryCard: FC<SummaryCardData> = ({ title, content, key_points }) => {
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex flex-col gap-[11px]">
      <p className="text-[17px] font-semibold tracking-display text-foreground">{title}</p>

      {content && <p className="text-[14px] leading-[1.65] text-default">{content}</p>}

      {key_points && key_points.length > 0 && (
        <ul className="flex flex-col gap-1.5 border-l-2 border-border pl-3.5">
          {key_points.map((point, index) => (
            <li key={`${point}-${index}`} className="max-w-prose text-[13.5px] leading-[1.55] text-default">
              {point}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
