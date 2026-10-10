'use client'

/**
 * AnswerFeedback — the footnote under an answer (WS-7, `answer-feedback` flag).
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 * ONE left edge, ONE vertical rhythm, read top-to-bottom:
 *
 *   War das hilfreich?  [👍] [👎]        ← resting: one 24px line, quiet
 *   ✓ Danke für Ihr Feedback.            ← lands on that SAME line after a vote
 *   Was war das Problem?                 ← down only, disclosed below it
 *   [Ungenau] [Zu langsam] [Falsche Quelle] [Sonstiges]
 *   ┌ Noch etwas? ────────┐              ← down only, with the reasons
 *   └─────────────────────┘
 *   Was hätte in einer guten Antwort stehen sollen?   ← optional, one line
 *   [ z. B. Brüstungshöhe 1,00 m laut OIB-RL 4 ]  [Hinweis senden]
 *
 * Two placements, one shape: standalone it is that block; `compact` hands the
 * row and the disclosure to the answer's meta row as two items, so the row keeps
 * its 24px line and the disclosure still opens under it at the same left edge.
 *
 * The vote is the whole transaction: `useAnswerFeedback` persists it the moment
 * a thumb is pressed, so the confirmation is the truth about what happened and
 * is stated once, on the vote's own line. The reason and the note are a
 * SEPARATE, optional second act — never an open form sitting under a "thanks"
 * that claims the same act is already finished. Reason and note are each
 * optional and neither waits for the other: when the note waited for a chip,
 * a voter who skipped the chips never saw it, and the October 2026 export had
 * down-votes with neither, nothing the cause labelling could read.
 *
 * ── Weight ───────────────────────────────────────────────────────────────────
 * This sits under EVERY answer, including one-line ones, so at rest it is a
 * 24px row of 11px muted ink that lifts to full contrast on hover/focus. The
 * row reserves `min-h-6` (the same reservation the answer's meta row makes), so
 * a verdict landing swaps content inside a box whose height never changes.
 *
 * ── Colour ───────────────────────────────────────────────────────────────────
 * NO chroma. Provenance green (`--status-active`) and error red
 * (`--signal-error`) both used to mark the thumbs; neither meaning applies — a
 * down-vote is not an error, and green is Projektwissen. Selected is ink FILL
 * instead (`bg-foreground text-background`) — unmistakable without borrowing a
 * signal colour, and the chosen reason chip repeats exactly that language, so
 * "selected" means one thing in this block.
 *
 * ── Motion ───────────────────────────────────────────────────────────────────
 * The shared press (`PRESSABLE`) on the thumbs, `iconSwapTransition` on the
 * confirmation's check mark (its scale springs, its opacity tweens). The question and the receipt share ONE slot left
 * of the thumbs and cross-fade in it (`duration-quick`): the question used to
 * unmount on the vote and the thumbs jumped ~98px left under the pointer that
 * had just pressed one. The reason disclosure takes its height smoothly
 * (`HeightArrival`) and stays mounted until it has folded away; inserted and
 * removed in one frame, it moved everything under it by ~240px. After the note
 * is sent the form folds and focus moves to the receipt, rather than falling
 * to the page. Reduced motion gets every end state at once.
 */

import { useCallback, useRef, useState, type FC, type FormEvent } from 'react'
import { Check, ThumbsDown, ThumbsUp } from 'lucide-react'
import { AnimatePresence, motion, useIconSwapTransition } from '@/components/motion'
import { HeightArrival } from '@/components/motion/height-arrival'
import { PRESSABLE } from '@/components/ui/press'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { AnswerFeedbackReason } from '@/lib/db/schema/answer-feedback'
import { useChatStore } from '../store'
import { useAnswerFeedback } from '../hooks/use-answer-feedback'

/** Fixed reason keys — mirror ANSWER_FEEDBACK_REASONS (type-checked below);
 *  a value import of the schema would pull drizzle into the client bundle. */
const REASONS: readonly AnswerFeedbackReason[] = ['inaccurate', 'too_slow', 'wrong_source', 'other']

export interface AnswerFeedbackProps {
  /** Client-side assistant message identifier (the chat store's message id). */
  messageId: string
  /** Conversation the answer belongs to (hydration scope); null-safe. */
  conversationId?: string | null
  /**
   * `compact` renders this inside the answer's merged meta row (beside the copy
   * actions and the details trigger) rather than as its own block.
   *
   * The difference is structural, not cosmetic: compact returns the resting row
   * and the disclosure as TWO siblings of that row rather than one nested block,
   * so the row itself lays them out. The resting row stays a 24px line beside
   * the copy actions, and the disclosure — `w-full`, so it can share a line with
   * nothing — takes the next line on its own, its left edge on the answer's.
   *
   * One box holding both is what the meta row cannot lay out: `items-center`
   * centres a 24px icon group against a 180px form, so the copy actions floated
   * mid-height in the footer's empty left half while the reason chips and the
   * note hung off the row's right end.
   */
  compact?: boolean
  className?: string
  /**
   * The answer is still arriving: the row holds its place, invisible and
   * inert, so it cannot be rated before it is complete, and fades in at the
   * settle (`AgentResponse`).
   */
  pending?: boolean
}

