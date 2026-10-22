'use client'

/**
 * The head of one held mail: its subject, who it is from (name and address,
 * never one without the other), when it was sent and received, how far the
 * sender is confirmed and the flags that change what filing needs, who it
 * originally came from when it was forwarded („· nicht geprüft“), its
 * recipients behind a disclosure, and the original `.eml`.
 *
 * The original is downloaded through a fetch, so a refusal (the whole message
 * is scanned again on every request, D6) arrives as a sentence, not as a JSON
 * file in the downloads folder. Its warning is said before the press: it
 * opens in a mail program, which loads images from outside.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ChevronDown, Download, Forward, Info, ShieldAlert, Timer } from 'lucide-react'
import { BusyButton } from '@/components/ui/busy-button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Toggletip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useLocale, useTranslations } from '@/i18n'
import { downloadFetched } from '@/lib/browser-download'
import type { InboundMailView } from '@/lib/inbound-mail/inbound-mail-wire'
import { formatAbsoluteTime, formatCalendarDate } from '@/lib/format'
import type { ForwardedOrigin } from '../lib/forwarded'
import { senderDisplayName } from '../lib/sender'
import { displaySubject } from '../lib/subject'
import { FactLine } from './inbound-mail-atoms'
import { SenderTrustLines } from './sender-trust'

export interface MailHeaderProps {
  view: InboundMailView
  forwarded: ForwardedOrigin | null
  originalUrl: string
}

export function MailHeader({ view, forwarded, originalUrl }: MailHeaderProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const { locale } = useLocale()
  const [downloading, setDownloading] = useState(false)
  const subject = displaySubject(view.subject) ?? t('row.noSubject')
  const recipients = view.participants.filter((participant) => participant.role !== 'from')

  const download = async (): Promise<void> => {
    setDownloading(true)
    try {
      const result = await downloadFetched(originalUrl, 'original.eml')
      if (!result.saved) {
        toast.error(result.reason === 'original_not_clean' ? t('refusals.original_not_clean') : t(`refusals.${result.reason === 'gone' ? 'gone' : 'unknown'}`))
      }
    } finally {
      setDownloading(false)
    }
  }

  return (
    <header className="flex flex-col gap-3" data-testid="mail-header">
      <h2 className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere]" title={view.subject ?? undefined}>
        {subject}
      </h2>
      {view.sender && (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm [overflow-wrap:anywhere]">
            {t('header.from', { name: senderDisplayName(view.sender), address: view.sender.address })}
          </p>
          <p className="text-muted-foreground flex flex-wrap gap-x-2 text-xs tabular-nums">
            {view.sentAt && <span>{t('header.sent', { time: formatAbsoluteTime(view.sentAt, locale) })}</span>}
            <span>{t('header.received', { time: formatAbsoluteTime(view.receivedAt, locale) })}</span>
          </p>
          <SenderTrustLines sender={view.sender} />
        </div>
      )}
      {forwarded && (
        <p className="text-muted-foreground flex items-start gap-1.5 text-xs" data-testid="mail-forwarded">
          <Forward className="mt-px size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {t('header.forwardedFrom', {
              who: forwarded.name && forwarded.address ? `${forwarded.name} ‹${forwarded.address}›` : (forwarded.name ?? forwarded.address ?? ''),
            })}
          </span>
          <Toggletip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('header.forwardedExplain')}
                className="hover:text-foreground touch-target inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <Info className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">{t('header.forwardedExplain')}</TooltipContent>
          </Toggletip>
        </p>
      )}
      {recipients.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group/recipients inline-flex items-center gap-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60 rounded-sm touch-target">
            {t('header.participants')} ({recipients.length})
            <ChevronDown className="size-3.5 transition-transform duration-quick group-data-[state=open]/recipients:rotate-180 motion-reduce:transition-none" aria-hidden />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="text-muted-foreground mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
              {recipients.map((participant, index) => (
                <div key={`${participant.role}-${participant.address}-${index}`} className="contents">
                  <dt>{t(`header.${participant.role === 'reply_to' ? 'replyTo' : participant.role}`)}</dt>
                  <dd className="[overflow-wrap:anywhere]">{participant.name ? `${participant.name} ‹${participant.address}›` : participant.address}</dd>
                </div>
              ))}
            </dl>
          </CollapsibleContent>
        </Collapsible>
      )}
      <div className="flex flex-col gap-1.5">
        {view.originalHeld && view.rawScan === 'clean' && (
          <div className="flex flex-col items-start gap-1">
            <BusyButton
              type="button"
              variant="outline"
              size="sm"
              busy={downloading}
              busyLabel={t('header.original')}
              icon={<Download aria-hidden />}
              onClick={() => void download()}
              data-testid="mail-original"
            >
              {t('header.original')}
            </BusyButton>
            <p className="text-muted-foreground text-xs">{t('header.originalHint')}</p>
          </div>
        )}
        {view.originalHeld && view.rawScan === 'infected' && (
          <FactLine icon={ShieldAlert} tone="danger" testId="mail-original-infected">
            {t('header.originalNotClean')}
          </FactLine>
        )}
        {view.originalHeld && (view.rawScan === 'pending' || view.rawScan === 'failed') && (
          <FactLine icon={Timer}>{t('header.originalScanning')}</FactLine>
        )}
        {view.status === 'waiting' && (
          <FactLine icon={Timer}>{t('header.expires', { date: formatCalendarDate(view.expiresAt, locale) })}</FactLine>
        )}
      </div>
    </header>
  )
}
