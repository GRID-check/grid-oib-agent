'use client'

/**
 * A project's uploads, newest first (ticket „Verlauf/Protokoll", ADR-0085):
 * when, how many files, and how they ended, as pills. Every member who can
 * open the project reads it; only the uploader's own rows link to the summary,
 * because the summary is the uploader's (the endpoint answers 404 to anyone
 * else, and a link that 404s is worse than none).
 *
 * The reader's own rows say „Sie"; the others carry the uploader's name, which
 * the history endpoint resolves from the organization directory (most readers
 * may not read the project roster). Someone who has left the organization has
 * no name there, and their row carries none rather than an id.
 *
 * The list is read a page at a time; „Ältere Uploads laden" reads the next,
 * so every upload of the project can be reached.
 */

import type { JSX } from 'react'
import Link from 'next/link'
import { ArrowUpRight, History, Loader2 } from 'lucide-react'

import type { UploadHistoryEntry } from '@/adapters/api/upload-batches-client'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Item, ItemActions, ItemContent, ItemList, ItemTitle } from '@/components/ui/item'
import { Skeleton } from '@/components/ui/skeleton'
import { TimeAgo } from '@/components/ui/time-ago'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime } from '@/lib/format'
import { useProjectUploads } from '../hooks/use-project-uploads'
import { tallyHistoryEntry, visibleTally } from '../lib/upload-summary'
import { TallyPill, useTallyLabel } from './upload-atoms'

function UploadHistoryRow({ entry, own }: { entry: UploadHistoryEntry; own: boolean }): JSX.Element {
  const t = useTranslations('uploadBatches')
  const { locale } = useLocale()
  const tallyLabel = useTallyLabel()
  const pills = visibleTally(tallyHistoryEntry(entry))

  return (
    <Item as="li" className="flex-wrap items-start hover:bg-transparent" data-testid={`upload-history-row-${entry.id}`}>
      <ItemContent className="flex flex-col gap-2">
        <ItemTitle className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 font-normal">
          <TimeAgo date={entry.createdAt} locale={locale} className="text-foreground font-medium" />
          <span aria-hidden>·</span>
          <span>{t('history.files', { count: entry.expectedCount })}</span>
          {(own || entry.createdByName) && (
            <>
              <span aria-hidden>·</span>
              <span>{own ? t('history.you') : entry.createdByName}</span>
            </>
          )}
        </ItemTitle>
        <ul className="flex flex-wrap gap-1.5" aria-label={t('history.countsLabel')}>
          {pills.map(({ key, count }) => (
            <li key={key}>
              <TallyPill tally={key} count={count} label={tallyLabel(key)} />
            </li>
          ))}
        </ul>
      </ItemContent>
      {own && (
        <ItemActions>
          <Button asChild variant="ghost" size="sm">
            <Link
              href={`/app/uploads/${encodeURIComponent(entry.id)}`}
              aria-label={t('history.openLabel', { date: formatAbsoluteTime(entry.createdAt, locale) })}
              data-testid={`upload-history-open-${entry.id}`}
            >
              {t('history.open')}
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          </Button>
        </ItemActions>
      )}
    </Item>
  )
}

/** The list for uploads already loaded: the preview route and the specs render this. */
export function UploadHistoryList({
  uploads,
  currentUserId,
}: {
  uploads: UploadHistoryEntry[]
  currentUserId: string | null
}): JSX.Element {
  const t = useTranslations('uploadBatches')
  if (uploads.length === 0) {
    return (
      <EmptyState
        icon={History}
        size="sm"
        title={t('history.empty.title')}
        description={t('history.empty.description')}
        data-testid="upload-history-empty"
      />
    )
  }
  return (
    <ItemList as="ul" data-testid="upload-history">
      {uploads.map((entry) => (
        <UploadHistoryRow key={entry.id} entry={entry} own={currentUserId !== null && entry.createdBy === currentUserId} />
      ))}
    </ItemList>
  )
}

/** The project's upload history, loaded. */
export function UploadHistory({
  projectId,
  currentUserId,
}: {
  projectId: string
  currentUserId: string | null
}): JSX.Element {
  const t = useTranslations('uploadBatches')
  const tCommon = useTranslations('common')
  const { state, retry, loadMore } = useProjectUploads(projectId)

  if (state.status === 'loading') {
    return (
      <div className="space-y-2" aria-busy="true" data-testid="upload-history-loading">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-[4.5rem]" />
        ))}
      </div>
    )
  }
  if (state.status === 'error') {
    return (
      <Alert variant="destructive" data-testid="upload-history-error">
        <AlertDescription className="flex flex-col items-start gap-3">
          {t('history.error')}
          <Button variant="outline" size="sm" onClick={retry}>
            {tCommon('actions.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  const hasMore = state.nextCursor !== null
  return (
    <div className="space-y-3">
      {/* A first page whose uploads all went where the reader cannot look is not „no uploads yet". */}
      {(state.uploads.length > 0 || !hasMore) && (
        <UploadHistoryList uploads={state.uploads} currentUserId={currentUserId} />
      )}
      {hasMore && (
        <div className="flex flex-col items-start gap-2">
          {state.more === 'error' && (
            <p className="text-error text-sm" data-testid="upload-history-more-error">
              {t('history.moreError')}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={loadMore}
            disabled={state.more === 'loading'}
            aria-busy={state.more === 'loading'}
            data-testid="upload-history-more"
          >
            {state.more === 'loading' && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
            {t('history.more')}
          </Button>
        </div>
      )}
    </div>
  )
}
