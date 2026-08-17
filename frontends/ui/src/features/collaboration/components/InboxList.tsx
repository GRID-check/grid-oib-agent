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
 *   - a small `role="status"` region carries the announcement — NOT the row
 *     container, which would read the whole list aloud on every filter change
 *     and every archive. It states the count of things needing attention (NF-3),
 *     and says nothing at all when that count is zero — "nothing needs you" is
 *     already on screen as the empty state and is not worth interrupting for;
 *     an arrival that leaves the count unchanged is likewise not announced,
 *     which is a known narrowing of NF-3 rather than the intent;
 *   - the filter is a single-select `ToggleGroup` (`role="radiogroup"`) rather
 *     than two unlabelled buttons;
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
import { Item, ItemContent, ItemList, ItemMedia } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AnimatePresence } from '@/components/motion'
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

  const {
    items,
    pending,
    loading,
    error,
    mutationError,
    dismissMutationError,
    mutating,
    refresh,
    markRead,
    markAllRead,
    archive,
  } = useInboxList(enabled, filter === 'needsMe')

  const hasUnread = items.some((item) => item.state === 'unread')

  const onOpen = (item: InboxItemView) => {
    if (item.state === 'unread') void markRead([item.id])
  }

  return (
    <div className={cn('space-y-4', className)}>
      {/* ---- Filter + bulk action ---- */}
      {/* `min-h-8` holds the toolbar's line even if the filter wraps, so a
          count arriving cannot lift the list. */}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filter}
          onValueChange={(value) => {
            // type=single can emit "" when the pressed item is clicked again;
            // the inbox always has a filter, so ignore a clear.
            if (value === 'needsMe' || value === 'all') setFilter(value)
          }}
          aria-label={t('inbox.filters.ariaLabel')}
        >
          {FILTERS.map((key) => (
            <ToggleGroupItem key={key} value={key}>
              {t(`inbox.filters.${key}`)}
              {key === 'needsMe' && (
                // Always mounted: appearing only when `pending > 0` grew the
                // "needs me" segment and shoved "All" sideways. Invisible at
                // zero keeps the slot; `aria-hidden` so the radio does not
                // read "Needs me 0".
                <CountPill
                  className={cn(pending === 0 && 'invisible')}
                  aria-hidden={pending === 0 || undefined}
                >
                  {pending}
                </CountPill>
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <Button
          variant="outline"
          size="sm"
          disabled={!hasUnread || mutating}
          onClick={() => void markAllRead()}
        >
          {t('inbox.markAllRead')}
        </Button>
      </div>

      {/* A refused action — most often a row a second tab already archived. It
          belongs beside the list, not instead of it: replacing the rows with
          "your inbox could not be loaded" made a working inbox look broken and
          stated something that had not happened. */}
      {mutationError && (
        <Alert
          variant="destructive"
          className="animate-in fade-in-0 duration-150 ease-out motion-reduce:animate-none"
        >
          <AlertCircle />
          <AlertTitle className="line-clamp-none">{t('inbox.errors.actionFailed')}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3 pt-1">
            <Button variant="outline" size="sm" onClick={dismissMutationError}>
              {t('sharing.errors.dismiss')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* ---- The list itself ----
          The live region is the small `role="status"` node below, NOT this
          container: announcing the container meant a screen reader read the whole
          inbox — every row, title, body, excerpt and timestamp — on the first
          skeleton→rows swap, on every filter change and after every archive. */}
      <div data-testid="inbox-list">
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
          <ItemList as="ul" data-testid="inbox-skeleton" aria-busy="true" className="bg-card shadow-xs">
            {Array.from({ length: 4 }).map((_, index) => (
              <Item as="li" key={index} className="items-start py-3.5">
                <ItemMedia>
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                </ItemMedia>
                <ItemContent className="flex flex-col gap-2">
                  <Skeleton className="h-3.5 w-3/5" />
                  <Skeleton className="h-2.5 w-1/3" />
                  <Skeleton className="h-2.5 w-20" />
                </ItemContent>
              </Item>
            ))}
          </ItemList>
        ) : items.length === 0 ? (
          <EmptyState
            icon={filter === 'needsMe' ? CheckCircle2 : InboxIcon}
            title={t(filter === 'needsMe' ? 'inbox.empty.needsMeTitle' : 'inbox.empty.allTitle')}
            description={t(
              filter === 'needsMe' ? 'inbox.empty.needsMeDescription' : 'inbox.empty.allDescription',
            )}
          />
        ) : (
          <ItemList as="ul" className="bg-card shadow-xs">
            {/* Archiving a row is the one action here, and it removes that row —
                so the list needs an exit, which CSS cannot give it, and `layout`
                so the rows below close the gap instead of jumping.

                No entrance stagger. The inbox is a work queue people open to
                triage, and a cascade makes the first glance slower every single
                time for a flourish that only reads once. Motion here is reserved
                for a change the user causes. */}
            <AnimatePresence initial={false} mode="popLayout">
              {items.map((item) => (
                <InboxItemRow
                  key={item.id}
                  item={item}
                  onOpen={onOpen}
                  onArchive={(id) => void archive(id)}
                />
              ))}
            </AnimatePresence>
          </ItemList>
        )}
      </div>

      {/* The whole announcement, in one always-mounted node: how many things need
          this person. A live region that is created at the same moment as its
          content is routinely dropped by screen readers, so it is mounted whether
          or not there is anything to say.

          Nothing to say is the literal case at zero: "0 items need your attention"
          is not news, and this region is re-read on every filter change and after
          every archive — so an empty queue interrupted the reader to tell them
          about nothing, over and over. */}
      <p className="sr-only" role="status" aria-live="polite">
        {loading || pending === 0
          ? ''
          : pending === 1
            ? t('inbox.badgeAriaOne')
            : t('inbox.badgeAria', { count: pending })}
      </p>
    </div>
  )
}
