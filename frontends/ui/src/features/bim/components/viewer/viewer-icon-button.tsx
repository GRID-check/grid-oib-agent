'use client'

/**
 * Every control in the viewport's chrome.
 *
 * An icon with no visible text is a control with no name, and a viewport made
 * of them is a puzzle. So the label is REQUIRED and it does two jobs from one
 * prop: the tooltip a mouse sees and the accessible name a screen reader
 * hears. There is no way to add a control here and forget to name it.
 *
 * ## What the label does NOT reach: a finger
 *
 * `title` renders nothing on iOS Safari or Android Chrome, and Radix's tooltip
 * trigger returns early on `pointerType === 'touch'` — a tap cannot open it
 * either, because its `onFocus` path is gated on a preceding pointer-down. So
 * on a touch device these controls are unlabelled glyphs, and no amount of
 * wiring here changes that: it is what every touch drawing tool ships, and
 * icons in a bottom dock are learned by pressing them.
 *
 * What that rules out is putting INFORMATION in a label. A state a reader can
 * only discover by hovering does not exist on a phone, so anything the reader
 * has to know — a capture that failed, why a toggle is disabled — needs a
 * carrier of its own. `model-stage.tsx` puts those in the warning pill and the
 * live region rather than swapping a name here and hoping.
 *
 * Built on the shared `Button` rather than a bespoke element, so the focus
 * ring, the coarse-pointer target size and the press animation are the app's
 * and stay the app's. The only thing this adds is the pressed state — filled
 * ink, matching every other selected control in Grid — and the promise that a
 * toggle reports `aria-pressed` rather than looking pressed and saying nothing.
 */

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ComponentType,
  type ReactNode,
} from 'react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface ViewerIconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'title' | 'children'> {
  /** The control's name: the tooltip, and the accessible name. Not a channel
   * for anything a touch reader has to know — see the note above. */
  label: string
  icon: ComponentType<{ className?: string }>
  onClick?: () => void
  /**
   * Present when this control is a TOGGLE, and then it also drives
   * `aria-pressed`. Absent for an action (Home, Close), which has no state to
   * report and must not claim one.
   */
  active?: boolean
  disabled?: boolean
  /** Where the tooltip goes. Bottom-dock controls want it above them. */
  side?: 'top' | 'bottom' | 'left' | 'right'
  /** Rendered after the icon — the chevron on a control that opens a menu. */
  adornment?: ReactNode
  className?: string
}

/**
 * The control itself, with no tooltip around it.
 *
 * Exists because Radix's `asChild` clones a single DOM-forwarding child, and
 * `ViewerIconButton` returns a `Tooltip` root — which is not one. A control
 * that also opens a popover therefore has to reach the button directly, or the
 * popover's props land on a wrapper element and the button keeps none of them:
 * no `aria-expanded`, no `aria-haspopup`, and — the part that actually breaks
 * — no keyboard activation, because focus sits on a button that is not the
 * trigger.
 *
 * Every prop is forwarded, so Radix can drive it.
 */
export const ViewerIconButtonBase = forwardRef<HTMLButtonElement, ViewerIconButtonProps>(
  function ViewerIconButtonBase(
    { label, icon: Icon, onClick, active, disabled, side: _side, adornment, className, ...rest },
    ref
  ) {
    return (
      <Button
        ref={ref}
        type="button"
        // A toggle reports its state; an action has none to report.
        {...(active === undefined ? {} : { 'aria-pressed': active })}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={onClick}
        variant={active ? 'default' : 'ghost'}
        size="icon"
        className={cn(
          'size-9 rounded-md',
          // An adornment makes the control wider than square; `icon` is a
          // fixed size, so the width has to be released explicitly.
          adornment && 'w-auto gap-1 px-2',
          className
        )}
        {...rest}
      >
        <Icon className="size-4" aria-hidden="true" />
        {adornment}
      </Button>
    )
  }
)

export const ViewerIconButton = forwardRef<HTMLButtonElement, ViewerIconButtonProps>(
  function ViewerIconButton({ side = 'top', ...props }, ref) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <ViewerIconButtonBase ref={ref} {...props} />
        </TooltipTrigger>
        <TooltipContent side={side} sideOffset={8}>
          {props.label}
        </TooltipContent>
      </Tooltip>
    )
  }
)
