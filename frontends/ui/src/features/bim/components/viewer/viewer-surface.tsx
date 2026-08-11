'use client'

/**
 * The material every floating control in the viewport is made of.
 *
 * One atom, one definition. Before this, the dock, the rail, the status chip
 * and the legend each spelled their own `bg-background/85 backdrop-blur`, so
 * they drifted: four opacities, three radii, two shadow tokens, and a dark
 * mode that only two of them had been checked in. A viewport whose chrome does
 * not agree with itself reads as unfinished no matter how good the render is.
 *
 * The material is paper held just off the canvas: a translucent card, a
 * hairline, and the popover elevation — the same recipe as the app's own
 * surfaces, so the controls read as belonging to Grid rather than to the
 * renderer.
 *
 * `supports-[backdrop-filter]` is not decoration. Where blur is unavailable
 * (older Firefox, some Linux compositors) a 70%-opaque panel over a shaded
 * model is unreadable, so those browsers get an opaque one instead.
 */

import { forwardRef, type HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export interface ViewerSurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * `raised` is chrome that floats over the model — the dock, the rail.
   * `flat` is chrome that sits INSIDE another surface (a section inside the
   * rail) and must not restate the elevation, or the stack reads as a pile.
   */
  tone?: 'raised' | 'flat'
}

export const ViewerSurface = forwardRef<HTMLDivElement, ViewerSurfaceProps>(
  function ViewerSurface({ className, tone = 'raised', ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="viewer-surface"
        className={cn(
          'rounded-2xl border border-border',
          tone === 'raised'
            ? 'bg-card/80 shadow-md backdrop-blur-md supports-[backdrop-filter]:bg-card/70'
            : 'bg-transparent',
          className
        )}
        {...props}
      />
    )
  }
)
