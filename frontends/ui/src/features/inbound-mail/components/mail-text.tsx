'use client'

/**
 * The held mail's text, plain and inert.
 *
 * The server flattened it (HTML is never rendered here, no remote image is
 * ever loaded) and masked what the content check found. React escapes it; a
 * URL is printed as the text it is, never a live link, because a stranger
 * wrote it. The first lines stand open, the rest behind „Ganze E-Mail
 * anzeigen“, quoted earlier mails behind „Zitierten Text anzeigen“, each with
 * the line that introduced it.
 */

import type { JSX } from 'react'
import { useState } from 'react'
import { CalendarDays, EyeOff, FileWarning, Scissors } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadError } from '@/components/ui/load-error'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { useLocale, useTranslations } from '@/i18n'
import type { InboundMailTextView } from '@/lib/inbound-mail/inbound-mail-wire'
import { formatAbsoluteTime, formatCalendarDate } from '@/lib/format'
import { textPreview, textRuns, tidyText } from '../lib/mail-text'
import { FactLine } from './inbound-mail-atoms'

export type MailTextState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; text: InboundMailTextView }

function InertText({ text }: { text: string }): JSX.Element {
  const t = useTranslations('inboundMail')
  return (
    <>
      {textRuns(text).map((run, index) =>
        run.kind === 'text' ? (
          <span key={index}>{run.value}</span>
        ) : (
          <span key={index} title={t('text.linkTitle', { domain: run.domain })} className="text-muted-foreground underline decoration-dotted underline-offset-2">
            {run.value}
          </span>
        )
      )}
    </>
  )
}

const PROSE = 'text-foreground max-w-[72ch] whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]'

export function MailText({ state, onRetry }: { state: MailTextState; onRetry: () => void }): JSX.Element {
  const t = useTranslations('inboundMail')
  const { locale } = useLocale()
  const [expanded, setExpanded] = useState(false)
  const [quotedOpen, setQuotedOpen] = useState(false)

  let body: JSX.Element
  if (state.kind === 'loading') {
    body = (
      <div className="flex flex-col gap-2" aria-label={t('text.loading')} role="status">
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-10/12" />
        <Skeleton className="h-3.5 w-8/12" />
      </div>
    )
  } else if (state.kind === 'error') {
    body = <LoadError title={t('text.loadError')} onRetry={onRetry} />
  } else {
    const { text } = state
    const own = tidyText(text.ownText)
    const preview = textPreview(own)
    body = (
      <div className="flex flex-col gap-3">
        {text.unreadable ? (
          <FactLine icon={FileWarning} tone="warning">
            {t('text.unreadable')}
          </FactLine>
        ) : own === '' ? (
          <p className="text-muted-foreground text-sm">{t('text.empty')}</p>
        ) : (
          <div className="flex flex-col items-start gap-1.5">
            <p className={PROSE} data-testid="mail-text-own">
              <InertText text={expanded ? own : preview.head} />
            </p>
            {preview.more && (
              <Button type="button" variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => setExpanded((open) => !open)} aria-expanded={expanded}>
                {expanded ? t('text.showLess') : t('text.showAll')}
              </Button>
            )}
          </div>
        )}
        {text.masked && (
          <FactLine icon={EyeOff} testId="mail-text-masked">
            {t('text.masked')}
          </FactLine>
        )}
        {text.ownTextTruncated && (
          <FactLine icon={Scissors}>{t('text.truncated')}</FactLine>
        )}
        {text.calendar.map((event, index) => (
          <div key={index} className="bg-muted/40 flex flex-col gap-0.5 rounded-md border px-3 py-2 text-xs">
            <FactLine icon={CalendarDays} tone="default">
              {t('text.calendar', { summary: event.summary ?? '—' })}
            </FactLine>
            {event.start && (
              <p className="text-muted-foreground pl-5 tabular-nums">
                {event.allDay
                  ? t('text.calendarAllDay', { date: formatCalendarDate(event.start, locale) })
                  : t('text.calendarWhen', {
                      start: formatAbsoluteTime(event.start, locale),
                      end: event.end ? formatAbsoluteTime(event.end, locale) : '…',
                    })}
              </p>
            )}
            {event.location && <p className="text-muted-foreground pl-5 [overflow-wrap:anywhere]">{t('text.calendarLocation', { location: event.location })}</p>}
          </div>
        ))}
        {text.quoted.length > 0 && (
          <div className="flex flex-col items-start gap-2">
            <Button type="button" variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => setQuotedOpen((open) => !open)} aria-expanded={quotedOpen}>
              {quotedOpen ? t('text.hideQuoted') : t('text.showQuoted', { count: text.quoted.length })}
            </Button>
            {quotedOpen &&
              text.quoted.map((quote, index) => (
                <blockquote key={index} className="border-l-2 pl-3" data-testid="mail-text-quote">
                  {quote.header && <p className="text-muted-foreground mb-1 text-xs [overflow-wrap:anywhere]">{quote.header}</p>}
                  <p className={`${PROSE} text-muted-foreground`}>
                    <InertText text={tidyText(quote.text)} />
                  </p>
                </blockquote>
              ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <section className="flex flex-col gap-2" aria-label={t('text.label')}>
      <SectionLabel as="h3">{t('text.label')}</SectionLabel>
      {body}
    </section>
  )
}
