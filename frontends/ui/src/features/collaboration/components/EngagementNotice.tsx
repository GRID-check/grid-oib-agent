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
 * Shown only in `mention` mode. In `ask` mode the composer's "Geht an Piloti"
 * already says everything true, and a second line saying the same thing would be
 * furniture (spec NF-8).
 */

import { useState } from 'react'
import { AtSign, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import type { ConversationEngagement } from '@/lib/db/schema'
import { cn } from '@/lib/utils'

export interface EngagementNoticeProps {
  /** The mode in force, already resolved server-side. */
  mode: ConversationEngagement
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
  onChange,
  canChange = true,
  className,
}: EngagementNoticeProps): JSX.Element | null {
  const t = useTranslations('collaboration')
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  if (mode !== 'mention') return null

  const change = async (): Promise<void> => {
    setSaving(true)
    setFailed(false)
    try {
      if ((await onChange('ask')) === false) setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      data-testid="engagement-notice"
      data-engagement={mode}
      className={cn(
        'text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs',
        className
      )}
    >
      <AtSign className="size-3.5 shrink-0" aria-hidden />
      <span className="text-foreground/80 font-medium">
        {t('mentions.engagement.mentionLabel')}
      </span>
      <span className="min-w-0">{t('mentions.engagement.mentionHint')}</span>

      {canChange && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-xs underline-offset-2 hover:underline"
          disabled={saving}
          onClick={() => void change()}
        >
          {saving && <Loader2 className="mr-1 size-3 animate-spin" aria-hidden />}
          {t('mentions.engagement.switchToAsk')}
        </Button>
      )}

      {failed && (
        <span role="alert" className="text-error">
          {t('mentions.engagement.failed')}
        </span>
      )}
    </div>
  )
}
