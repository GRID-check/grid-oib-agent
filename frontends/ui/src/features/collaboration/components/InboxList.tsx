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
 *     than loose unlabelled buttons;
 *   - the empty state differs per filter, because "nothing needs you" and "your
 *     inbox is empty" are different facts and collapsing them misleads;
 *   - the list can be worked from the keyboard: j/k move between rows, Enter
 *     opens the row, e archives it, u toggles it read (the shortcuts sheet's
 *     „Postfach“ group). The keys are the list's own while focus is not in a
 *     field, so typing a reply never archives anything.
 *
 * The four filters are four questions: „Für mich“ is what waits on the reader
 * (an open request), „Ungelesen“ what they have not opened, „Alle“ everything,
 * and „Archiviert“ what they put away, which can come back from there.
 */

import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Archive, Bell, CheckCheck, CheckCircle2, MailOpen } from 'lucide-react'
import { toast } from 'sonner'

import { useTranslations } from '@/i18n'
import { useInboxList } from '../hooks/use-inbox'
import { ARCHIVE_UNDO_MS, useUndoableArchive } from '../hooks/use-undoable-archive'
import type { InboxItemView, InboxListFilter } from '@/lib/inbox/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { CountPill } from '@/components/ui/count-pill'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemContent, ItemList, ItemMedia } from '@/components/ui/item'
import { LoadMore } from '@/components/ui/load-more'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { AnimatePresence } from '@/components/motion'
import { cn } from '@/lib/utils'
import { NotificationPrompt } from '@/features/notifications/components/notification-prompt'
import { InboxItemRow } from './InboxItemRow'

type InboxFilter = 'needsMe' | 'unread' | 'all' | 'archived'

const FILTERS: readonly InboxFilter[] = ['needsMe', 'unread', 'all', 'archived']

/** Which slice of the API each filter reads. */
const API_FILTER: Record<InboxFilter, InboxListFilter> = {
  needsMe: 'requests',
  unread: 'unread',
  all: 'all',
  archived: 'archived',
}

const EMPTY_ICON = { needsMe: CheckCircle2, unread: MailOpen, all: Bell, archived: Archive } as const

function isInboxFilter(value: string): value is InboxFilter {
  return (FILTERS as readonly string[]).includes(value)
}

