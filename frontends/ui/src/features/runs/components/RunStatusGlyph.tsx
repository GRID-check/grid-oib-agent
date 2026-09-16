/**
 * RunStatusGlyph — the one icon per run status, shared by the full block and
 * the compact line so a run cannot wear one face in the thread and another in
 * the Aufträge index.
 *
 * The ladder is the Herleitung bar's, extended to seven: a spinner while the
 * run moves (the only ambient loop the block owns), a clock while it waits for
 * the reader, a check when it is done, a triangle when it was cut short, a
 * cross when it failed, a struck circle when the reader stopped it. Each sits
 * in the same slot so the status word beside it never shifts when the state
 * changes — the reader is looking at exactly that word at exactly that moment.
 *
 * Colour rides on the glyph and never alone: the bold status word next to it
 * says the same thing in text.
 */

import type { FC } from 'react'
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, XCircle } from 'lucide-react'

import { Spinner } from '@/components/ui/spinner'
import type { RunStatus } from '@/lib/runs/run-ledger-types'
import { cn } from '@/lib/utils'

type IconStatus = Exclude<RunStatus, 'angelegt' | 'laeuft'>

const GLYPH_TONE: Record<IconStatus, string> = {
  wartet: 'text-brand',
  fertig: 'text-success',
  fehlgeschlagen: 'text-error',
  abgebrochen: 'text-muted-foreground',
  unterbrochen: 'text-warning',
}

const GLYPH_ICON: Record<IconStatus, typeof Clock> = {
  wartet: Clock,
  fertig: CheckCircle2,
  fehlgeschlagen: XCircle,
  abgebrochen: CircleSlash,
  unterbrochen: AlertTriangle,
}

/** The slot and the icon inside it: the bar's 20px, or the line's 16px. */
const SIZE = {
  md: { slot: 'size-5', icon: 'size-5', spinner: 'sm' },
  sm: { slot: 'size-4', icon: 'size-4', spinner: 'xs' },
} as const

export interface RunStatusGlyphProps {
  status: RunStatus
  /** The spinner's spoken label; the icons are decorative beside the status word. */
  spinnerLabel: string
  size?: keyof typeof SIZE
  className?: string
}

export const RunStatusGlyph: FC<RunStatusGlyphProps> = ({
  status,
  spinnerLabel,
  size = 'md',
  className,
}) => {
  const dims = SIZE[size]
  if (status === 'angelegt' || status === 'laeuft') {
    return (
      <span
        data-testid={`run-glyph-${status}`}
        className={cn(
          'flex shrink-0 items-center justify-center text-muted-foreground',
          dims.slot,
          className,
        )}
      >
        <Spinner size={dims.spinner} label={spinnerLabel} />
      </span>
    )
  }
  const Icon = GLYPH_ICON[status]
  return (
    <span
      data-testid={`run-glyph-${status}`}
      className={cn('flex shrink-0 items-center justify-center', dims.slot, GLYPH_TONE[status], className)}
    >
      <Icon className={dims.icon} aria-hidden="true" />
    </span>
  )
}
