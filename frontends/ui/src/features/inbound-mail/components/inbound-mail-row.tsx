'use client'

/**
 * One mail in the E-Mail-Eingang's list (`InboundMailRow`, DECISION §9).
 *
 * Connected, never a pill: the list owns the hairlines and the corners. A
 * leading checkbox for bulk work, visible on hover and focus and always under
 * a finger; then the sender's disc, the subject with its „AW:“/„WG:“ chain
 * stripped (the full subject is in the title), the time, and one muted line:
 * who, from which domain, how many attachments. While a mail waits, a third
 * line names the E-Mail-Verlauf it would continue (only one the reader may
 * read) and a glyph says when the sender is not confirmed. A handled mail says
 * what became of it and until when it can be restored.
 *
 * Metadata only: the list never carries a mail's text (D22).
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { Bot, Paperclip, Repeat2 } from 'lucide-react'
import { PersonAvatar } from '@/components/ui/avatar-stack'
import { Checkbox } from '@/components/ui/checkbox'
import { TimeAgo } from '@/components/ui/time-ago'
import { useLocale, useTranslations } from '@/i18n'
import type { InboundMailSummaryView } from '@/lib/inbound-mail/inbound-mail-wire'
import { formatCalendarDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import { displaySubject } from '../lib/subject'
import { SenderTrustGlyph } from './sender-trust'

export interface InboundMailRowProps {
  mail: InboundMailSummaryView
  href: string
  /** This mail is open in the detail. */
  open: boolean
  /** The keyboard's row (J/K). */
  focused: boolean
  /** Checked for a bulk action. */
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  /** The list is selecting: checkboxes stay visible on every row. */
  selecting: boolean
  onFocusRow?: () => void
}

export function InboundMailRow({ mail, href, open, focused, checked, onCheckedChange, selecting, onFocusRow }: InboundMailRowProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const { locale } = useLocale()
  const subject = displaySubject(mail.subject) ?? t('row.noSubject')
  const who = mail.senderName?.trim() || mail.senderDomain || '—'
  const waiting = mail.status === 'waiting'
  const outcomes = (['filed', 'dismissed', 'expired'] as const).filter((outcome) => mail.outcomes[outcome] > 0)
  // The text was appended by a follow when nothing of the text waits but its attachments do.
  const textFollowed = waiting && mail.outcomes.filed > 0 && mail.waitingParts === mail.attachments && mail.attachments > 0

  return (
    <li
      className={cn(
        'group/row relative flex items-start gap-3 px-3 py-3 transition-colors duration-snap ease-out motion-reduce:transition-none sm:px-4',
        'hover:bg-accent/40 pointer-coarse:min-h-11',
        // The open row lifts to the card surface and wears the ink bar: a tinted fill
        // took its muted lines under 4.5:1.
        open && 'bg-card hover:bg-card',
        focused && !open && 'bg-accent/40'
      )}
      data-mail-id={mail.id}
      data-testid={`inbound-mail-row-${mail.id}`}
      data-open={open || undefined}
      data-focused={focused || undefined}
    >
      {/* The open row and the keyboard's row are marked by a bar of ink on the leading edge, never by chroma. */}
      {(focused || open) && (
        <span aria-hidden className={cn('absolute inset-y-2 left-0 w-0.5 rounded-full', open ? 'bg-foreground' : 'bg-foreground/40')} />
      )}
      {/* Above the link's full-row press area, so a tap on the box selects instead of opening. */}
      <div className="relative z-10 flex h-8 items-center">
        <Checkbox
          checked={checked}
          onCheckedChange={(value) => onCheckedChange(value === true)}
          aria-label={t('row.select', { subject })}
          data-testid="inbound-mail-row-checkbox"
          className={cn(
            'transition-opacity duration-quick',
            !selecting && !checked && 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100'
          )}
        />
      </div>
      <Link
        href={href}
        onFocus={onFocusRow}
        aria-current={open ? 'page' : undefined}
        data-testid="inbound-mail-row-link"
        className="flex min-w-0 flex-1 items-start gap-3 rounded-sm outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring/60"
      >
        <PersonAvatar
          person={{ userId: mail.senderDomain ?? who, name: who }}
          size="sm"
          className="mt-0.5 shrink-0"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className={cn('min-w-0 flex-1 truncate text-sm', waiting ? 'text-foreground font-medium' : 'text-muted-foreground')} title={mail.subject ?? undefined}>
              {subject}
            </p>
            <TimeAgo date={mail.receivedAt} locale={locale} className="text-muted-foreground shrink-0 text-xs tabular-nums" />
          </div>
          <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
            {mail.automatic ? <Bot className="size-3.5 shrink-0" aria-label={t('row.automatic')} /> : <SenderTrustGlyph trust={mail.senderTrust} flags={mail.senderFlags} />}
            <span className="min-w-0 truncate">
              {who}
              {mail.senderDomain && mail.senderName && <span> · {mail.senderDomain}</span>}
            </span>
            {mail.attachments > 0 && (
              <span className="inline-flex shrink-0 items-center gap-1">
                <span aria-hidden>·</span>
                <Paperclip className="size-3" aria-hidden />
                {t('row.attachments', { count: mail.attachments })}
              </span>
            )}
          </p>
          {waiting && mail.thread && (
            <p
              className="text-muted-foreground min-w-0 truncate text-xs"
              data-testid="inbound-mail-row-thread"
              title={t('row.thread', { name: mail.thread.name, version: mail.thread.nextVersion })}
            >
              <span aria-hidden>→ </span>
              {t('row.thread', { name: mail.thread.name, version: mail.thread.nextVersion })}
            </p>
          )}
          {textFollowed && (
            <p className="text-muted-foreground flex items-center gap-1 text-xs">
              <Repeat2 className="size-3" aria-hidden />
              {t('row.textFollowed')}
            </p>
          )}
          {!waiting && outcomes.length > 0 && (
            <p className="text-muted-foreground text-xs" data-testid="inbound-mail-row-outcome">
              {outcomes.map((outcome) => t(`row.outcome.${outcome}`, { count: mail.outcomes[outcome] })).join(' · ')}
              {mail.restorableUntil && ` · ${t('row.restorableUntil', { date: formatCalendarDate(mail.restorableUntil, locale) })}`}
            </p>
          )}
        </div>
      </Link>
    </li>
  )
}
