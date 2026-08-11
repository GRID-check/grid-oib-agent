'use client'

/**
 * Every control in the viewport's chrome.
 *
 * An icon with no visible text is a control with no name, and a viewport made
 * of them is a puzzle. So the label is REQUIRED and it does three jobs from one
 * prop: the tooltip a mouse sees, the accessible name a screen reader hears,
 * and the `title` a touch device gets on long-press. There is no way to add a
 * control here and forget to name it.
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
  /** The control's name. Tooltip, accessible name and long-press title. */
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
          'size-9 rounded-xl',
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
