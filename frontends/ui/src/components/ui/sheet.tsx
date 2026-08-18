'use client'

import * as React from 'react'
import * as SheetPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { OVERLAY_MOTION, OVERLAY_EXIT, OVERLAY_REDUCED } from '@/components/ui/overlay-motion'
import { springDrawerLinear } from '@/components/motion'

/**
 * Side sheet — a Dialog anchored to an edge instead of the centre.
 *
 * Built on the same Radix Dialog the modal uses (no new dependency), so focus
 * trapping, escape handling and scroll locking are identical. The difference
 * is intent: a modal interrupts to ask a question, a sheet shows the detail of
 * the row you selected while the list stays put behind it.
 *
 * Admin lists reached for one of two bad options before this existed: cram
 * every control inline into each row, or throw a modal for a detail view.
 *
 * Full width under `sm` — a 24rem panel on a phone is a modal with extra steps.
 */

const Sheet = SheetPrimitive.Root
const SheetTrigger = SheetPrimitive.Trigger
const SheetClose = SheetPrimitive.Close
const SheetPortal = SheetPrimitive.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-overlay backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 '
        + OVERLAY_MOTION,
      className,
    )}
    {...props}
  />
))
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName

const SIDE_CLASSES = {
  right:
    'inset-y-0 right-0 h-full w-full border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-md',
  left: 'inset-y-0 left-0 h-full w-full border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-md',
  bottom:
    'inset-x-0 bottom-0 max-h-[90dvh] border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
} as const

export type SheetSide = keyof typeof SIDE_CLASSES

/**
 * THE SLIDE. A sheet is the design language's DIRECTION-OF-TRAVEL case: it comes
 * from a named edge and the reader has to know which one, so it can be sent back
 * there. That is a spring earned on trajectory, and at this size the spring is
 * `springDrawer` (ζ = 0.806, 1.4% overshoot) — never `springSnap`, whose 24px
 * travel ceiling this blows past by an order of magnitude.
 *
 * Radix drives the slide through `data-[state]` keyframes, so it takes the CSS
 * `linear()` sampling rather than the JS spring. It rides on a custom property
 * set inline, and is applied through a `data-[state=open]:` variant (specificity
 * 0-2-0) so it beats the plain `ease-entrance` class (0-1-0) below it REGARDLESS
 * of the order Tailwind happens to emit them in. An engine without `linear()`
 * drops the declaration and the `ease-entrance` underneath stands — the
 * documented degrade path, and the reason the fallback is a real easing rather
 * than tw-animate-css's default `ease`.
 *
 * OVERSHOOT, IN PIXELS, HONESTLY: this slide's travel is the panel's own width,
 * so 1.4% is 4.0px on the 288px mobile nav sheet and 6.3px on a 448px
 * `sm:max-w-md` panel. Both are OVER the 1–2px budget the design language sets,
 * and 6.3px is a visible bounce. The budget's own arithmetic says `springDrawer`
 * lands in range up to ~145px of travel. Flagged rather than silently shipped:
 * the fix is a shorter entrance travel (slide the panel in from a partial
 * offset, not from fully offscreen), not a softer spring — see the report.
 */
const SHEET_SPRING = { '--sheet-spring': springDrawerLinear } as React.CSSProperties

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> {
  side?: SheetSide
  /** Accessible label for the close button. */
  closeLabel?: string
}

const SheetContent = React.forwardRef<React.ElementRef<typeof SheetPrimitive.Content>, SheetContentProps>(
  ({ className, children, side = 'right', closeLabel = 'Close', style, ...props }, ref) => (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Content
        ref={ref}
        // Merged, not overwritten: a caller passing `style` must not silently
        // strip the custom property the open-state easing resolves against.
        style={{ ...SHEET_SPRING, ...style }}
        className={cn(
          'fixed z-50 flex flex-col gap-4 overflow-y-auto bg-background p-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out '
            + 'ease-entrance data-[state=open]:duration-deliberate '
            + 'data-[state=open]:[animation-timing-function:var(--sheet-spring)] '
            + `${OVERLAY_EXIT} ${OVERLAY_REDUCED}`,
          SIDE_CLASSES[side],
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close
          className={cn(
            'absolute right-4 top-4 rounded-sm text-muted-foreground opacity-70 outline-none transition-opacity duration-quick ease-out hover:opacity-100 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none touch-target',
            FOCUS_RING,
          )}
        >
          <X className="size-4" aria-hidden />
          <span className="sr-only">{closeLabel}</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPortal>
  ),
)
SheetContent.displayName = SheetPrimitive.Content.displayName

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div className={cn('flex flex-col gap-1.5 pr-8', className)} {...props} />
)
SheetHeader.displayName = 'SheetHeader'

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div className={cn('mt-auto flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
)
SheetFooter.displayName = 'SheetFooter'

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title ref={ref} className={cn('text-base font-semibold', className)} {...props} />
))
SheetTitle.displayName = SheetPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description ref={ref} className={cn('text-sm text-muted-foreground', className)} {...props} />
))
SheetDescription.displayName = SheetPrimitive.Description.displayName

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
}
