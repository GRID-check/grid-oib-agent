'use client'

/**
 * The E-Mail-Eingang's list pane: the two lists („Wartet auf Ablage ·
 * Bearbeitet“, the second faceted into Abgelegt, Verworfen and Abgelaufen),
 * the rows in their sections (thread groups, the quiet group of unconfirmed
 * and automatic mail), and every state the list can be in, each with its own
 * words: loading, failed, never used (which teaches the address in place),
 * all done, nothing handled yet.
 */

import type { JSX, ReactNode } from 'react'
import { ChevronDown, CheckCircle2, History, Inbox as InboxGlyph, MailOpen, Repeat2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BusyButton } from '@/components/ui/busy-button'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadError } from '@/components/ui/load-error'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useTranslations } from '@/i18n'
import type { InboundMailListStatus, InboundMailOutcome, InboundMailSummaryView } from '@/lib/inbound-mail/inbound-mail-wire'
import { cn } from '@/lib/utils'
import type { ListSection } from '../lib/list-sections'
import { InboundMailRow } from './inbound-mail-row'

export type ListState = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; items: InboundMailSummaryView[]; nextCursor: string | null }

export interface InboundMailListProps {
  state: ListState
  sections: ListSection[]
  status: InboundMailListStatus
  outcome: InboundMailOutcome | null
  onFilterChange: (status: InboundMailListStatus, outcome: InboundMailOutcome | null) => void
  /** The waiting count beside the first filter; null while unknown. */
  waitingCount: number | null
  openId: string | null
  focusedId: string | null
  checked: ReadonlySet<string>
  onCheckedChange: (mailId: string, checked: boolean) => void
  onFocusRow: (mailId: string) => void
  hrefFor: (mailId: string) => string
  quietOpen: boolean
  onQuietOpenChange: (open: boolean) => void
  /** File a whole thread group as suggested. */
  onFileGroup: (threadId: string, mailIds: string[]) => void
  fileGroupBusy: string | null
  onRetry: () => void
  onLoadMore: () => void
  loadingMore: boolean
  /** Whether the project ever received mail; null while unknown. Decides „never used“ against „all done“. */
  everReceived: boolean | null
  /** The address, for the never-used state. */
  addressBlock: ReactNode
  /** The selection bar, pinned under the list while something is selected. */
  selectionBar: ReactNode
  /** The closed-project notice, above the rows. */
  notice: ReactNode
}

