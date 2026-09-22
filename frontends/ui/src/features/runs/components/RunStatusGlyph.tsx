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
 *
 * ## The swap
 *
 * A change of glyph is the moment the run's story turns, so it is one small
 * fixed move rather than a cut: the old glyph fades out over a snap, then the
 * new one pops in from 60% — `AnimatePresence mode="wait"`, keyed by the glyph
 * rather than the status, so `angelegt → laeuft` (spinner to spinner) swaps
 * nothing. `delay` holds the swap back for a choreography that has something
 * to finish first (the rail's last check, on `fertig`); it reaches the leaving
 * glyph through `custom`, because an exit transition is read at the moment of
 * leaving and the leaving glyph was rendered before anyone knew the delay.
 */

'use client'

import type { FC } from 'react'
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, XCircle } from 'lucide-react'
import type { Transition } from 'motion/react'

import { AnimatePresence, motion, motionInstant, motionSnap } from '@/components/motion'
import { Spinner } from '@/components/ui/spinner'
import { useReducedMotion } from '@/hooks/use-reduced-motion'
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

/** Which face a status wears; two statuses share the spinner. */
const glyphKey = (status: RunStatus): 'spinner' | IconStatus =>
  status === 'angelegt' || status === 'laeuft' ? 'spinner' : status

/**
 * Out on a snap, in on a snap from 60% — the scale is the "pop", and 40% of a
 * 20px icon is 8px of travel, a tween's job. The exit takes its whole
 * transition from `custom` (see the module comment), so the delay and the
 * reduced-motion collapse both reach the glyph that is already leaving.
 */
const swap = {
  hidden: { opacity: 0, scale: 0.6 },
  shown: { opacity: 1, scale: 1 },
  exit: (transition: Transition) => ({ opacity: 0, transition }),
}

export interface RunStatusGlyphProps {
  status: RunStatus
  /**
   * The spinner's spoken label. Omit it where a visible status word sits
   * beside the glyph: the word is the announcement, and a label here would
   * say the same thing twice — and would go on saying the OLD thing while the
   * outgoing spinner finishes leaving.
   */
  spinnerLabel?: string
  size?: keyof typeof SIZE
  /** Seconds to hold the swap back, for a landing that has something to finish first. */
  delay?: number
  className?: string
}

export const RunStatusGlyph: FC<RunStatusGlyphProps> = ({
  status,
  spinnerLabel,
  size = 'md',
  delay = 0,
  className,
}) => {
  const dims = SIZE[size]
  const reduced = useReducedMotion()
  const key = glyphKey(status)
  const Icon = key === 'spinner' ? null : GLYPH_ICON[key]
  const enter = reduced ? motionInstant : motionSnap
  const leave = reduced ? motionInstant : { ...motionSnap, delay }
  return (
    <span
      data-testid={`run-glyph-${status}`}
      className={cn(
        'relative flex shrink-0 items-center justify-center',
        dims.slot,
        key === 'spinner' ? 'text-muted-foreground' : GLYPH_TONE[key],
        className,
      )}
    >
      {/* `initial={false}`: a block that mounts finished shows its check, it
          does not pop it. `custom` is read by the LEAVING glyph's exit. */}
      <AnimatePresence mode="wait" initial={false} custom={leave}>
        <motion.span
          key={key}
          className="flex"
          variants={swap}
          initial="hidden"
          animate="shown"
          exit="exit"
          custom={leave}
          transition={enter}
        >
          {Icon ? (
            <Icon className={dims.icon} aria-hidden="true" />
          ) : (
            <Spinner
              size={dims.spinner}
              {...(spinnerLabel ? { label: spinnerLabel } : { 'aria-hidden': true })}
            />
          )}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
