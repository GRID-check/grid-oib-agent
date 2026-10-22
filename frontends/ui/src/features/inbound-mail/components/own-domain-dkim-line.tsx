'use client'

/**
 * How often the office's own mail arrives „Domain bestätigt“ (RT-X6): the
 * share of the last 30 days' member mail that the office's domain signed,
 * derived from the mail itself, never from a DNS probe. When the domain signs
 * nothing, it says so and links how to set it up, because every unsigned
 * colleague's mail will ask for a confirmation before filing.
 *
 * Nothing is shown before the office has sent any mail: there is no share of
 * nothing to report.
 */

import type { JSX } from 'react'
import { ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

/** At or below this share the office's domain is treated as not signing at all. */
const NOT_SIGNING = 0.05

export function OwnDomainDkimLine({ share, className }: { share: number | null; className?: string }): JSX.Element | null {
  const t = useTranslations('inboundMail')
  const { locale } = useLocale()
  if (share === null || !Number.isFinite(share)) return null
  const clamped = Math.min(1, Math.max(0, share))
  if (clamped <= NOT_SIGNING) {
    return (
      <p className={cn('text-foreground flex items-start gap-1.5 text-xs leading-snug', className)} data-testid="own-domain-dkim" data-state="missing">
        <ShieldAlert className="text-warning mt-px size-3.5 shrink-0" aria-hidden />
        <a
          href={t('address.ownDomain.helpUrl')}
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 hover:underline"
        >
          {t('address.ownDomain.missing')}
          <ExternalLink className="ml-1 inline size-3 align-[-1px]" aria-hidden />
        </a>
      </p>
    )
  }
  const percent = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(clamped * 100)
  return (
    <div className={cn('flex flex-col gap-0.5', className)} data-testid="own-domain-dkim" data-state="share">
      <p className="text-muted-foreground flex items-start gap-1.5 text-xs leading-snug">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>{t('address.ownDomain.share', { percent })}</span>
      </p>
      {clamped < 1 && <p className="text-muted-foreground pl-5 text-xs leading-snug">{t('address.ownDomain.explain')}</p>}
    </div>
  )
}
