'use client'

/**
 * AnswerFeedback — quiet per-answer thumbs row (WS-7, `answer-feedback` flag).
 *
 * "War das hilfreich?" + thumbs up/down under an assistant answer. Up lights
 * with the --status-active tint; down opens the fixed reason chips
 * (inaccurate / too_slow / wrong_source / other), then a small thanks line.
 * Votes persist through /api/feedback/answers (optimistic, revert on error;
 * hydrated once per conversation) — see use-answer-feedback.
 */

import { useCallback, useState, type FC, type FormEvent } from 'react'
import { ThumbsDown, ThumbsUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
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
   * `compact` renders the question as a whisper-weight inline label so the row
   * can sit inside the answer's merged meta row (next to confidence and the
   * timestamp) instead of owning a full-width band with its own divider.
   */
  compact?: boolean
  className?: string
}

const thumbButtonBase =
  // The thumbs sit under an answer as a quiet aside, so the 24px button stays
  // 24px and `touch-target` gives the finger the 44px it needs.
  'inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-[color,background-color,transform] duration-200 ease-out active:scale-95 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring touch-target'

export const AnswerFeedback: FC<AnswerFeedbackProps> = ({ messageId, conversationId, compact = false, className }) => {
  const t = useTranslations('chat')
  const projectId = useChatStore((s) => s.projectId)
  const { state, setFeedback } = useAnswerFeedback(messageId, conversationId, projectId)
  const [showReasons, setShowReasons] = useState(false)
  const [comment, setComment] = useState('')

  const verdict = state?.verdict ?? null

  const handleUp = useCallback(() => {
    setShowReasons(false)
    setComment('')
    // Toggle-off deletes; anything else is an upsert.
    setFeedback(verdict === 'up' ? null : { verdict: 'up', reason: null, comment: null })
  }, [verdict, setFeedback])

  const handleDown = useCallback(() => {
    if (verdict === 'down') {
      setShowReasons(false)
      setComment('')
      setFeedback(null)
      return
    }
    setFeedback({ verdict: 'down', reason: null, comment: null })
    setShowReasons(true)
  }, [verdict, setFeedback])

  const handleReason = useCallback(
    (reason: AnswerFeedbackReason) => {
      setFeedback({ verdict: 'down', reason, comment: comment.trim() || null })
    },
    [setFeedback, comment],
  )

  const handleCommentSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const next = comment.trim()
      if (!next) return
      setFeedback({
        verdict: 'down',
        reason: state?.reason ?? 'other',
        comment: next,
      })
      setShowReasons(false)
    },
    [comment, setFeedback, state?.reason],
  )

  const showThanks = verdict === 'up' || (verdict === 'down' && state?.reason != null)

  return (
    <div
      className={cn(
        // Compact mode lives inside the answer's merged meta row, so reasons
        // and the thanks line must flow inline beside the thumbs (and wrap
        // under them) instead of stacking a column that would stretch the row.
        compact ? 'flex flex-wrap items-center gap-x-1.5 gap-y-1' : 'flex flex-col gap-1.5',
        className
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('text-muted-foreground', compact ? 'text-[11px]' : 'text-xs')}>
          {t('feedback.question')}
        </span>
        <button
          type="button"
          onClick={handleUp}
          aria-pressed={verdict === 'up'}
          aria-label={t('feedback.helpfulAria')}
          className={cn(
            thumbButtonBase,
            verdict === 'up' && 'bg-status-active-tint text-status-active hover:bg-status-active-tint hover:text-status-active',
          )}
        >
          {/* `key` remounts the icon on toggle so the pop replays every vote —
              a static class alone animates only on first mount. */}
          <ThumbsUp
            key={verdict === 'up' ? 'up-on' : 'up-off'}
            className={cn(
              'size-3.5',
              verdict === 'up' && 'animate-in zoom-in-50 duration-150 motion-reduce:animate-none'
            )}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          onClick={handleDown}
          aria-pressed={verdict === 'down'}
          aria-label={t('feedback.notHelpfulAria')}
          className={cn(
            thumbButtonBase,
            verdict === 'down' && 'bg-signal-error-tint text-signal-error hover:bg-signal-error-tint hover:text-signal-error',
          )}
        >
          <ThumbsDown
            key={verdict === 'down' ? 'down-on' : 'down-off'}
            className={cn(
              'size-3.5',
              verdict === 'down' && 'animate-in zoom-in-50 duration-150 motion-reduce:animate-none'
            )}
            aria-hidden="true"
          />
        </button>
      </div>

      {showReasons && (
        <div
          className="animate-in fade-in-0 slide-in-from-top-1 flex w-full max-w-md flex-col gap-2 duration-150 motion-reduce:animate-none"
        >
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('feedback.reasonPrompt')}>
            <span className="text-xs text-muted-foreground">{t('feedback.reasonPrompt')}</span>
            {REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                onClick={() => handleReason(reason)}
                aria-pressed={state?.reason === reason}
                className={cn(
                  'rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-[color,background-color,transform] duration-200 ease-out active:scale-95 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  state?.reason === reason && 'border-foreground/30 bg-muted text-foreground',
                )}
              >
                {t(`feedback.reasons.${reason}`)}
              </button>
            ))}
          </div>
          <form className="flex flex-col gap-1.5" onSubmit={handleCommentSubmit}>
            <label className="sr-only" htmlFor={`answer-feedback-comment-${messageId}`}>
              {t('feedback.commentLabel')}
            </label>
            <Textarea
              id={`answer-feedback-comment-${messageId}`}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={t('feedback.commentPlaceholder')}
              rows={2}
              maxLength={2000}
              className="min-h-14 resize-none text-xs"
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              className="h-7 w-fit px-2.5 text-xs"
              disabled={comment.trim() === ''}
            >
              {t('feedback.commentSubmit')}
            </Button>
          </form>
        </div>
      )}

      {showThanks && (
        <p className="animate-in fade-in-0 text-xs text-muted-foreground duration-200 motion-reduce:animate-none">
          {t('feedback.thanks')}
        </p>
      )}
    </div>
  )
}
