'use client'

/**
 * One section of the platform dashboard.
 *
 * Every admin surface previously hand-rolled its own chrome: its own skeleton,
 * its own "could not load" card, its own retry button, its own empty state —
 * all subtly different, and each one a place to forget the retry entirely.
 * This is that shape, once.
 *
 * The contract is deliberately narrow: give it a title, a description, an
 * optional action, and the state of your fetch. It decides what to render.
 * Nothing here knows anything about a specific domain.
 *
 * `loading` is the FIRST load: there is nothing to show yet, so the body is a
 * skeleton. A reload after a save or a filter change is `refreshing`: the
 * content the reader is looking at stays put, the body is marked busy and a
 * small spinner sits in the header. Swapping a loaded list for skeletons on
 * every mutation throws the reader's place (and focus) away.
 */

import type { JSX } from 'react'
import { type ReactNode } from 'react'
import { AlertTriangle, RefreshCw, type LucideIcon } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'

export interface SectionCardProps {
  /**
   * What the card holds. Optional: a page whose only card would repeat the
   * page title right under it leaves this out, and the header collapses to
   * whatever is left (description, action) or disappears.
   */
  title?: string
  description?: string
  /** Header-right controls (filters, a primary action). Hidden while loading. */
  action?: ReactNode
  /** Renders the error state with a retry button when true. */
  error?: boolean
  errorMessage?: string
  onRetry?: () => void
  /** First load: renders skeletons instead of children. */
  loading?: boolean
  /**
   * A reload of content that is already on screen. Children stay rendered,
   * the body is `aria-busy` and a spinner shows in the header. Ignored while
   * `loading` (there is nothing to keep yet).
   */
  refreshing?: boolean
  /** How many skeleton rows to show while loading. */
  skeletonRows?: number
  /** When true (and not loading/error), renders the empty state instead of children. */
  empty?: boolean
  emptyIcon?: LucideIcon
  emptyTitle?: string
  emptyDescription?: string
  /** Optional call to action under the empty state (e.g. "Add the first one"). */
  emptyAction?: ReactNode
  /** Forwarded to the Card so tests and the screenshot harness can target it. */
  testId?: string
  children?: ReactNode
}

export function SectionCard({
  title,
  description,
  action,
  error = false,
  errorMessage,
  onRetry,
  loading = false,
  refreshing = false,
  skeletonRows = 3,
  empty = false,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  emptyAction,
  testId,
  children,
}: SectionCardProps): JSX.Element {
  const t = useTranslations('platform')
  const busy = refreshing && !loading && !error
  const showAction = Boolean(action) && !loading && !error
  const hasHeader = Boolean(title || description || showAction || busy)

  const body = (): ReactNode => {
    // Error wins over loading: a retry leaves `loading` true for a moment, and
    // flipping back to a skeleton would hide the thing the user just clicked.
    if (error) {
      return (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle className="line-clamp-none">{errorMessage ?? t('loadError')}</AlertTitle>
          <AlertDescription>
            <p>{t('loadErrorHint')}</p>
            {onRetry ? (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={onRetry}
                disabled={loading}
              >
                <RefreshCw
                  className={cn('size-3.5', loading && 'animate-spin motion-reduce:animate-none')}
                  aria-hidden
                />
                {t('retry')}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      )
    }
    if (loading) {
      return (
        <div className="flex flex-col gap-2" data-testid="section-loading">
          {Array.from({ length: skeletonRows }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      )
    }
    if (empty) {
      return (
        <EmptyState
          variant="bare"
          icon={emptyIcon}
          title={emptyTitle ?? t('empty.title')}
          description={emptyDescription}
          action={emptyAction}
        />
      )
    }
    return children
  }

  const resolved = !error && !loading && !empty

  return (
    <Card data-testid={testId}>
      {hasHeader ? (
        <CardHeader>
          {title || busy ? (
            <CardTitle className="flex min-w-0 items-center gap-2">
              {title ? <span className="min-w-0 truncate">{title}</span> : null}
              {busy ? (
                <Spinner
                  size="xs"
                  label={t('refreshing')}
                  className="text-muted-foreground"
                  data-testid="section-refreshing"
                />
              ) : null}
            </CardTitle>
          ) : null}
          {description ? <CardDescription>{description}</CardDescription> : null}
          {showAction ? <CardAction>{action}</CardAction> : null}
        </CardHeader>
      ) : null}
      <CardContent
        aria-busy={busy || loading || undefined}
        className={cn(
          resolved && 'animate-in fade-in-0 duration-base ease-out motion-reduce:animate-none',
          busy && 'duration-base opacity-70 transition-opacity'
        )}
      >
        {body()}
      </CardContent>
    </Card>
  )
}
