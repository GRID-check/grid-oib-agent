'use client'

import { useLayoutEffect, useRef, type ReactNode, type Ref } from 'react'
import { useIsPresent, type Transition } from 'motion/react'
import { Card } from '@/components/ui/card'
import {
  AnimatePresence,
  motion,
  motionEntrance,
  motionQuick,
  motionQuickExit,
  useMotionToken,
} from '@/components/motion'
import { useHeightGlide } from '@/components/motion/height-glide'
import { cn } from '@/lib/utils'
import { CARD_SHELL } from './card-chrome'

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
const TONE_ACCENT: Record<ProposalTone, string> = {
  pending: 'border-l-foreground/40',
  accepted: 'border-l-success',
  dismissed: 'border-l-subtle',
}

/** A question breathes more than its one-line receipt. */
const TONE_GAP: Record<ProposalTone, string> = {
  pending: 'gap-3',
  accepted: 'gap-2',
  dismissed: 'gap-2',
}

/**
 * One state's content. While it leaves it is out of reach: unclickable and
 * hidden from assistive tech, so a second press cannot land on a question
 * that has already been answered, and the receipt is the only thing read.
 */
function ProposalBody({
  ref,
  tone,
  enter,
  exit,
  children,
}: {
  ref: Ref<HTMLDivElement>
  tone: ProposalTone
  enter: Transition
  exit: Transition
  children: ReactNode
}) {
  const present = useIsPresent()
  return (
    <motion.div
      ref={ref}
      tabIndex={-1}
      data-proposal-body={tone}
      aria-hidden={present ? undefined : true}
      className={cn('flex flex-col outline-none', TONE_GAP[tone], !present && 'pointer-events-none')}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: enter }}
      exit={{ opacity: 0, transition: exit }}
    >
      {children}
    </motion.div>
  )
}

/**
 * The shared shell for user-confirmed proposal cards (`project_profile_patch`,
 * `memory_proposal`, `file_operation_proposal`): a left-accented card that
 * fades in, whose accent colour tracks the proposal's lifecycle — ink while
 * pending, green once accepted, muted once dismissed (see TONE_CLASS above for
 * why pending is ink and not amber). The cards used to hand-roll this
 * identical `motion.div` + `Card border-l-2 p-5 shadow-xs` chrome and state
 * machine; this owns it once so they can't drift.
 *
 * THE ANSWER IS ONE CARD CHANGING, not one card replaced by another. A card
 * returns `<ProposalShell tone=…>` from each branch, so React keeps this one
 * instance across the decision, and the shell turns the swap into motion:
 *
 *  - the accent eases to its new colour (`transition-colors` on the Card);
 *  - the question cross-fades into its receipt (`popLayout`: the outgoing body
 *    leaves the flow at once and fades out over the incoming one);
 *  - the card glides from the question's height to the receipt's
 *    (`useHeightGlide`), so the answer below is drawn up, not yanked — the
 *    reader pressed a button, and the 120px under it used to vanish in the
 *    frame they pressed it.
 *
 * And the keyboard is not dropped. The control the reader pressed leaves with
 * the question, and a focused node that leaves the document hands focus to
 * `<body>`, so the next Tab started from the top of the page. When focus was
 * inside the card, it moves to the receipt (`tabIndex={-1}`, no scroll), which
 * is also what makes a screen reader read the outcome.
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
  const frameRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const previousTone = useRef(tone)
  const enter = useMotionToken(motionQuick)
  const exit = useMotionToken(motionQuickExit)
  useHeightGlide(frameRef, tone)

  // The swap's commit: the outgoing body is still in the document (exiting),
  // so the focus it holds is still readable here, and the incoming body's ref
  // is already attached.
  useLayoutEffect(() => {
    if (previousTone.current === tone) return
    previousTone.current = tone
    const active = document.activeElement
    if (active && active !== document.body && frameRef.current?.contains(active)) {
      bodyRef.current?.focus({ preventScroll: true })
    }
  }, [tone])

  return (
    // A fade, no scale: the card arrives in the transcript where it will stay,
    // and a zoom from 98% made its edges and text swim for the length of the
    // entrance in a column of otherwise still prose.
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={motionEntrance}>
      <Card
        className={cn(
          CARD_SHELL,
          'border-l-2 p-5 transition-colors duration-base ease-out motion-reduce:transition-none',
          TONE_ACCENT[tone],
          className
        )}
      >
        {/* The frame the height glides on. `relative` is for `popLayout`,
            which positions the outgoing body absolutely against it. */}
        <div ref={frameRef} className="relative">
          <AnimatePresence mode="popLayout" initial={false}>
            <ProposalBody key={tone} ref={bodyRef} tone={tone} enter={enter} exit={exit}>
              {children}
            </ProposalBody>
          </AnimatePresence>
        </div>
      </Card>
    </motion.div>
  )
}