/** Whether a key press belongs to whatever has focus rather than to the list. */
function typingInto(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest('input, textarea, select, [role="textbox"], [role="menu"], [role="listbox"]')) return true
  return false
}

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
    counts,
    loading,
    error,
    mutationError,
    dismissMutationError,
    mutating,
    refresh,
    hasMore,
    loadingMore,
    loadMoreFailed,
    loadMore,
    markRead,
    markUnread,
    markAllRead,
    archive,
    unarchive,
  } = useInboxList(enabled, API_FILTER[filter])

  const archiveLater = useUndoableArchive(archive)
  // A row waiting out its undo window is already gone as far as the reader can
  // tell; the server hears about it when the window closes.
  const visibleItems = items.filter((item) => !archiveLater.pendingIds.has(item.id))
  const hasUnread = visibleItems.some((item) => item.state === 'unread')

  const onArchive = useCallback(
    (itemId: string): void => {
      archiveLater.request(itemId)
      toast(t('inbox.archived'), {
        duration: ARCHIVE_UNDO_MS,
        action: { label: t('inbox.undo'), onClick: () => archiveLater.undo(itemId) },
      })
    },
    [archiveLater, t],
  )

  const onUnarchive = useCallback(
    (itemId: string): void => {
      // Said once it is true: a refused restore shows the list's own error instead.
      void unarchive(itemId).then((restored) => {
        if (restored) toast(t('inbox.unarchived'))
      })
    },
    [unarchive, t],
  )

  const onOpen = useCallback(
    (item: InboxItemView) => {
      if (item.state === 'unread') void markRead([item.id])
    },
    [markRead],
  )

  // ---- Keyboard triage: j/k move, Enter opens, e archives, u toggles read ----
  const rootRef = useRef<HTMLDivElement>(null)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const focusedIndex = visibleItems.findIndex((item) => item.id === focusedId)

  const focusRow = useCallback((itemId: string) => {
    setFocusedId(itemId)
    const row = rootRef.current?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(itemId)}"]`)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView?.({ block: 'nearest' })
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const root = rootRef.current
      if (!root || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (typingInto(event.target)) return
      // The list's keys work wherever its page is: inside its sheet, or on the
      // page when nothing else holds the focus.
      const scope = root.closest('[role="dialog"]') ?? document.body
      if (event.target instanceof Node && event.target !== document.body && !scope.contains(event.target)) return
      const key = event.key
      if (key !== 'j' && key !== 'k' && key !== 'Enter' && key !== 'e' && key !== 'u') return
      if (visibleItems.length === 0) return
      const current = focusedIndex >= 0 ? visibleItems[focusedIndex] : null
      if (key === 'j' || key === 'k') {
        event.preventDefault()
        const next =
          focusedIndex < 0
            ? key === 'j'
              ? 0
              : visibleItems.length - 1
            : Math.min(visibleItems.length - 1, Math.max(0, focusedIndex + (key === 'j' ? 1 : -1)))
        focusRow(visibleItems[next].id)
        return
      }
      if (!current) return
      // Enter on a focused control (a row's button) is that control's.
      if (key === 'Enter' && event.target instanceof HTMLElement && event.target.closest('button, a')) return
      event.preventDefault()
      if (key === 'Enter') {
        root.querySelector<HTMLAnchorElement>(`[data-item-id="${CSS.escape(current.id)}"] [data-testid="inbox-item-link"]`)?.click()
        return
      }
      if (key === 'e') {
        if (current.archived) onUnarchive(current.id)
        else onArchive(current.id)
        // The keyboard stays on the list: the next row takes the focus the
        // archived one had, in the DOM as well as in the ring.
        const neighbour = visibleItems[focusedIndex + 1] ?? visibleItems[focusedIndex - 1]
        if (neighbour) focusRow(neighbour.id)
        else setFocusedId(null)
        return
      }
      if (current.state === 'unread') void markRead([current.id])
      else if (current.state === 'read') void markUnread([current.id])
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visibleItems, focusedIndex, focusRow, markRead, markUnread, onArchive, onUnarchive])

  // The count each filter wears: what waits on the reader, and what is unread.
  const filterCount = (key: InboxFilter): number => (key === 'needsMe' ? counts.requests : key === 'unread' ? counts.unread : 0)
  const emptyKey = filter

  return (
    <div ref={rootRef} className={cn('space-y-4', className)}>
      {/* ---- Filter + bulk action ---- */}
      {/* `min-h-8` holds the toolbar's line even if the filter wraps, so a
          count arriving cannot lift the list. */}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          type="single"
          // Segmented with a filled thumb: the outlined pair this was before
          // told the selected filter apart by a hairline, which dark mode lost.
          segmented
          variant="inverted"
          size="sm"
          value={filter}
          onValueChange={(value) => {
            // type=single can emit "" when the pressed item is clicked again;
            // the inbox always has a filter, so ignore a clear.
            if (isInboxFilter(value)) {
              setFilter(value)
              setFocusedId(null)
            }
          }}
          aria-label={t('inbox.filters.ariaLabel')}
        >
          {FILTERS.map((key) => {
            const count = filterCount(key)
            return (
              <ToggleGroupItem key={key} value={key}>
                {t(`inbox.filters.${key}`)}
                {/* Only when there is a number to say: an invisible pill kept
                    a blank tail after the label at zero. */}
                {count > 0 && <CountPill className={cn(filter === key && 'bg-background/20 text-current')}>{count}</CountPill>}
              </ToggleGroupItem>
            )
          })}
        </ToggleGroup>

        {/* Nothing to mark on an empty list, and nothing to read under
            „Archiviert“: the button would be a control with no job. */}
        {visibleItems.length > 0 && filter !== 'archived' && (
          <Button
            variant="outline"
            size="sm"
            disabled={!hasUnread || mutating}
            aria-label={t('inbox.markAllRead')}
            onClick={() => void markAllRead()}
          >
            <CheckCheck aria-hidden className="sm:hidden" />
            <span className="sm:hidden">{t('inbox.markAllReadShort')}</span>
            <span className="max-sm:hidden">{t('inbox.markAllRead')}</span>
          </Button>
        )}
      </div>

      {/* Offered once, never forced (ADR-0112): shown only where this browser can
          show notifications and has not been asked. */}
      <NotificationPrompt />

      {/* A refused action — most often a row a second tab already archived. It
          belongs beside the list, not instead of it: replacing the rows with
          "your inbox could not be loaded" made a working inbox look broken and
          stated something that had not happened. */}
      {mutationError && (
        <Alert
          variant="destructive"
          className="animate-in fade-in-0 duration-snap ease-out motion-reduce:animate-none"
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
        ) : visibleItems.length === 0 ? (
          <EmptyState
            icon={EMPTY_ICON[emptyKey]}
            title={t(`inbox.empty.${emptyKey}Title`)}
            description={t(`inbox.empty.${emptyKey}Description`)}
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
              {visibleItems.map((item) => (
                <InboxItemRow
                  key={item.id}
                  item={item}
                  focused={item.id === focusedId}
                  onOpen={onOpen}
                  onArchive={onArchive}
                  onUnarchive={onUnarchive}
                  onMarkRead={(itemId) => void markRead([itemId])}
                  onMarkUnread={(itemId) => void markUnread([itemId])}
                />
              ))}
            </AnimatePresence>
          </ItemList>
        )}
        {/* The list stopped at a page and used to say nothing about it. */}
        {!error && !loading && (
          <LoadMore
            hasMore={hasMore}
            loading={loadingMore}
            failed={loadMoreFailed}
            onLoadMore={loadMore}
            loadMoreLabel={t('inbox.loadMore')}
            loadingLabel={t('inbox.loadingMore')}
            failedLabel={t('inbox.loadMoreFailed')}
          />
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