export function InboundMailList(props: InboundMailListProps): JSX.Element {
  const t = useTranslations('inboundMail')
  const { status, outcome, onFilterChange, waitingCount } = props

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="inbound-mail-list">
      <div className="flex flex-col gap-2 border-b px-3 py-3 sm:px-4">
        <ToggleGroup
          type="single"
          segmented
          size="sm"
          value={status}
          onValueChange={(value) => value && onFilterChange(value as InboundMailListStatus, null)}
          aria-label={t('filters.label')}
        >
          <ToggleGroupItem value="waiting" data-testid="filter-waiting" className="gap-1.5">
            {t('filters.waiting')}
            {waitingCount !== null && waitingCount > 0 && <CountPill count={waitingCount} tone="muted" />}
          </ToggleGroupItem>
          <ToggleGroupItem value="handled" data-testid="filter-handled">
            {t('filters.handled')}
          </ToggleGroupItem>
        </ToggleGroup>
        {status === 'handled' && (
          <ToggleGroup
            type="single"
            variant="inverted"
            size="sm"
            value={outcome ?? 'all'}
            onValueChange={(value) => value && onFilterChange('handled', value === 'all' ? null : (value as InboundMailOutcome))}
            aria-label={t('filters.outcome.label')}
            className="flex-wrap"
          >
            {(['all', 'filed', 'dismissed', 'expired'] as const).map((value) => (
              <ToggleGroupItem key={value} value={value} data-testid={`filter-outcome-${value}`}>
                {t(`filters.outcome.${value}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>
      {props.notice}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ListBody {...props} />
      </div>
      {props.selectionBar && <div className="border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">{props.selectionBar}</div>}
    </div>
  )
}

function ListBody({
  state,
  sections,
  status,
  openId,
  focusedId,
  checked,
  onCheckedChange,
  onFocusRow,
  hrefFor,
  quietOpen,
  onQuietOpenChange,
  onFileGroup,
  fileGroupBusy,
  onRetry,
  onLoadMore,
  loadingMore,
  everReceived,
  addressBlock,
  onFilterChange,
}: InboundMailListProps): JSX.Element {
  const t = useTranslations('inboundMail')
  if (state.kind === 'loading') {
    return (
      <ul className="divide-y" aria-busy="true" data-testid="inbound-mail-list-loading">
        {[0, 1, 2, 3, 4].map((row) => (
          <li key={row} className="flex items-start gap-3 px-4 py-3">
            <Skeleton className="size-7 rounded-full" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-3 w-2/5" />
            </div>
          </li>
        ))}
      </ul>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="p-4">
        <LoadError title={t('loadError')} onRetry={onRetry} />
      </div>
    )
  }
  if (state.items.length === 0) {
    if (status === 'handled') {
      return (
        <div className="p-4">
          <EmptyState icon={History} title={t('empty.handledTitle')} description={t('empty.handledText')} />
        </div>
      )
    }
    if (everReceived === false) {
      return (
        <div className="flex flex-col gap-4 p-4" data-testid="inbound-mail-never">
          <EmptyState variant="panel" icon={InboxGlyph} title={t('empty.neverTitle')} description={t('empty.neverText')} />
          {addressBlock}
        </div>
      )
    }
    return (
      <div className="p-4">
      <EmptyState
        icon={CheckCircle2}
        title={t('empty.doneTitle')}
        description={t('empty.doneText')}
        data-testid="inbound-mail-done"
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => onFilterChange('handled', null)}>
            <MailOpen className="size-4" aria-hidden />
            {t('empty.showHandled')}
          </Button>
        }
      />
      </div>
    )
  }

  const row = (mail: InboundMailSummaryView): JSX.Element => (
    <InboundMailRow
      key={mail.id}
      mail={mail}
      href={hrefFor(mail.id)}
      open={mail.id === openId}
      focused={mail.id === focusedId}
      checked={checked.has(mail.id)}
      selecting={checked.size > 0}
      onCheckedChange={(value) => onCheckedChange(mail.id, value)}
      onFocusRow={() => onFocusRow(mail.id)}
    />
  )

  return (
    <div className="flex flex-col">
      {sections.map((section) => {
        if (section.kind === 'mail') return <ul key={section.mail.id} className="border-b">{row(section.mail)}</ul>
        if (section.kind === 'thread') {
          return (
            <section key={section.threadId} className="bg-muted/20 border-b" aria-label={t('group.thread', { name: section.name, count: section.mails.length })} data-testid={`thread-group-${section.threadId}`}>
              <div className="flex flex-col gap-2 px-3 pt-3 sm:px-4">
                <p className="text-muted-foreground flex items-start gap-1.5 text-xs font-medium">
                  <Repeat2 className="mt-px size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{t('group.thread', { name: section.name, count: section.mails.length })}</span>
                </p>
                <BusyButton
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-auto min-h-8 w-full justify-start whitespace-normal py-1.5 text-left"
                  busy={fileGroupBusy === section.threadId}
                  busyLabel={t('bulk.fileSuggestedBusy')}
                  onClick={() => onFileGroup(section.threadId, section.mails.map((mail) => mail.id))}
                  data-testid="thread-group-file"
                >
                  {t('group.threadAction', { count: section.mails.length, name: section.name, version: section.finalVersion })}
                </BusyButton>
              </div>
              <ul className="divide-y">{section.mails.map(row)}</ul>
            </section>
          )
        }
        return (
          <section key="quiet" className="border-b" data-testid="quiet-group">
            <button
              type="button"
              className="text-muted-foreground hover:bg-accent/40 flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 sm:px-4 pointer-coarse:min-h-11"
              aria-expanded={quietOpen}
              onClick={() => onQuietOpenChange(!quietOpen)}
              data-testid="quiet-group-toggle"
            >
              <ChevronDown className={cn('size-3.5 transition-transform duration-quick motion-reduce:transition-none', !quietOpen && '-rotate-90')} aria-hidden />
              {t('group.quiet', { count: section.mails.length })}
            </button>
            {quietOpen && (
              <>
                <p className="text-muted-foreground px-3 pb-2 text-xs sm:px-4">{t('group.quietHint')}</p>
                <ul className="divide-y border-t">{section.mails.map(row)}</ul>
              </>
            )}
          </section>
        )
      })}
      {state.nextCursor && (
        <div className="flex justify-center p-3">
          <BusyButton type="button" variant="outline" size="sm" busy={loadingMore} busyLabel={t('loadMore')} onClick={onLoadMore}>
            {t('loadMore')}
          </BusyButton>
        </div>
      )}
    </div>
  )
}
