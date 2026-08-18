'use client'

/**
 * When Piloti answers here — stated, and changeable (ADR-0036).
 *
 * A shared thread routes a message that tags nobody by its engagement mode:
 * `ask` sends it to Piloti, `mention` sends it to the chat. That is a rule with
 * real consequences, and a rule the reader cannot see is a rule they will be
 * surprised by — the surprise being either "why did Piloti butt into our
 * conversation?" or "why did nobody answer my question?".
 *
 * So this is deliberately NOT a dismissible announcement. It is a permanent, quiet
 * one-liner that is simultaneously:
 *   - the explanation, available at the moment the question occurs rather than at
 *     the moment the mode changed (which may have been days and one device ago);
 *   - the control, because the person who wants the rule different is exactly the
 *     person reading the explanation.
 *
 * Two shapes, and the difference matters:
 *
 *   - in `mention` mode it STATES the rule and offers the way back;
 *   - in `ask` mode it is silent unless the server suggests otherwise, in which
 *     case it OFFERS `mention` — it never announces a change, because no change
 *     happened. `ask` is the default and stays the default however many people are
 *     in the thread: Piloti is the point of this product, not a guest in someone
 *     else's chat app, and a thread must not rewire who answers next because a
 *     colleague typed "danke".
 */

import { useState } from 'react'
import { AtSign } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'

import { motion } from '@/components/motion'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import type { ConversationEngagement } from '@/lib/db/schema'
import { cn } from '@/lib/utils'

export interface EngagementNoticeProps {
  /** The mode in force, already resolved server-side. */
  mode: ConversationEngagement
  /**
   * A mode worth offering, or null. Server-derived from a structural fact (how
   * many people have written here), never from a judgement about what they wrote —
   * and never applied on its own.
   */
  suggestion?: ConversationEngagement | null
  /**
   * Change it. Resolves false when the server refused, which must be visible —
   * a control that silently does nothing is worse than no control.
   */
  onChange: (mode: ConversationEngagement) => Promise<boolean> | boolean
  /** Hidden for a reader who cannot write here: it is not their rule to change. */
  canChange?: boolean
  className?: string
}

export function EngagementNotice({
  mode,
  suggestion = null,
  onChange,
  canChange = true,
  className,
}: EngagementNoticeProps): JSX.Element | null {
  const t = useTranslations('collaboration')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const offering = mode === 'ask' ? suggestion : 'ask'
  // `ask` with nothing to offer is the ordinary case: the composer's "Geht an
  // Piloti" already says everything true, and a line repeating it is furniture
  // (spec NF-8). An offer nobody may accept is not worth stating either.
  if (mode === 'ask' && (!suggestion || !canChange)) return null

  const change = async (next: ConversationEngagement): Promise<void> => {
    setSaving(true)
    setFailed(false)
    try {
      if ((await onChange(next)) === false) setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    // Fades in rather than appearing between frames. This line arrives on its own
    // schedule — the server decides there is a mode worth offering, which can land
    // while the reader is mid-sentence in the composer directly above it — and
    // furniture that materialises abruptly next to a text field reads as a jolt.
    // Opacity and a 2px settle only: it must not push the composer around.
    <motion.div
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      data-testid="engagement-notice"
      data-engagement={mode}
      // `items-start`, and the icon is a sibling of a text COLUMN rather than one
      // more item in a single wrapping row. As one flat `flex-wrap` row every line
      // after the first fell back to the container's left edge, so the explanation
      // hung ~14px OUTSIDE the label it belongs to; and `items-center` floated the
      // icon to the middle of a two-line block instead of sitting on its first line.
      className={cn('text-muted-foreground flex items-start gap-2 text-xs', className)}
    >
      <AtSign className="mt-[0.15rem] size-3.5 shrink-0" aria-hidden />
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {mode === 'mention' ? (
        <>
          <span className="text-foreground/80 font-medium">
            {t('mentions.engagement.mentionLabel')}
          </span>
          <span className="min-w-0">{t('mentions.engagement.mentionHint')}</span>
        </>
      ) : (
        <span className="min-w-0">{t('mentions.engagement.offerHint')}</span>
      )}

      {canChange && offering && (
        <Button
          variant="ghost"
          size="sm"
          // Underlined AT REST, not only on hover. Without it the action was prose
          // weight and prose colour sitting directly beside the sentence it belongs
          // to — indistinguishable from the explanation, and therefore a control
          // nobody presses. Dotted keeps it quiet: this is an offer, not a CTA.
          className={cn(
            'h-6 px-1.5 text-xs font-medium',
            'text-foreground/90 underline decoration-dotted decoration-from-font underline-offset-[3px]',
            'transition-colors duration-150 ease-out hover:decoration-solid hover:text-foreground',
            'motion-reduce:transition-none',
          )}
          disabled={saving}
          onClick={() => void change(offering)}
        >
          {saving && <Spinner size="xs" aria-hidden className="mr-1" />}
          {offering === 'ask'
            ? t('mentions.engagement.switchToAsk')
            : t('mentions.engagement.switchToMention')}
        </Button>
      )}

      {failed && (
        <span
          role="alert"
          className="text-error animate-in fade-in-0 duration-150 ease-out motion-reduce:animate-none"
        >
          {t('mentions.engagement.failed')}
        </span>
      )}
      </span>
    </motion.div>
  )
}
