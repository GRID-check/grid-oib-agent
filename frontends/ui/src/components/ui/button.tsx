'use client'

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { Spinner } from '@/components/ui/spinner'

const buttonVariants = cva(
  // `min-w-11` covers the narrow cases the `size` heights cannot: an icon-only
  // button that uses `default`/`sm` rather than `icon`, or one whose label is a
  // single glyph. It is a floor, so it never squeezes a wider button.
  //
  // THE PRESS. `active:scale-[0.98]` is the one moving thing on this control,
  // and it is the press half of `springPress` — ζ = 1.00, 0% overshoot, so its
  // OVERSHOOT AT ANY TRAVEL IS 0px. A critically damped spring IS an ease-out,
  // which is why this stays a CSS transition on a plain <button> instead of
  // spending a `linear()` sampling on a curve that has no bounce to describe.
  // What it does buy is the settle time: springPress has ωn = √(600/0.6) =
  // 31.6 rad/s, so it is within 2% of target in ~126ms — `duration-snap`.
  //
  // The duration is a LIST matched to the property list: colour and shadow keep
  // the 180ms default (`--motion-quick`), the transform gets the 120ms press
  // curve (`--motion-snap`). One `duration-*` utility could not say that, and
  // running the press at the colour's duration is what made the dip read as a
  // lag rather than as the button giving way.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[color,background-color,box-shadow,transform] [transition-duration:var(--motion-quick),var(--motion-quick),var(--motion-quick),var(--motion-snap)] ease-out active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 outline-none pointer-coarse:min-w-11 aria-invalid:ring-destructive/20 aria-invalid:border-destructive " +
    FOCUS_RING,
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-interaction-primary-hover dark:hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/40',
        outline:
          'border border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline active:scale-100',
      },
      // Two pointers, two sizes. The desktop heights are tuned for a cursor,
      // which lands where it is pointed; a fingertip does not, and below ~44px
      // the miss rate climbs (WCAG 2.2 Target Size, iOS/Material both land on
      // 44–48px). `pointer-coarse` asks the question that actually matters —
      // "is this being driven by a finger?" — instead of proxying it through
      // viewport width, so a touch tablet past `md` is covered too and a
      // narrow desktop window is left at its intended density.
      size: {
        default: 'h-9 px-5 py-2 pointer-coarse:h-11',
        sm: 'h-8 px-3.5 text-xs pointer-coarse:h-11',
        lg: 'h-11 px-6 text-base',
        icon: 'size-9 pointer-coarse:size-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /**
   * In-flight. The spinner takes the leading icon's place — same 16px glyph in
   * the same slot — so the label neither moves nor disappears and the button
   * keeps its width; a button that swaps its label for a spinner makes the
   * reader re-read it to find out what they just triggered. Also implies
   * `disabled` (a second click would fire the action twice) and `aria-busy`,
   * which is what actually tells a screen reader the wait is expected.
   *
   * Ignored under `asChild`: Slot takes exactly one child, so there is nowhere
   * to put the spinner without the caller composing it themselves.
   */
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    const showSpinner = loading && !asChild
    // `children` is passed through UNTOUCHED unless the spinner is actually
    // rendered: under `asChild`, Slot demands exactly one element child, and
    // wrapping it in a fragment — even one whose other half is `null` — is what
    // makes Slot throw "Expected a single React element child".
    const content = showSpinner ? (
      <>
        <Spinner size="sm" aria-hidden="true" className="shrink-0" />
        {children}
      </>
    ) : (
      children
    )
    return (
      <Comp
        data-slot="button"
        className={cn(
          buttonVariants({ variant, size }),
          // Hide the caller's first `<svg>` child — the leading icon at every
          // current call site — rather than sitting the spinner beside it: two
          // icons is a busier button, not a busy one, and dropping the glyph is
          // what keeps the width identical to the resting state.
          showSpinner && '[&>svg:first-of-type]:hidden',
          className
        )}
        ref={ref}
        disabled={disabled || loading || undefined}
        aria-busy={loading || undefined}
        {...props}
      >
        {content}
      </Comp>
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
