'use client'

import * as React from 'react'
import * as SheetPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { OVERLAY_MOTION, OVERLAY_EXIT, OVERLAY_REDUCED } from '@/components/ui/overlay-motion'

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
 * there. Radix drives that through `data-[state]` keyframes, and this surface
 * takes a TWEEN rather than one of the springs.
 *
 * That is the honest reading of the pixel budget, not a lack of ambition. A
 * sheet's travel is its own width, so an overshooting spring's error is
 * enormous here: `springDrawer` is 1.4%, which is 4.0px on the 288px mobile nav
 * and 6.3px on a 448px `sm:max-w-md` panel, against a 1-2px budget. The budget's
 * own arithmetic puts `springDrawer` in range only to ~145px. A panel half the
 * screen wide that flies 6px past its edge and comes back is the slapstick the
 * vocabulary exists to prevent, and no softer spring fixes it — at this travel
 * anything with a visible overshoot percentage is out of budget by
 * construction, and anything damped enough to be in budget is an ease-out with
 * extra steps.
 *
 * So: `--motion-deliberate` on `--ease-entrance`. The decision lands at the
 * START of the move, which is what an arriving surface wants, and the same pair
 * `DockedPanel` uses — the app's two large sliding panels now agree on what
 * "a panel arriving" feels like. The exit is one step shorter on `--ease-exit`
 * via `OVERLAY_EXIT`, because nobody wants to watch a thing they dismissed.
 */
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
        style={style}
        className={cn(
          'fixed z-50 flex flex-col gap-4 overflow-y-auto bg-background p-6 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out '
            + 'data-[state=open]:ease-entrance data-[state=open]:duration-deliberate '
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
