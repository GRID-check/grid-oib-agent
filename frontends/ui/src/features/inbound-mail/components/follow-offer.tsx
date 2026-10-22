'use client'

/**
 * „Diesem E-Mail-Verlauf folgen“, offered once a mail's text is filed into a
 * thread and only where a later reply could ever qualify (`followOffered`).
 *
 * It is a standing decision, so it says in one line what it will do and what
 * it will not: replies from confirmed domains already in the conversation are
 * added without a click; attachments still wait here. Pressing it is the
 * decision; the toast it leaves carries the undo.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { Check, Repeat2 } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

export interface FollowOfferProps {
  threadName: string
  /** Follow the thread; rejects when the server refused. */
  onFollow: () => Promise<void>
  /** Already following (after the press, or as the server says). */
  following?: boolean
  className?: string
}

export function FollowOffer({ threadName, onFollow, following = false, className }: FollowOfferProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(following)

  const follow = async (): Promise<void> => {
    setBusy(true)
    try {
      await onFollow()
      setDone(true)
    } catch {
      // The caller says what failed; the offer stands.
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cn('bg-card flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:gap-4', className)} data-testid="follow-offer">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <Repeat2 className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-sm font-medium [overflow-wrap:anywhere]" role={done ? 'status' : undefined}>
            {done ? t('follow.following', { name: threadName }) : t('follow.thread', { name: threadName })}
          </p>
          <p className="text-muted-foreground text-xs leading-snug">{t('follow.explain')}</p>
        </div>
      </div>
      {done ? (
        <Check className="text-muted-foreground size-4 shrink-0 self-start sm:self-center" aria-hidden data-testid="follow-offer-done" />
      ) : (
        <BusyButton
          type="button"
          size="sm"
          variant="outline"
          busy={busy}
          busyLabel={t('follow.busy')}
          onClick={() => void follow()}
          className="w-full sm:w-auto"
          data-testid="follow-offer-button"
        >
          {t('follow.offer')}
        </BusyButton>
      )}
    </div>
  )
}
