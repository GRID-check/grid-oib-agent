import type { ApplicableStatus } from '@/lib/oib/applicable-standards'
import { Chip } from '@/components/ui/chip'
import { cn } from '@/lib/utils'

/**
 * Dedicated chips for the "Applicable standards" panel.
 *
 * Two distinct marks, kept visually separate on purpose:
 *  - {@link OibCodeChip}     — the Richtlinie identifier (e.g. "OIB 2.1"). A
 *    fixed-width, rounded-rectangle mono tag so every code reads as the same
 *    kind of token and the titles beside them line up across rows. (Not the
 *    pill-shaped {@link Chip}: identifiers want a stable, aligned footprint,
 *    not a hug-the-content oval.)
 *  - {@link ApplicabilityChip} — the applicability verdict (Required / Check /
 *    Likely), built on the design-system {@link Chip} with a leading status dot.
 *
 * Both are server-renderable so the Overview can stream them.
 */

/**
 * The OIB-Richtlinie code as a compact, monospaced identifier tag. Fixed width
 * so codes of different lengths ("OIB 5" vs "OIB 2.1") share one footprint and
 * the titles that follow align down the column.
 */
export function OibCodeChip({ code, className }: { code: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 w-16 shrink-0 items-center justify-center rounded-md border bg-muted',
        'font-mono text-xs font-medium tracking-tight text-foreground tabular-nums',
        className
      )}
    >
      {code}
    </span>
  )
}

/** Map an applicability verdict to a {@link Chip} variant. */
const chipVariantForStatus = {
  required: 'info',
  check: 'warning',
  likely: 'muted',
} as const

/**
 * The applicability verdict as a {@link Chip} with a leading dot. The dot uses
 * `currentColor`, so it always matches the verdict's text/background pairing.
 * The colour tracks the `status`; the visible `label` is supplied by the caller
 * so the copy can be localized.
 */
export function ApplicabilityChip({
  status,
  label,
  className,
}: {
  status: ApplicableStatus
  label: string
  className?: string
}) {
  return (
    <Chip variant={chipVariantForStatus[status]} className={cn('gap-1.5', className)}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      {label}
    </Chip>
  )
}
