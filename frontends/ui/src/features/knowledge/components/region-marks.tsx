'use client'

import type { CSSProperties, FC } from 'react'
import type { PageRegion } from '../lib/page-region'

export interface RegionMarksProps {
  regions: readonly PageRegion[]
  /** CSS colour, so the box wears the tint of the chip that opened the viewer. */
  color?: string
  /** Changing it remounts the marks, which replays the arrival pulse. */
  ping?: number
}

/**
 * The boxes of a passage read off a picture of the page (issue #433), laid over
 * whatever shows that page: a PDF page's canvas or an uploaded image.
 *
 * Positioned in PERCENT of the element they sit in, because that is what a
 * region is — a share of the page as the viewer shows it — so it needs no
 * scale, survives every zoom step, and the parent only has to be `relative`
 * and exactly the size of the page.
 *
 * Two layers per box. The fill multiplies with the page, as the passage mark
 * does, so the drawing underneath stays readable through it. The label must
 * not multiply — a blended label on a dark line of the plan is unreadable — so
 * it sits beside the fill rather than inside it. The frame is an outline, which
 * the arrival pulse does not animate, so the box stays visible for the length
 * of the pulse rather than only after it.
 */
export const RegionMarks: FC<RegionMarksProps> = ({ regions, color, ping = 0 }) => (
  <>
    {regions.map((region, index) => {
      const [x0, y0, x1, y1] = region.box
      return (
        <span
          key={`${ping}-${index}`}
          data-testid="region-mark"
          className="pointer-events-none absolute"
          style={
            {
              left: `${x0 * 100}%`,
              top: `${y0 * 100}%`,
              width: `${(x1 - x0) * 100}%`,
              height: `${(y1 - y0) * 100}%`,
              ...(color ? { ['--passage-tint' as string]: color } : {}),
            } as CSSProperties
          }
        >
          <span
            aria-hidden
            className="passage-highlight region-highlight animate-passage-ping motion-reduce:animate-none absolute inset-0"
          />
          {region.label && (
            <span className="region-label absolute bottom-full left-0 mb-1 max-w-full truncate rounded-sm bg-card px-1.5 py-0.5 text-xs font-medium text-foreground shadow-sm">
              {region.label}
            </span>
          )}
        </span>
      )
    })}
  </>
)