/**
 * The thumbs. 24px glyph, `touch-target` for the finger's 44px, muted at rest
 * and full-contrast on hover/focus — a footnote that does not compete with the
 * answer above it.
 */
const thumbBase = cn(
  'inline-flex size-6 items-center justify-center rounded-md',
  'text-muted-foreground/70',
  PRESSABLE,
  'hover:bg-accent hover:text-foreground',
  'touch-target',
  FOCUS_RING
)

/** Selected: ink fill. Weight and fill, never chroma. */
const thumbSelected = 'bg-foreground text-background hover:bg-foreground hover:text-background'

export const AnswerFeedback: FC<AnswerFeedbackProps> = ({
  messageId,
  conversationId,
  compact = false,
  className,
  pending = false,
}) => {
  const t = useTranslations('chat')
  const swap = useIconSwapTransition()
  const projectId = useChatStore((s) => s.projectId)
  const { state, setFeedback } = useAnswerFeedback(messageId, conversationId, projectId)
  const [comment, setComment] = useState('')
  const [expected, setExpected] = useState('')
  const receiptRef = useRef<HTMLParagraphElement>(null)

  const verdict = state?.verdict ?? null
  const reason = state?.reason ?? null
  /** The note sits beside the reasons, not behind them; a persisted comment
   *  means the second act is finished, so it collapses. */
  const showNote = verdict === 'down' && !state?.comment && !state?.expectedAnswer
  const promptId = `answer-feedback-reason-${messageId}`
  const commentId = `answer-feedback-comment-${messageId}`
  const expectedId = `answer-feedback-expected-${messageId}`

  const handleUp = useCallback(() => {
    setComment('')
    setExpected('')
    // Toggle-off deletes; anything else is an upsert.
    setFeedback(
      verdict === 'up' ? null : { verdict: 'up', reason: null, comment: null, expectedAnswer: null }
    )
  }, [verdict, setFeedback])

  const handleDown = useCallback(() => {
    setComment('')
    setExpected('')
    setFeedback(
      verdict === 'down'
        ? null
        : { verdict: 'down', reason: null, comment: null, expectedAnswer: null }
    )
  }, [verdict, setFeedback])

  const handleReason = useCallback(
    (next: string) => {
      // Radix hands back '' when the pressed item is toggled off: the vote
      // stands, only the reason is withdrawn.
      setFeedback({
        verdict: 'down',
        reason: next ? (next as AnswerFeedbackReason) : null,
        comment: state?.comment ?? null,
        expectedAnswer: state?.expectedAnswer ?? null,
      })
    },
    [setFeedback, state?.comment, state?.expectedAnswer]
  )

  const handleCommentSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const nextComment = comment.trim()
      const nextExpected = expected.trim()
      if (!nextComment && !nextExpected) return
      // A note without a chip keeps its reason null: "other" would be a
      // reason the voter never chose.
      setFeedback({
        verdict: 'down',
        reason,
        comment: nextComment || null,
        expectedAnswer: nextExpected || null,
      })
      setComment('')
      setExpected('')
      // The form folds away under the focus; hand it to the receipt, which
      // says what was just recorded, instead of dropping it on the page.
      receiptRef.current?.focus({ preventScroll: true })
    },
    [comment, expected, setFeedback, reason]
  )

  /* The footnote itself. `min-h-6` is reserved so the confirmation swapping in
     for the question cannot move anything below it. In the meta row this is the
     item that sits beside the copy actions, so it stays exactly one 24px line
     however much the disclosure under it holds. */
  const restingRow = (
    <div
      className={cn(
        'group/feedback flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs',
        'duration-base transition-opacity ease-out motion-reduce:transition-none',
        pending && 'opacity-0',
        compact && className
      )}
      inert={pending}
      aria-hidden={pending || undefined}
    >
      {/* One slot, two states: the question and the receipt are stacked in the
          same grid cell and cross-fade, so the slot is as wide as the wider of
          the two from the first frame and the thumbs beside it never move. */}
      <span className="grid items-center">
        <span
          aria-hidden={verdict !== null || undefined}
          className={cn(
            'text-muted-foreground/80 group-hover/feedback:text-muted-foreground col-start-1 row-start-1 text-[11px]',
            'duration-quick transition-[color,opacity] ease-out motion-reduce:transition-none',
            verdict !== null && 'opacity-0'
          )}
        >
          {t('feedback.question')}
        </span>
        {/* What the vote alone commits, stated once, on the vote's own line. */}
        <p
          ref={receiptRef}
          role="status"
          tabIndex={-1}
          className={cn(
            'text-muted-foreground col-start-1 row-start-1 flex items-center gap-1 text-[11px] outline-none',
            'duration-quick transition-opacity ease-out motion-reduce:transition-none',
            verdict === null && 'opacity-0'
          )}
        >
          {verdict !== null && (
            <>
              {/* Only the mark moves; the sentence is legible from frame one. */}
              <motion.span
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1, transition: swap.enter }}
                className="inline-flex"
                aria-hidden="true"
              >
                <Check className="size-3" />
              </motion.span>
              {/* What the press COMMITTED, not gratitude. The vote is persisted
                  on the press, so this line is the receipt for it — while the
                  reason and the note below are a second, optional act. Thanking
                  here read as if the exchange were over, directly under an open
                  "Was war das Problem?". */}
              {t('feedback.voteRecorded')}
            </>
          )}
        </p>
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={handleUp}
          aria-pressed={verdict === 'up'}
          aria-label={t('feedback.helpfulAria')}
          className={cn(thumbBase, verdict === 'up' && thumbSelected)}
        >
          <ThumbsUp className="size-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={handleDown}
          aria-pressed={verdict === 'down'}
          aria-label={t('feedback.notHelpfulAria')}
          className={cn(thumbBase, verdict === 'down' && thumbSelected)}
        >
          <ThumbsDown className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  )

  /* The second, optional act — one item, `w-full` in both placements. As a block
     that is simply the next line of the column; in the meta row a full-width
     item can share a line with nothing, so it takes the next one, its left edge
     on the answer's rather than hanging off the row's right end. `max-w-md`
     bounds the CONTENT rather than the item, so the full width that claims the
     line survives it. */
  const disclosure = (
    <AnimatePresence initial={false}>
      {verdict === 'down' && (
        <HeightArrival key="reasons" className="w-full">
          <div className="flex max-w-md flex-col gap-2 text-xs">
            <p id={promptId} className="text-muted-foreground text-[11px]">
              {t('feedback.reasonPrompt')}
            </p>
            {/* Exclusive choice, structurally: Radix renders a radiogroup with
            roving-focus arrow keys, so the chips are one tab stop. */}
            <ToggleGroup
              type="single"
              value={reason ?? ''}
              onValueChange={handleReason}
              variant="outline"
              size="sm"
              aria-labelledby={promptId}
              className="gap-1.5"
            >
              {REASONS.map((key) => (
                <ToggleGroupItem
                  key={key}
                  value={key}
                  // Selected is the SAME language as the selected thumb: ink fill,
                  // no chroma, unmistakable at a glance in a row of four.
                  className="data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:shadow-2xs h-7 px-2.5 text-xs data-[state=on]:border-transparent"
                >
                  {t(`feedback.reasons.${key}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            <AnimatePresence initial={false}>
              {showNote && (
                <HeightArrival key="note">
                  <form onSubmit={handleCommentSubmit}>
                    <Field className="gap-1.5">
                      <FieldLabel
                        htmlFor={commentId}
                        className="text-muted-foreground text-[11px] font-normal"
                      >
                        {t('feedback.commentLabel')}
                      </FieldLabel>
                      <Textarea
                        id={commentId}
                        value={comment}
                        onChange={(event) => setComment(event.target.value)}
                        placeholder={t('feedback.commentPlaceholder')}
                        rows={2}
                        maxLength={2000}
                        // 12px because a footnote about an answer must not out-weigh
                        // the answer. The `md:text-xs` that used to sit here was
                        // beating Textarea's `md:text-sm`; that override is now
                        // `pointer-coarse:text-base`, which this deliberately does NOT
                        // undo — a field this small still zooms iOS on focus, and a
                        // comment box is exactly where somebody is typing prose.
                        className="min-h-14 resize-none rounded-lg py-2 text-xs"
                      />
                      <FieldLabel
                        htmlFor={expectedId}
                        className="text-muted-foreground text-[11px] font-normal"
                      >
                        {t('feedback.expectedLabel')}
                      </FieldLabel>
                      <Input
                        id={expectedId}
                        value={expected}
                        onChange={(event) => setExpected(event.target.value)}
                        placeholder={t('feedback.expectedPlaceholder')}
                        maxLength={2000}
                        className="h-8 rounded-lg text-xs"
                      />
                      {/* Full ink when it will do something, 40% when it will not:
                  the difference is a contrast jump, not grey vs. grey. */}
                      <Button
                        type="submit"
                        size="sm"
                        className="h-7 w-fit px-3 text-xs disabled:opacity-40"
                        disabled={comment.trim() === '' && expected.trim() === ''}
                      >
                        {t('feedback.commentSubmit')}
                      </Button>
                    </Field>
                  </form>
                </HeightArrival>
              )}
            </AnimatePresence>
          </div>
        </HeightArrival>
      )}
    </AnimatePresence>
  )

  // Compact: two siblings, laid out by the meta row that owns them. Standalone:
  // one block that stacks them itself.
  if (compact) {
    return (
      <>
        {restingRow}
        {disclosure}
      </>
    )
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {restingRow}
      {disclosure}
    </div>
  )
}
