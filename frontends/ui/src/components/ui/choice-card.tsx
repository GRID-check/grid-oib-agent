'use client'

/**
 * A choice that needs a sentence: a card per option, the option's name and
 * one line on what choosing it means, one of them chosen.
 *
 * For the answers a one-word chip cannot carry — „einmalig" against
 * „wiederkehrend", a Prüfbericht against an Aktenvermerk — where the reader is
 * choosing between behaviours, not labels. Built on the Radix radio group, so
 * it is a radio group to assistive technology AND to the keyboard: one tab
 * stop, arrow keys move the choice. The two copies this replaced (the schedule
 * wizard's cadence cards and the research plan's genre tiles) were
 * `role="radio"` buttons with neither.
 *
 * Chosen is the product's primary hairline and its subtle wash, plus a check —
 * contrast and a mark, never a provenance hue.
 */

import * as React from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { Check, type LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

const ChoiceCards = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root
    ref={ref}
    data-slot="choice-cards"
    className={cn('grid gap-2 sm:grid-cols-2 lg:grid-cols-3', className)}
    {...props}
  />
))
ChoiceCards.displayName = 'ChoiceCards'

interface ChoiceCardProps extends React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item> {
  label: string
  hint: string
  icon?: LucideIcon
}

const ChoiceCard = React.forwardRef<React.ElementRef<typeof RadioGroupPrimitive.Item>, ChoiceCardProps>(
  ({ className, label, hint, icon: Icon, ...props }, ref) => (
    <RadioGroupPrimitive.Item
      ref={ref}
      data-slot="choice-card"
      className={cn(
        'group/choice border-border bg-card flex min-h-16 flex-col items-start gap-1 rounded-lg border px-3 py-2.5 text-left',
        'transition-[border-color,background-color,box-shadow] duration-quick ease-out motion-reduce:transition-none',
        'hover:border-muted-foreground/40',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary-subtle data-[state=checked]:shadow-xs',
        'focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2',
        'disabled:cursor-default disabled:opacity-60',
        className
      )}
      {...props}
    >
      <span className="flex w-full items-center gap-1.5">
        {Icon && (
          <Icon
            className="text-muted-foreground group-data-[state=checked]/choice:text-foreground size-4 shrink-0 transition-colors duration-quick"
            aria-hidden
          />
        )}
        <span className="text-foreground text-sm font-medium">{label}</span>
        <RadioGroupPrimitive.Indicator
          className="text-foreground animate-in fade-in-0 zoom-in-50 ml-auto flex duration-quick ease-out motion-reduce:animate-none"
          aria-hidden
        >
          <Check className="size-3.5" />
        </RadioGroupPrimitive.Indicator>
      </span>
      <span className="text-muted-foreground text-xs leading-relaxed">{hint}</span>
    </RadioGroupPrimitive.Item>
  )
)
ChoiceCard.displayName = 'ChoiceCard'

export { ChoiceCards, ChoiceCard }
