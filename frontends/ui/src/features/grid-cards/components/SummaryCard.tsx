import { type FC } from 'react'
import type { SummaryCardData } from '../types'

/**
 * SummaryCard — the answer headline + intro, rendered flat so it reads as the
 * top of the "Ergebnis" card (click-dummy anatomy): a 17px/600 headline, a
 * 14px/1.65 intro, and an optional key-point list. No card chrome — it sits
 * directly on the result surface.
 */
export const SummaryCard: FC<SummaryCardData> = ({ title, content, key_points }) => {
  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 flex flex-col gap-[11px]">
      <p className="text-[17px] font-semibold tracking-display text-foreground">{title}</p>

      {content && <p className="text-[14px] leading-[1.65] text-default">{content}</p>}

      {key_points && key_points.length > 0 && (
        <ul className="flex list-disc flex-col gap-1 pl-4">
          {key_points.map((point, index) => (
            <li key={`${point}-${index}`} className="text-[13.5px] leading-[1.6] text-default">
              {point}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
