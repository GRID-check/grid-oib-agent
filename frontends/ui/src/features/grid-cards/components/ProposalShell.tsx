'use client'

import { type ReactNode } from 'react'
import { Card } from '@/components/ui/card'
import { motion, springGentle } from '@/components/motion'
import { cn } from '@/lib/utils'

/** The left-accent tone of a proposal card by its lifecycle state. */
type ProposalTone = 'pending' | 'accepted' | 'dismissed'

const TONE_CLASS: Record<ProposalTone, string> = {
  pending: 'gap-3 border-l-warning',
  accepted: 'gap-2 border-l-success',
  dismissed: 'gap-2 border-l-subtle',
}

/**
 * The shared shell for user-confirmed proposal cards (`project_profile_patch`,
 * `memory_proposal`): a left-accented card that gently springs in, whose accent
 * colour tracks the proposal's lifecycle — amber while pending, green once
 * accepted, muted once dismissed. Both cards used to hand-roll this identical
 * `motion.div` + `Card border-l-2 p-5 shadow-xs` chrome and state machine; this
 * owns it once so they can't drift.
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
