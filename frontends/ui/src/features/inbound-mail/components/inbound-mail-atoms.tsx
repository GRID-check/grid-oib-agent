'use client'

/**
 * The E-Mail-Eingang's own atoms: the few shapes its organisms repeat, written
 * once so the list, the detail and the decision bar are made of the same
 * material (`grid-design-language.md`, „Component layers“).
 *
 * - `FactLine`: one fact about a mail or a part, a glyph and words. Muted by
 *   default; `warning` for what must be seen before filing, `danger` for
 *   what makes filing impossible. Never colour without the glyph and words.
 * - `CheckLine`: a checkbox with its sentence, for the person's explicit yes
 *   („Trotzdem ablegen“). The whole line is the label, 44px under a finger.
 */

import type { JSX, ReactNode } from 'react'
import { useId } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'

export type FactTone = 'muted' | 'default' | 'warning' | 'danger'

/**
 * The warning gold is a signal for a glyph, not for small text: at 12px it
 * measures 4.48:1 on paper, under the 4.5:1 WCAG AA asks. So a warning line
 * draws its glyph in the warning tone and its words in ink, a step heavier.
 */
const FACT_TONE: Record<FactTone, string> = {
  muted: 'text-muted-foreground',
  default: 'text-foreground',
  warning: 'text-foreground font-medium [&>svg]:text-warning',
  danger: 'text-error',
}

export function FactLine({
  icon: Icon,
  tone = 'muted',
  children,
  className,
  testId,
}: {
  icon: LucideIcon
  tone?: FactTone
  children: ReactNode
  className?: string
  testId?: string
}): JSX.Element {
  return (
    <p className={cn('flex min-w-0 items-start gap-1.5 text-xs leading-snug', FACT_TONE[tone], className)} data-testid={testId} data-tone={tone}>
      <Icon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  )
}

export function CheckLine({
  checked,
  onCheckedChange,
  disabled,
  children,
  className,
  testId,
}: {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  children: ReactNode
  className?: string
  testId?: string
}): JSX.Element {
  const id = useId()
  return (
    <div className={cn('flex items-start gap-2 text-xs pointer-coarse:min-h-11 pointer-coarse:items-center', className)}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        data-testid={testId}
        className="mt-px pointer-coarse:mt-0"
      />
      <label htmlFor={id} className={cn('cursor-pointer select-none leading-snug', disabled && 'cursor-not-allowed opacity-60')}>
        {children}
      </label>
    </div>
  )
}
