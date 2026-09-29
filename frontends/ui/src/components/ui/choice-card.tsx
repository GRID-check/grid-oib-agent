'use client'

import * as React from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'
import { FOCUS_RING } from '@/components/ui/focus-ring'

/**
 * ChoiceCard — a single-choice question answered by picking a tile.
 *
 * A radio group whose options are big enough to carry an icon, a label and a
 * one-line hint: the shape for a first question that frames everything after
 * it ("what kind of feedback is this?"), where a row of 16px radios would make
 * the reader read before they can choose. Radix supplies the semantics — one
 * tab stop, arrow keys between options, `role="radio"` — so the tile is only
 * the paint.
 *
 * @example
 * <ChoiceCardGroup value={kind} onValueChange={setKind} aria-label="Art">
 *   <ChoiceCard value="bug" icon={Bug} label="Fehler" hint="Etwas funktioniert nicht" />
 * </ChoiceCardGroup>
 */
const ChoiceCardGroup = React.forwardRef<
  React.ElementRef<typeof RadioGroupPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Root>
>(({ className, ...props }, ref) => (
  <RadioGroupPrimitive.Root
    ref={ref}
    data-slot="choice-card-group"
    className={cn('grid grid-cols-2 gap-2 sm:grid-cols-4', className)}
    {...props}
  />
))
ChoiceCardGroup.displayName = 'ChoiceCardGroup'

export interface ChoiceCardProps
  extends Omit<React.ComponentPropsWithoutRef<typeof RadioGroupPrimitive.Item>, 'children'> {
  icon: LucideIcon
  label: string
  hint?: string
}

const ChoiceCard = React.forwardRef<React.ElementRef<typeof RadioGroupPrimitive.Item>, ChoiceCardProps>(
  ({ className, icon: Icon, label, hint, ...props }, ref) => (
    <RadioGroupPrimitive.Item
      ref={ref}
      data-slot="choice-card"
      className={cn(
        'group/choice bg-card text-foreground flex min-h-[88px] flex-col items-start gap-1.5 rounded-lg border p-3 text-left',
        'transition-[background-color,border-color,box-shadow,transform] duration-quick ease-out motion-reduce:transition-none',
        'hover:bg-accent active:scale-[0.98] active:duration-snap motion-reduce:active:scale-100',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary/5 data-[state=checked]:shadow-sm',
        'disabled:cursor-not-allowed disabled:opacity-50',
        FOCUS_RING,
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          'bg-muted text-muted-foreground flex size-7 items-center justify-center rounded-md transition-colors duration-quick',
          'group-data-[state=checked]/choice:bg-primary group-data-[state=checked]/choice:text-primary-foreground',
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="text-sm leading-tight font-medium">{label}</span>
      {hint && <span className="text-muted-foreground text-xs leading-snug">{hint}</span>}
    </RadioGroupPrimitive.Item>
  ),
)
ChoiceCard.displayName = 'ChoiceCard'

export { ChoiceCard, ChoiceCardGroup }
