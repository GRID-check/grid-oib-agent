'use client'

/**
 * The inbox list — the surface that answers "what needs me?" (spec IB-20).
 *
 * Owns exactly two things: the filter the user is looking through, and the
 * layout of the four states a list can be in (loading / error / empty / rows).
 * All data comes from `useInboxList`, which re-reads on live events, on focus and
 * on a slow poll while the live channel is down — so this component never has to
 * know whether an update arrived by push or by poll.
 *
 * Accessibility notes that are requirements, not polish:
 *   - the row container is `aria-live="polite"`, so a screen-reader user learns
 *     that something arrived without watching the badge (NF-3);
 *   - the filter is a `role="group"` of `aria-pressed` toggles rather than two
 *     unlabelled buttons;
 *   - the empty state differs per filter, because "nothing needs you" and "your
 *     inbox is empty" are different facts and collapsing them misleads.
 */

import { useState } from 'react'
import { AlertCircle, CheckCircle2, Inbox as InboxIcon } from 'lucide-react'

import { useTranslations } from '@/i18n'
import { useInboxList } from '../hooks/use-inbox'
import type { InboxItemView } from '@/lib/inbox/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { InboxItemRow } from './InboxItemRow'

type InboxFilter = 'needsMe' | 'all'

const FILTERS: readonly InboxFilter[] = ['needsMe', 'all']

export interface InboxListProps {
  /**
   * False for an organization without the collaboration flag: the hooks then open
   * no connection and issue no request at all (NF-8).
   */
  enabled?: boolean
  /**
   * Which filter the list opens on. Defaults to `needsMe` — the inbox exists to
   * answer "what needs me?" — but an entry point that means "show me everything
   * that happened" can seed the other one. Seed only: the user's clicks own it
   * from then on.
   */
  initialFilter?: InboxFilter
  className?: string
}

export function InboxList({
  enabled = true,
  initialFilter = 'needsMe',
  className,
}: InboxListProps): JSX.Element {
  const t = useTranslations('collaboration')
  const [filter, setFilter] = useState<InboxFilter>(initialFilter)

  const { items, pending, loading, error, refresh, markRead, markAllRead, archive } = useInboxList(
    enabled,
    filter === 'needsMe',
  )

  const hasUnread = items.some((item) => item.state === 'unread')

  const onOpen = (item: InboxItemView) => {
    if (item.state === 'unread') void markRead([item.id])
  }

  return (
    <div className={cn('space-y-4', className)}>
      {/* ---- Filter + bulk action ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-[7px]" role="group" aria-label={t('inbox.filters.ariaLabel')}>
          {FILTERS.map((key) => {
            const active = filter === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                aria-pressed={active}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md border-[0.5px] px-3 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
                  active
                    ? 'border-border bg-card font-medium text-foreground shadow-xs'
                    : 'border-transparent text-muted-foreground hover:bg-accent',
                )}
              >
                {t(`inbox.filters.${key}`)}
                {key === 'needsMe' && pending > 0 && <CountPill>{pending}</CountPill>}
              </button>
            )
          })}
        </div>

        <Button variant="outline" size="sm" disabled={!hasUnread} onClick={() => void markAllRead()}>
          {t('inbox.markAllRead')}
        </Button>
      </div>

      {/* ---- The list itself ----
          aria-live sits on the container so an item arriving on the live channel
          is announced; the states below swap inside it. */}
      <div aria-live="polite" data-testid="inbox-list">
        {error ? (
          <Alert variant="destructive">
            <AlertCircle />
            {/* line-clamp-none: the default title clamps to one line, which
                truncates this sentence at a phone width. */}
            <AlertTitle className="line-clamp-none">{t('inbox.errors.loadFailed')}</AlertTitle>
            <AlertDescription className="flex flex-col items-start gap-3 pt-1">
              <Button variant="outline" size="sm" onClick={() => refresh()}>
                {t('inbox.errors.tryAgain')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : loading ? (
          <div
            data-testid="inbox-skeleton"
            className="overflow-hidden rounded-lg border-[0.5px] border-border bg-card shadow-xs"
          >
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="flex items-start gap-3 border-b-[0.5px] border-border px-4 py-3.5 last:border-b-0 md:px-5"
              >
                <Skeleton className="size-8 shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-3.5 w-3/5" />
                  <Skeleton className="h-2.5 w-1/3" />
                  <Skeleton className="h-2.5 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={filter === 'needsMe' ? CheckCircle2 : InboxIcon}
            title={t(filter === 'needsMe' ? 'inbox.empty.needsMeTitle' : 'inbox.empty.allTitle')}
            description={t(
              filter === 'needsMe' ? 'inbox.empty.needsMeDescription' : 'inbox.empty.allDescription',
            )}
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border-[0.5px] border-border bg-card shadow-xs">
            {items.map((item) => (
              <InboxItemRow
                key={item.id}
                item={item}
                onOpen={onOpen}
                onArchive={(id) => void archive(id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
