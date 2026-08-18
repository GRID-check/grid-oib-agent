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
 *   ┌ Noch etwas? ────────┐              ← disclosed once a reason is chosen
 *   └─────────────────────┘  [Hinweis senden]
 *
 * The vote is the whole transaction: `useAnswerFeedback` persists it the moment
 * a thumb is pressed, so the confirmation is the truth about what happened and
 * is stated once, on the vote's own line. The reason and the note are a
 * SEPARATE, optional second act, disclosed one step at a time — never an open
 * form sitting under a "thanks" that claims the same act is already finished.
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
 * `springPress` on the thumb press (the user's own gesture resolving, ≈2px of
 * travel), `springSnap` on the confirmation's check mark only — the confirmation
 * TEXT is never animated, so nothing delays reading it. The reason row is a
 * disclosure: `duration-base` + `ease-entrance`, transform/opacity only, never
 * height. Reduced motion is honoured globally (`MotionConfig reducedMotion`)
 * and per-class for the CSS half.
 */

import { useCallback, useState, type FC, type FormEvent } from 'react'
import { Check, ThumbsDown, ThumbsUp } from 'lucide-react'
import { motion, springPress, springSnap } from '@/components/motion'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { FOCUS_RING } from '@/components/ui/focus-ring'
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
   * `compact` renders the row inside the answer's merged meta row (next to
   * confidence and the timestamp) rather than as its own block. The resting row
   * is identical either way — the only difference is that an OPEN disclosure
   * claims the full width of the meta row, so its left edge lines up with the
   * answer's instead of floating at the row's right end.
   */
  compact?: boolean
  className?: string
}

/**
 * The thumbs. 24px glyph, `touch-target` for the finger's 44px, muted at rest
 * and full-contrast on hover/focus — a footnote that does not compete with the
 * answer above it.
 */
const thumbBase = cn(
  'inline-flex size-6 items-center justify-center rounded-md',
  'text-muted-foreground/70 transition-colors duration-quick ease-out motion-reduce:transition-none',
  'hover:bg-accent hover:text-foreground',
  'touch-target',
  FOCUS_RING,
)

/** Selected: ink fill. Weight and fill, never chroma. */
const thumbSelected = 'bg-foreground text-background hover:bg-foreground hover:text-background'

export const AnswerFeedback: FC<AnswerFeedbackProps> = ({ messageId, conversationId, compact = false, className }) => {
  const t = useTranslations('chat')
  const projectId = useChatStore((s) => s.projectId)
  const { state, setFeedback } = useAnswerFeedback(messageId, conversationId, projectId)
  const [comment, setComment] = useState('')

  const verdict = state?.verdict ?? null
  const reason = state?.reason ?? null
  /** The note is the LAST step and only exists once a reason names the problem;
   *  a persisted comment means the second act is finished, so it collapses. */
  const showNote = verdict === 'down' && reason !== null && !state?.comment
  const promptId = `answer-feedback-reason-${messageId}`
  const commentId = `answer-feedback-comment-${messageId}`

  const handleUp = useCallback(() => {
    setComment('')
    // Toggle-off deletes; anything else is an upsert.
    setFeedback(verdict === 'up' ? null : { verdict: 'up', reason: null, comment: null })
  }, [verdict, setFeedback])

  const handleDown = useCallback(() => {
    setComment('')
    setFeedback(verdict === 'down' ? null : { verdict: 'down', reason: null, comment: null })
  }, [verdict, setFeedback])

  const handleReason = useCallback(
    (next: string) => {
      // Radix hands back '' when the pressed item is toggled off: the vote
      // stands, only the reason is withdrawn.
      setFeedback({
        verdict: 'down',
        reason: next ? (next as AnswerFeedbackReason) : null,
        comment: state?.comment ?? null,
      })
    },
    [setFeedback, state?.comment],
  )

  const handleCommentSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const next = comment.trim()
      if (!next) return
      setFeedback({ verdict: 'down', reason: reason ?? 'other', comment: next })
      setComment('')
    },
    [comment, setFeedback, reason],
  )

  return (
    <div
      className={cn(
        'group/feedback flex flex-col gap-2 text-xs',
        // In the meta row an open disclosure takes its own full-width line, so
        // the whole block shares one left edge with the answer above it.
        compact && verdict === 'down' && 'w-full',
        className,
      )}
    >
      {/* The footnote itself. `min-h-6` is reserved so the confirmation swapping
          in for the question cannot move anything below it. */}
      <div className="flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1">
        {verdict === null && (
          <span className="text-[11px] text-muted-foreground/80 transition-colors duration-quick ease-out group-hover/feedback:text-muted-foreground motion-reduce:transition-none">
            {t('feedback.question')}
          </span>
        )}
        <div className="flex items-center gap-1">
          <motion.button
            type="button"
            onClick={handleUp}
            aria-pressed={verdict === 'up'}
            aria-label={t('feedback.helpfulAria')}
            whileTap={{ scale: 0.88 }}
            transition={springPress}
            className={cn(thumbBase, verdict === 'up' && thumbSelected)}
          >
            <ThumbsUp className="size-3.5" aria-hidden="true" />
          </motion.button>
          <motion.button
            type="button"
            onClick={handleDown}
            aria-pressed={verdict === 'down'}
            aria-label={t('feedback.notHelpfulAria')}
            whileTap={{ scale: 0.88 }}
            transition={springPress}
            className={cn(thumbBase, verdict === 'down' && thumbSelected)}
          >
            <ThumbsDown className="size-3.5" aria-hidden="true" />
          </motion.button>
        </div>
        {/* What the vote alone commits, stated once, on the vote's own line. */}
        <p role="status" className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {verdict !== null && (
            <>
              {/* Only the mark moves; the sentence is legible from frame one. */}
              <motion.span
                initial={{ scale: 0.6 }}
                animate={{ scale: 1 }}
                transition={springSnap}
                className="inline-flex"
                aria-hidden="true"
              >
                <Check className="size-3" />
              </motion.span>
              {t('feedback.thanks')}
            </>
          )}
        </p>
      </div>

      {verdict === 'down' && (
        <div className="flex w-full max-w-md flex-col gap-2 animate-in fade-in-0 slide-in-from-top-1 duration-base ease-entrance motion-reduce:animate-none">
          <p id={promptId} className="text-[11px] text-muted-foreground">
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
                className="h-7 px-2.5 text-xs data-[state=on]:border-transparent data-[state=on]:bg-foreground data-[state=on]:text-background data-[state=on]:shadow-2xs"
              >
                {t(`feedback.reasons.${key}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {showNote && (
            <form
              className="animate-in fade-in-0 slide-in-from-top-1 duration-base ease-entrance motion-reduce:animate-none"
              onSubmit={handleCommentSubmit}
            >
              <Field className="gap-1.5">
                <FieldLabel htmlFor={commentId} className="text-[11px] font-normal text-muted-foreground">
                  {t('feedback.commentLabel')}
                </FieldLabel>
                <Textarea
                  id={commentId}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder={t('feedback.commentPlaceholder')}
                  rows={2}
                  maxLength={2000}
                  className="min-h-14 resize-none rounded-lg py-2 text-xs md:text-xs"
                />
                {/* Ink when it will do something, 50% ink when it will not —
                    the two states are never a question of grey vs. grey. */}
                <Button
                  type="submit"
                  size="sm"
                  className="h-7 w-fit px-3 text-xs disabled:opacity-40"
                  disabled={comment.trim() === ''}
                >
                  {t('feedback.commentSubmit')}
                </Button>
              </Field>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
