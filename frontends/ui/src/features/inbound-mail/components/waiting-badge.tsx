'use client'

/**
 * The muted count on Dateien in the rail and the phone's tab bar: mails
 * waiting in the project's E-Mail-Eingang for this reader.
 *
 * Muted, never the Postfach's ink: the rail has one pill that asks for
 * attention, and it is the Postfach's (`InboxBadge`). This one is a quiet
 * number beside a place, the `CountPill` muted tone. Nothing at zero; the
 * real count is in the label, the pill caps at 99+.
 */

import type { JSX } from 'react'
import { CountPill } from '@/components/ui/count-pill'
import { useTranslations } from '@/i18n'

export function InboundMailWaitingBadge({ count, className }: { count: number | null; className?: string }): JSX.Element | null {
  const t = useTranslations('nav')
  if (count === null || !Number.isFinite(count) || count <= 0) return null
  return (
    <CountPill
      tone="muted"
      role="status"
      aria-label={t('inboundMailWaiting', { count })}
      data-testid="inbound-mail-badge"
      data-waiting={count}
      className={className}
      count={count}
    />
  )
}
