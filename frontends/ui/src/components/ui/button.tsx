'use client'

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const buttonVariants = cva(
  // `min-w-11` covers the narrow cases the `size` heights cannot: an icon-only
  // button that uses `default`/`sm` rather than `icon`, or one whose label is a
  // single glyph. It is a floor, so it never squeezes a wider button.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-200 ease-out active:scale-95 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 outline-none pointer-coarse:min-w-11 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
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
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        data-slot="button"
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
