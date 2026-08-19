'use client'

import { type ReactNode } from 'react'
import { Card } from '@/components/ui/card'
import { motion, springGentle } from '@/components/motion'
import { cn } from '@/lib/utils'

/** The left-accent tone of a proposal card by its lifecycle state. */
type ProposalTone = 'pending' | 'accepted' | 'dismissed'

/**
 * `pending` is INK, not amber.
 *
 * Lifecycle is its own axis (`grid-card-charter.md` §A3): "we are waiting for
 * you" is not "you are close to a limit", and amber already means the second
 * everywhere else in the set — on a Frist callout, on a tightening change, on a
 * measurement inside its tolerance band. Spending it here made an unanswered
 * question look like a compliance risk, and made a real compliance risk one
 * amber edge among several. Ink says "unresolved" without borrowing anyone
 * else's meaning, and the accepted/dismissed states still carry the verdict
 * colours they earn by being outcomes.
 */
const TONE_CLASS: Record<ProposalTone, string> = {
  pending: 'gap-3 border-l-foreground/40',
  accepted: 'gap-2 border-l-success',
  dismissed: 'gap-2 border-l-subtle',
}

/**
 * The shared shell for user-confirmed proposal cards (`project_profile_patch`,
 * `memory_proposal`): a left-accented card that gently springs in, whose accent
 * colour tracks the proposal's lifecycle — ink while pending, green once
 * accepted, muted once dismissed (see TONE_CLASS above for why pending is ink
 * and not amber). Both cards used to hand-roll this identical `motion.div` +
 * `Card border-l-2 p-5 shadow-xs` chrome and state machine; this owns it once
 * so they can't drift.
 */
export function ProposalShell({
  tone,
  className,
  children,
}: {
  tone: ProposalTone
  className?: string
  children: ReactNode
}) {
  return (
    <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={springGentle}>
      <Card className={cn('border-l-2 p-5 shadow-xs', TONE_CLASS[tone], className)}>{children}</Card>
    </motion.div>
  )
}
